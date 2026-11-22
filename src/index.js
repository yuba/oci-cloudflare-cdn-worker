/**
 * OCI Object Storage を Cloudflare CDN の背後に置くための Worker。
 *
 * - オリジンへのアクセスはこの Worker が代行する（Host ヘッダは fetch が自動的に正しい値になる）
 * - レスポンスは Cache API でエッジにキャッシュし、OCI への API リクエスト数を最小化する
 * - オリジンへの接続方式は 3 種類（環境変数で自動判定）
 *     par    : 事前認証済リクエスト(PAR)の URL を秘密情報として持つ（推奨）
 *     s3     : S3 互換 API + 顧客秘密キーで SigV4 署名
 *     public : パブリック・バケットを直接参照
 */
import { AwsClient } from "aws4fetch";

// オリジンのレスポンスヘッダのうち、クライアントへ返すもの
const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-disposition",
  "etag",
  "last-modified",
  "accept-ranges",
];

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return text(502, "Bad Gateway");
    }
  },
};

async function handle(request, env, ctx) {
  const cfg = loadConfig(env);

  if (request.method === "OPTIONS" && cfg.corsOrigin) {
    return new Response(null, { status: 204, headers: corsHeaders(cfg, request) });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(405, "Method Not Allowed", { allow: "GET, HEAD" });
  }

  const url = new URL(request.url);
  const key = objectKey(url.pathname, cfg);
  if (key === null) return finalize(text(404, "Not Found"), cfg, request);

  // キャッシュキー: 既定ではクエリ文字列を無視する（ランダムなクエリでキャッシュを
  // 素通りさせ、OCI のリクエスト枠を食い潰す攻撃を防ぐため）
  const cacheUrl = new URL(url.origin);
  cacheUrl.pathname = url.pathname;
  if (cfg.cacheIncludeQuery) cacheUrl.search = url.search;
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

  // クライアントの Range / 条件付きヘッダはそのまま cache.match に渡す。
  // Cache API は 206 / 304 を自前で返してくれる。
  const matchHeaders = new Headers();
  for (const h of ["range", "if-none-match", "if-modified-since", "if-match", "if-unmodified-since"]) {
    const v = request.headers.get(h);
    if (v) matchHeaders.set(h, v);
  }
  const matchReq = new Request(cacheKey.url, { method: "GET", headers: matchHeaders });

  const cache = caches.default;
  let res = await cache.match(matchReq);
  if (res) return finalize(res, cfg, request, "HIT");

  // ---- キャッシュミス: オリジンから「全体」を取得してキャッシュする ----
  const range = request.headers.get("range");
  let origin = await fetchOrigin(key, cfg, "GET");

  const len = Number(origin.headers.get("content-length") || "NaN");
  const tooLarge = Number.isFinite(len) && len > cfg.maxCacheBytes;

  if (origin.ok && origin.status === 200 && !tooLarge) {
    const stored = toCacheable(origin, cfg.edgeTtl);
    if (range) {
      // Range 付きの場合は全体をキャッシュに格納してから、キャッシュに Range を処理させる
      await cache.put(cacheKey, stored);
      res = await cache.match(matchReq);
      if (res) return finalize(res, cfg, request, "MISS");
      // 万一取り出せなかった場合はオリジンに Range で取りに行く
      res = await fetchOrigin(key, cfg, "GET", range);
      return finalize(clean(res), cfg, request, "BYPASS");
    }
    ctx.waitUntil(cache.put(cacheKey, stored.clone()));
    return finalize(stored, cfg, request, "MISS");
  }

  if (origin.ok && tooLarge) {
    // 大きすぎてキャッシュできないものは素通し（Range はオリジンに任せる）
    if (range) {
      origin.body && origin.body.cancel();
      origin = await fetchOrigin(key, cfg, "GET", range);
    }
    return finalize(clean(origin), cfg, request, "BYPASS");
  }

  // 404 等はネガティブキャッシュ（存在しないパスの総当たりで OCI 枠を消費されないように）
  if (origin.status === 404 && cfg.negativeTtl > 0) {
    origin.body && origin.body.cancel();
    const nf = new Response("Not Found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": `public, max-age=${cfg.negativeTtl}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, nf.clone()));
    return finalize(nf, cfg, request, "MISS", cfg.negativeTtl);
  }

  console.warn(`origin returned ${origin.status} for ${key}`);
  origin.body && origin.body.cancel();
  return finalize(text(502, "Bad Gateway"), cfg, request);
}

// ---------------------------------------------------------------------------

function loadConfig(env) {
  const int = (v, d) => {
    const n = parseInt(v ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v)));

  let mode;
  if (env.OCI_PAR_URL) mode = "par";
  else if (env.OCI_ACCESS_KEY_ID && env.OCI_SECRET_ACCESS_KEY) mode = "s3";
  else if (env.OCI_NAMESPACE && env.OCI_BUCKET && env.OCI_REGION) mode = "public";
  else throw new Error("OCI origin is not configured (set OCI_PAR_URL or OCI_ACCESS_KEY_ID/OCI_SECRET_ACCESS_KEY)");

  return {
    mode,
    env,
    pathPrefix: (env.PATH_PREFIX || "").replace(/^\/+/, ""),
    indexDocument: env.INDEX_DOCUMENT || "",
    edgeTtl: int(env.EDGE_CACHE_TTL, 2592000), // 30 日
    browserTtl: int(env.BROWSER_CACHE_TTL, 3600), // 1 時間
    negativeTtl: int(env.NEGATIVE_CACHE_TTL, 300), // 5 分
    maxCacheBytes: int(env.MAX_CACHE_SIZE_MB, 512) * 1024 * 1024,
    cacheIncludeQuery: bool(env.CACHE_KEY_INCLUDE_QUERY, false),
    corsOrigin: env.CORS_ALLOW_ORIGIN || "",
  };
}

/** リクエストパス -> オブジェクト名。各セグメントを正規化して再エンコードする */
function objectKey(pathname, cfg) {
  let segs;
  try {
    segs = pathname.split("/").slice(1).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segs.some((s) => s === "." || s === "..")) return null;
  let key = segs.join("/");
  if (key === "" || key.endsWith("/")) {
    if (!cfg.indexDocument) return null;
    key += cfg.indexDocument;
  }
  return cfg.pathPrefix + key;
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function fetchOrigin(key, cfg, method, range) {
  const headers = new Headers();
  if (range) headers.set("range", range);
  const { env } = cfg;

  if (cfg.mode === "par") {
    const base = env.OCI_PAR_URL.endsWith("/") ? env.OCI_PAR_URL : env.OCI_PAR_URL + "/";
    return fetch(base + encodeKey(key), { method, headers });
  }

  if (cfg.mode === "public") {
    const host = env.OCI_ENDPOINT || `https://objectstorage.${env.OCI_REGION}.oraclecloud.com`;
    const url = `${host}/n/${encodeURIComponent(env.OCI_NAMESPACE)}/b/${encodeURIComponent(env.OCI_BUCKET)}/o/${encodeKey(key)}`;
    return fetch(url, { method, headers });
  }

  // s3 互換 API（パス形式）
  const host =
    env.OCI_ENDPOINT || `https://${env.OCI_NAMESPACE}.compat.objectstorage.${env.OCI_REGION}.oraclecloud.com`;
  const aws = new AwsClient({
    accessKeyId: env.OCI_ACCESS_KEY_ID,
    secretAccessKey: env.OCI_SECRET_ACCESS_KEY,
    service: "s3",
    region: env.OCI_REGION,
  });
  const url = `${host}/${encodeURIComponent(env.OCI_BUCKET)}/${encodeKey(key)}`;
  return aws.fetch(url, { method, headers });
}

/** オリジンのレスポンスから必要なヘッダだけを残す */
function clean(res) {
  const h = new Headers();
  for (const name of PASS_HEADERS) {
    const v = res.headers.get(name);
    if (v) h.set(name, v);
  }
  const cr = res.headers.get("content-range");
  if (cr) h.set("content-range", cr);
  return new Response(res.body, { status: res.status, headers: h });
}

/** キャッシュ格納用。エッジ TTL を Cache-Control に入れる（クライアントへは finalize で差し替える） */
function toCacheable(res, edgeTtl) {
  const r = clean(res);
  r.headers.set("cache-control", `public, max-age=${edgeTtl}`);
  return r;
}

/** クライアントへ返す最終レスポンスを組み立てる */
function finalize(res, cfg, request, cacheStatus, ttl) {
  const headers = new Headers(res.headers);
  if (res.status < 400 || ttl !== undefined) {
    headers.set("cache-control", `public, max-age=${ttl ?? cfg.browserTtl}`);
  } else {
    headers.set("cache-control", "no-store");
  }
  if (cacheStatus) headers.set("x-cache", cacheStatus);
  for (const [k, v] of Object.entries(corsHeaders(cfg, request))) headers.set(k, v);
  const body = request.method === "HEAD" ? null : res.body;
  if (request.method === "HEAD" && res.body) res.body.cancel();
  return new Response(body, { status: res.status, headers });
}

function corsHeaders(cfg, request) {
  if (!cfg.corsOrigin) return {};
  let allow = cfg.corsOrigin;
  if (allow !== "*") {
    const list = allow.split(",").map((s) => s.trim());
    const o = request.headers.get("origin");
    if (!o || !list.includes(o)) return {};
    allow = o;
  }
  const h = {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Range, If-None-Match, If-Modified-Since",
    "access-control-expose-headers": "Content-Length, Content-Range, ETag, Accept-Ranges",
    "access-control-max-age": "86400",
  };
  if (allow !== "*") h.vary = "Origin";
  return h;
}

function text(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extra },
  });
}
