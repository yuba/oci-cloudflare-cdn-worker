// 接続確認（scripts/verify.mjs）をモックの Cloudflare API / OCI に対してテストする
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { verifyCloudflare, verifyOci } from "../scripts/verify.mjs";

const GOOD = "good-token";
let server, base;
// テストごとに差し替えるモックの状態
const state = { dnsRecords: [], attachedTo: null, ociCode: "ObjectNotFound", ociStatus: 404, ociFormat: "json" };

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // --- OCI ---
    if (url.pathname.startsWith("/oci/")) {
      if (state.ociFormat === "xml") {
        res.writeHead(state.ociStatus, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0"?><Error><Code>${state.ociCode}</Code></Error>`);
      }
      return json(state.ociStatus, { code: state.ociCode, message: "x" });
    }
    // --- Cloudflare ---
    const authed = req.headers.authorization === `Bearer ${GOOD}`;
    const fail = (status, code, message) => json(status, { success: false, errors: [{ code, message }] });
    const okr = (result) => json(200, { success: true, errors: [], result });
    if (url.pathname === "/cf/user/tokens/verify")
      return authed ? okr({ status: "active" }) : fail(401, 1000, "Invalid API Token");
    if (url.pathname.startsWith("/cf/accounts/") && url.pathname.endsWith("/tokens/verify"))
      return fail(401, 1000, "Invalid API Token");
    if (!authed) return fail(403, 10000, "Authentication error");
    if (url.pathname === "/cf/accounts/acc1/workers/scripts") return okr([{ id: "oci-cdn-proxy" }]);
    if (url.pathname.match(/^\/cf\/accounts\/[^/]+\/workers\/scripts$/)) return fail(403, 10000, "Authentication error");
    if (url.pathname === "/cf/zones")
      return okr(url.searchParams.get("name") === "example.com" ? [{ id: "z1", name: "example.com" }] : []);
    if (url.pathname === "/cf/accounts/acc1/workers/domains")
      return okr(state.attachedTo ? [{ hostname: url.searchParams.get("hostname"), service: state.attachedTo }] : []);
    if (url.pathname === "/cf/zones/z1/dns_records") return okr(state.dnsRecords);
    return fail(404, 7003, "No route");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.CLOUDFLARE_API_BASE_URL = `${base}/cf`;
});
after(() => server.close());

async function run(fn, ...args) {
  const out = { ok: [], ng: [], warn: [] };
  const log = console.log;
  console.log = () => {};
  try {
    await fn(...args, { ok: (m) => out.ok.push(m), ng: (m) => out.ng.push(m), warn: (m) => out.warn.push(m) });
  } finally {
    console.log = log;
  }
  return out;
}
const env = (o = {}) => ({ CLOUDFLARE_API_TOKEN: GOOD, CLOUDFLARE_ACCOUNT_ID: "acc1", ...o });

test("Cloudflare: すべて正常", async () => {
  state.dnsRecords = [];
  state.attachedTo = null;
  const r = await run(verifyCloudflare, env(), ["cdn.example.com"]);
  assert.deepEqual(r.ng, []);
  assert.equal(r.ok.length, 4);
  assert.match(r.ok[1], /既存 → 更新/);
});

test("Cloudflare: 無効なトークン", async () => {
  const r = await run(verifyCloudflare, env({ CLOUDFLARE_API_TOKEN: "bad" }), ["cdn.example.com"]);
  assert.match(r.ng[0], /CLOUDFLARE_API_TOKEN が無効/);
});

test("Cloudflare: 間違ったアカウント ID", async () => {
  const r = await run(verifyCloudflare, env({ CLOUDFLARE_ACCOUNT_ID: "other" }), ["cdn.example.com"]);
  assert.match(r.ng[0], /権限がトークンにありません/);
});

test("Cloudflare: ゾーンがない / DNS レコードが既にある / 別 Worker が使用中", async () => {
  let r = await run(verifyCloudflare, env(), ["cdn.example.net"]);
  assert.match(r.ng[0], /ゾーンが見つかりません/);
  state.dnsRecords = [{ type: "CNAME" }];
  r = await run(verifyCloudflare, env(), ["cdn.example.com"]);
  assert.match(r.ng[0], /既に DNS レコード（CNAME）/);
  state.dnsRecords = [];
  state.attachedTo = "someone-else";
  r = await run(verifyCloudflare, env(), ["cdn.example.com"]);
  assert.match(r.ng[0], /別の Worker "someone-else"/);
  state.attachedTo = null;
});

test("Cloudflare: CUSTOM_DOMAIN 未設定は警告", async () => {
  const r = await run(verifyCloudflare, env(), []);
  assert.deepEqual(r.ng, []);
  assert.match(r.warn[0], /workers\.dev/);
});

const parEnv = () => ({ OCI_PAR_URL: `${base}/oci/p/T/n/ns/b/bkt/o/` });
const s3Env = () => ({
  OCI_ACCESS_KEY_ID: "AK",
  OCI_SECRET_ACCESS_KEY: "SK",
  OCI_REGION: "ap-tokyo-1",
  OCI_NAMESPACE: "ns",
  OCI_BUCKET: "bkt",
  OCI_ENDPOINT: `${base}/oci`,
});

test("OCI: PAR 正常 (ObjectNotFound)", async () => {
  Object.assign(state, { ociStatus: 404, ociCode: "ObjectNotFound", ociFormat: "json" });
  const r = await run(verifyOci, parEnv());
  assert.deepEqual(r.ng, []);
  assert.match(r.ok[0], /正常/);
});

test("OCI: PAR 無効・期限切れ", async () => {
  Object.assign(state, { ociStatus: 404, ociCode: "NotAuthenticatedOrNotFound", ociFormat: "json" });
  let r = await run(verifyOci, parEnv());
  assert.match(r.ng[0], /有効期限/);
  Object.assign(state, { ociStatus: 401, ociCode: "NotAuthenticated" });
  r = await run(verifyOci, parEnv());
  assert.match(r.ng[0], /HTTP 401 NotAuthenticated/);
});

test("OCI: S3 正常 / 署名エラー / AccessDenied は警告", async () => {
  Object.assign(state, { ociStatus: 404, ociCode: "NoSuchKey", ociFormat: "xml" });
  let r = await run(verifyOci, s3Env());
  assert.deepEqual(r.ng, []);
  Object.assign(state, { ociStatus: 403, ociCode: "SignatureDoesNotMatch" });
  r = await run(verifyOci, s3Env());
  assert.match(r.ng[0], /SignatureDoesNotMatch/);
  Object.assign(state, { ociStatus: 403, ociCode: "AccessDenied" });
  r = await run(verifyOci, s3Env());
  assert.deepEqual(r.ng, []);
  assert.match(r.warn[0], /AccessDenied/);
});

test("OCI: 接続できない", async () => {
  // 空きポートを確保してすぐ閉じる → 接続拒否になる
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, "127.0.0.1", r));
  const port = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const r = await run(verifyOci, { OCI_PAR_URL: `http://127.0.0.1:${port}/p/T/n/ns/b/bkt/o/` });
  assert.match(r.ng[0], /接続できません（ECONNREFUSED/);
});
