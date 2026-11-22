// ローカルのモック・オリジン（OCI PAR の代わり）に対して Worker を起動して挙動を確認する
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { unstable_dev } from "wrangler";

const objects = {
  "img/a.png": Buffer.from("0123456789abcdefghij"),
  "dir/index.html": Buffer.from("<h1>index</h1>"),
  "日本語 ファイル.txt": Buffer.from("hello"),
};
const hits = [];
let origin, worker;

before(async () => {
  // 前回実行時のキャッシュが残らないようにローカル状態を消す
  rmSync(".wrangler/state", { recursive: true, force: true });
  origin = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} host=${req.headers.host} range=${req.headers.range || "-"}`);
    const m = req.url.match(/^\/p\/TOKEN\/n\/ns\/b\/bkt\/o\/(.+)$/);
    const key = m && decodeURIComponent(m[1]);
    const body = key && objects[key];
    if (!body) {
      res.writeHead(404, { "content-type": "application/json", "opc-request-id": "x" });
      return res.end('{"code":"ObjectNotFound"}');
    }
    res.writeHead(200, {
      "content-type": key.endsWith(".png") ? "image/png" : "text/plain",
      "content-length": body.length,
      etag: '"abc"',
      "accept-ranges": "bytes",
      "opc-request-id": "secret-ish",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const port = origin.address().port;
  worker = await unstable_dev("src/index.js", {
    vars: {
      OCI_PAR_URL: `http://127.0.0.1:${port}/p/TOKEN/n/ns/b/bkt/o/`,
      INDEX_DOCUMENT: "index.html",
      CORS_ALLOW_ORIGIN: "*",
    },
    compatibilityDate: "2026-11-01",
    experimental: { disableExperimentalWarning: true },
    logLevel: "error",
  });
});

after(async () => {
  await worker?.stop();
  origin?.close();
});

const count = (s) => hits.filter((h) => h.includes(s)).length;

test("MISS → HIT、オリジンには1回だけ", async () => {
  let r = await worker.fetch("/img/a.png?x=1");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "0123456789abcdefghij");
  assert.equal(r.headers.get("x-cache"), "MISS");
  assert.equal(r.headers.get("opc-request-id"), null);
  assert.equal(r.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  await new Promise((s) => setTimeout(s, 300));
  r = await worker.fetch("/img/a.png?x=2");
  assert.equal(r.headers.get("x-cache"), "HIT");
  assert.equal(await r.text(), "0123456789abcdefghij");
  assert.equal(count("img/a.png"), 1);
});

test("Range はキャッシュから 206", async () => {
  const r = await worker.fetch("/img/a.png", { headers: { range: "bytes=2-5" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "2345");
  assert.equal(count("img/a.png"), 1);
});

test("Range のキャッシュミスも全体を取得してから 206", async () => {
  const r = await worker.fetch("/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.txt", {
    headers: { range: "bytes=1-2" },
  });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "el");
  assert.ok(hits.some((h) => h.includes("range=-") && h.includes("%E6%97%A5")));
});

test("If-None-Match で 304", async () => {
  const r = await worker.fetch("/img/a.png", { headers: { "if-none-match": '"abc"' } });
  assert.equal(r.status, 304);
});

test("HEAD はボディなし", async () => {
  const r = await worker.fetch("/img/a.png", { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "");
});

test("インデックス・ドキュメント", async () => {
  const r = await worker.fetch("/dir/");
  assert.equal(await r.text(), "<h1>index</h1>");
});

test("404 はネガティブキャッシュされる", async () => {
  let r = await worker.fetch("/nope.png");
  assert.equal(r.status, 404);
  assert.equal(await r.text(), "Not Found");
  await new Promise((s) => setTimeout(s, 300));
  r = await worker.fetch("/nope.png");
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("x-cache"), "HIT");
  await r.text();
  assert.equal(count("nope.png"), 1);
});

test("GET/HEAD 以外は 405、.. は 404", async () => {
  let r = await worker.fetch("/img/a.png", { method: "POST", body: "x" });
  assert.equal(r.status, 405);
  await r.text();
  r = await worker.fetch("/img/%2E%2E/a.png");
  assert.equal(r.status, 404);
  await r.text();
});

test("期間指定のパース", async () => {
  const { duration } = await import("../src/index.js");
  assert.equal(duration("30d", 1), 2592000);
  assert.equal(duration("5m", 1), 300);
  assert.equal(duration("1h30m", 1), 5400);
  assert.equal(duration("2w", 1), 1209600);
  assert.equal(duration("600", 1), 600);
  assert.equal(duration("0", 1), 0);
  assert.equal(duration(undefined, 7), 7);
  assert.equal(duration("abc", 7), 7);
});
