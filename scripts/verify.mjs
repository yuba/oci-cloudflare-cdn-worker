/**
 * デプロイ前の接続確認。
 *  - Cloudflare: API トークン / アカウント / カスタムドメインのゾーンと DNS
 *  - OCI: 存在しないオブジェクトを 1 回取得し、エラーの種類で認証情報の正否を判定
 *
 * 失敗（デプロイしても動かないもの）は errors、判定できないものは warnings に積む。
 */
import { randomUUID } from "node:crypto";


export async function verify(e, { domains }) {
  const errors = [];
  const warnings = [];
  const ok = (m) => console.log(`  ✔ ${m}`);
  const ng = (m) => (errors.push(m), console.log(`  ✖ ${m}`));
  const warn = (m) => (warnings.push(m), console.log(`  ⚠ ${m}`));

  console.log("接続確認: Cloudflare");
  await verifyCloudflare(e, domains, { ok, ng, warn });
  console.log("接続確認: OCI Object Storage");
  await verifyOci(e, { ok, ng, warn });

  return { errors, warnings };
}

// ---------------------------------------------------------------------------

async function cf(path, token) {
  let res;
  try {
    // CLOUDFLARE_API_BASE_URL は wrangler と同じ上書き用の変数（テスト用）
    const base = process.env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4";
    res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    return { status: 0, success: false, errors: [{ message: describeFetchError(err) }] };
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
}

const cfMsg = (r) => (r.errors || []).map((x) => (x.code ? `${x.code}: ${x.message}` : x.message)).join(" / ") || `HTTP ${r.status}`;

export async function verifyCloudflare(e, domains, { ok, ng, warn }) {
  const token = e.CLOUDFLARE_API_TOKEN;
  const account = e.CLOUDFLARE_ACCOUNT_ID;

  // 1. トークン（ユーザー・トークンとアカウント・トークンの両方を試す）
  let r = await cf("/user/tokens/verify", token);
  if (!r.success && account) {
    const r2 = await cf(`/accounts/${account}/tokens/verify`, token);
    if (r2.success) r = r2;
  }
  if (r.status === 0) return ng(`Cloudflare API に接続できません（${cfMsg(r)}）`);
  if (!r.success) return ng(`CLOUDFLARE_API_TOKEN が無効です（${cfMsg(r)}）`);
  if (r.result?.status && r.result.status !== "active") return ng(`API トークンの状態が ${r.result.status} です`);
  ok(`API トークンは有効${r.result?.expires_on ? `（有効期限 ${r.result.expires_on}）` : ""}`);

  // 2. アカウントと Workers の権限（デプロイに必要な Workers Scripts 権限で確認）
  r = await cf(`/accounts/${account}/workers/scripts`, token);
  if (!r.success) {
    return ng(
      r.status === 403 || r.status === 401
        ? `アカウント ${account} の Workers を操作する権限がトークンにありません（${cfMsg(r)}）`
        : `CLOUDFLARE_ACCOUNT_ID が正しくない可能性があります（${cfMsg(r)}）`,
    );
  }
  const name = e.WORKER_NAME || "oci-cdn-proxy";
  const exists = (r.result || []).some((s) => s.id === name);
  ok(`アカウントの Workers にアクセス可能（Worker "${name}" は${exists ? "既存 → 更新" : "新規作成"}）`);

  // 3. カスタムドメイン
  if (domains.length === 0) {
    warn("CUSTOM_DOMAIN が未設定です。workers.dev では Cache API が効かず、すべて OCI に転送されます");
    return;
  }
  for (const host of domains) {
    const zone = await findZone(host, account, token);
    if (zone.error) {
      ng(`${host}: ${zone.error}`);
      continue;
    }
    if (!zone.id) {
      ng(`${host}: このアカウントに対応するゾーンが見つかりません（Cloudflare にドメインを追加済みか、トークンの Zone Resources にそのゾーンが含まれているか確認してください）`);
      continue;
    }
    ok(`${host}: ゾーン ${zone.name} が見つかりました`);

    // 既に別の Worker にアタッチされていないか
    const d = await cf(`/accounts/${account}/workers/domains?hostname=${encodeURIComponent(host)}`, token);
    const attached = d.success ? (d.result || []).find((x) => x.hostname === host) : null;
    if (attached && attached.service !== name) {
      ng(`${host}: 既に別の Worker "${attached.service}" のカスタムドメインになっています`);
      continue;
    }
    if (attached) {
      ok(`${host}: この Worker のカスタムドメインとして設定済み`);
      continue;
    }

    // 外部管理の DNS レコードがあるとカスタムドメインを作れない
    const dns = await cf(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`, token);
    if (!dns.success) {
      warn(`${host}: DNS レコードを確認できませんでした（トークンに DNS 読取り権限がないため。既存レコードがあるとデプロイに失敗します）`);
    } else if ((dns.result || []).length > 0) {
      const types = dns.result.map((x) => x.type).join(", ");
      ng(`${host}: 既に DNS レコード（${types}）があります。Worker のカスタムドメインは DNS レコードを自動作成するので、先に削除してください`);
    } else {
      ok(`${host}: DNS レコードは未作成（デプロイ時に自動作成されます）`);
    }
  }
}

/** ホスト名の末尾から順にゾーンを探す（a.b.example.com → b.example.com → example.com） */
async function findZone(host, account, token) {
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const cand = labels.slice(i).join(".");
    const r = await cf(`/zones?name=${encodeURIComponent(cand)}&account.id=${account}`, token);
    if (!r.success) {
      if (r.status === 403 || r.status === 401)
        return { error: `ゾーンを参照する権限がトークンにありません（${cfMsg(r)}）。Zone Resources にゾーンを含めてください` };
      return { error: `ゾーンの検索に失敗しました（${cfMsg(r)}）` };
    }
    if (r.result?.length) return { id: r.result[0].id, name: r.result[0].name };
  }
  return {};
}

// ---------------------------------------------------------------------------

export async function verifyOci(e, { ok, ng, warn }) {
  const { loadConfig, fetchOrigin } = await import("../src/index.js");
  let cfg;
  try {
    cfg = loadConfig(e);
  } catch (err) {
    return ng(err.message);
  }
  const label = { par: "事前認証済リクエスト", s3: "S3 互換 API", public: "パブリック・バケット" }[cfg.mode];

  // 存在しないはずのオブジェクトを取得する（OCI の API リクエストを 1 回消費）
  const key = `${cfg.pathPrefix}.oci-cdn-proxy-check/${randomUUID()}`;
  let res;
  try {
    res = await fetchOrigin(key, cfg, "GET");
  } catch (err) {
    return ng(`${label}: オリジンに接続できません（${describeFetchError(err)}）`);
  }
  const body = await res.text().catch(() => "");
  const code = errorCode(body);
  const detail = `HTTP ${res.status}${code ? ` ${code}` : ""}`;

  if (res.ok) {
    return warn(`${label}: 存在しないはずのオブジェクトに ${res.status} が返りました。エンドポイントが OCI か確認してください`);
  }
  if (res.status === 404 && (code === "ObjectNotFound" || code === "NoSuchKey")) {
    return ok(`${label}: 認証・バケットとも正常（存在しないオブジェクトに ${detail}）`);
  }

  // 失敗の分類
  const hints = {
    par: "PAR の URL が正しいか、有効期限が切れていないか、アクセス・タイプが「オブジェクトの読取り」を含むか確認してください",
    s3: "アクセスキー / シークレット、OCI_REGION、OCI_NAMESPACE、OCI_BUCKET を確認してください",
    public: "バケットの可視性が「パブリック」か、OCI_REGION / OCI_NAMESPACE / OCI_BUCKET が正しいか確認してください",
  };
  if (cfg.mode === "s3" && res.status === 403 && code === "AccessDenied") {
    // キーは正しいがバケットのリスト権限がない場合も AccessDenied になる
    return warn(
      `${label}: AccessDenied（キーが無効か、読取り権限がないか、BUCKET_INSPECT 権限がないため 404 の代わりに 403 になっている可能性があります）。既存オブジェクトを実際に取得して確認してください`,
    );
  }
  ng(`${label}: オリジンが ${detail} を返しました。${hints[cfg.mode]}`);
}

/** OCI ネイティブ API（JSON）と S3 互換 API（XML）のエラーコードを取り出す */
function errorCode(body) {
  try {
    const j = JSON.parse(body);
    if (j && j.code) return String(j.code);
  } catch {}
  const m = body.match(/<Code>([^<]+)<\/Code>/);
  return m ? m[1] : "";
}

function describeFetchError(err) {
  const c = err?.cause;
  if (c?.code) return `${c.code}${c.hostname ? ` ${c.hostname}` : ""}`;
  return c?.message || err?.message || String(err);
}
