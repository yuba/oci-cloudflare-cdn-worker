#!/usr/bin/env node
/**
 * .env を読み込み、Cloudflare に Worker・カスタムドメイン・秘密情報を一括デプロイする。
 *
 *   npm run deploy            # デプロイ
 *   npm run deploy -- --dry-run  # アップロードせずにビルドと設定生成だけ確認
 *   npm run destroy           # Worker を削除
 */
import { existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const args = process.argv.slice(2);
const destroy = args.includes("--destroy");
const dryRun = args.includes("--dry-run");
const envFile = (args.find((a) => a.startsWith("--env-file=")) || "--env-file=.env").split("=")[1];

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

if (!existsSync(envFile)) die(`${envFile} がありません。 cp .env.example .env して値を埋めてください。`);
process.loadEnvFile(envFile);
const e = process.env;

// --- 依存関係（初回のみ自動インストール） ---
const wranglerBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
if (!existsSync(wranglerBin)) {
  console.log("→ npm install");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) die("npm install に失敗しました");
}
const wrangler = (wargs, opts = {}) => {
  const r = spawnSync(wranglerBin, wargs, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  return r.status ?? 1;
};

// --- 検証 ---
if (!dryRun) {
  if (!e.CLOUDFLARE_API_TOKEN) die("CLOUDFLARE_API_TOKEN が未設定です");
  if (!e.CLOUDFLARE_ACCOUNT_ID) die("CLOUDFLARE_ACCOUNT_ID が未設定です");
}
const name = e.WORKER_NAME || "oci-cdn-proxy";

if (destroy) {
  process.exit(wrangler(["delete", "--name", name, "--force"]));
}

let mode;
if (e.OCI_PAR_URL) {
  mode = "par";
  if (!/^https:\/\/.+\/p\/.+\/n\/.+\/b\/.+\/o\/?$/.test(e.OCI_PAR_URL))
    die("OCI_PAR_URL はバケット単位の PAR URL（…/p/<token>/n/<namespace>/b/<bucket>/o/）を指定してください");
} else if (e.OCI_ACCESS_KEY_ID || e.OCI_SECRET_ACCESS_KEY) {
  mode = "s3";
  for (const k of ["OCI_ACCESS_KEY_ID", "OCI_SECRET_ACCESS_KEY", "OCI_REGION", "OCI_NAMESPACE", "OCI_BUCKET"])
    if (!e[k]) die(`s3 モードには ${k} が必要です`);
} else {
  mode = "public";
  for (const k of ["OCI_REGION", "OCI_NAMESPACE", "OCI_BUCKET"])
    if (!e[k]) die(`OCI_PAR_URL か S3 互換キーを設定してください（public モードなら ${k} が必要）`);
}

// --- 秘密情報（暗号化して保存）と通常の変数を振り分け ---
const SECRET_KEYS = ["OCI_PAR_URL", "OCI_ACCESS_KEY_ID", "OCI_SECRET_ACCESS_KEY"];
const VAR_KEYS = [
  "OCI_REGION",
  "OCI_NAMESPACE",
  "OCI_BUCKET",
  "OCI_ENDPOINT",
  "PATH_PREFIX",
  "INDEX_DOCUMENT",
  "EDGE_CACHE_TTL",
  "BROWSER_CACHE_TTL",
  "NEGATIVE_CACHE_TTL",
  "MAX_CACHE_SIZE_MB",
  "CACHE_KEY_INCLUDE_QUERY",
  "CORS_ALLOW_ORIGIN",
];

const secrets = {};
for (const k of SECRET_KEYS) {
  // 使わないモードの秘密情報は null で削除（モード切替時に古い値が残らないように）
  secrets[k] = e[k] ? e[k] : null;
}
const vars = {};
for (const k of VAR_KEYS) if (e[k]) vars[k] = e[k];

const domains = (e.CUSTOM_DOMAIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name,
  main: "src/index.js",
  compatibility_date: "2026-11-01",
  workers_dev: domains.length === 0 || /^(1|true|yes)$/i.test(e.ENABLE_WORKERS_DEV || ""),
  preview_urls: false,
  observability: { enabled: true },
  vars,
  routes: domains.map((pattern) => ({ pattern, custom_domain: true })),
};

const generated = join(root, "wrangler.generated.json");
writeFileSync(generated, JSON.stringify(config, null, 2) + "\n");

console.log(`\n  Worker      : ${name}`);
console.log(`  オリジン    : ${mode}`);
console.log(`  ドメイン    : ${domains.join(", ") || "(なし: workers.dev のみ — Cache API が効かないので非推奨)"}`);
console.log(`  変数        : ${Object.keys(vars).join(", ") || "(なし)"}`);
console.log(`  秘密情報    : ${SECRET_KEYS.filter((k) => secrets[k]).join(", ") || "(なし)"}\n`);

// --- デプロイ ---
const tmp = mkdtempSync(join(tmpdir(), "oci-cdn-"));
const secretsFile = join(tmp, "secrets.json");
const setSecrets = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== null));
writeFileSync(secretsFile, JSON.stringify(setSecrets), { mode: 0o600 });

let status;
try {
  const deployArgs = ["deploy", "-c", generated, "--secrets-file", secretsFile];
  if (dryRun) deployArgs.push("--dry-run", "--outdir", join(tmp, "dist"));
  status = wrangler(deployArgs);

  // 使わなくなった秘密情報を削除
  const stale = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v === null));
  if (status === 0 && !dryRun && Object.keys(stale).length) {
    const staleFile = join(tmp, "stale.json");
    writeFileSync(staleFile, JSON.stringify(stale), { mode: 0o600 });
    // 存在しない秘密情報の削除はエラーになっても無害なので出力を抑える
    wrangler(["secret", "bulk", staleFile, "-c", generated], { stdio: "ignore" });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (status !== 0) die("デプロイに失敗しました");
if (dryRun) console.log("\n✔ dry-run 完了（wrangler.generated.json を確認してください）");
else console.log(`\n✔ デプロイ完了${domains.length ? `: https://${domains[0]}/` : ""}`);
