# oci-cloudflare-cdn-worker

OCI Object Storage を **Cloudflare の無料プランのまま** CDN の背後に置くための Cloudflare Worker です。

OCI の Always Free は Object Storage API が **月 50,000 リクエスト**までなので、そのまま公開するとすぐ枠に当たります。
Cloudflare でキャッシュしたいところですが、無料プランでは Host ヘッダを書き換えられないので、
オリジン（`objectstorage.<region>.oraclecloud.com`）を普通にプロキシできません。そこでこの Worker を使います。

```
ブラウザ ──> cdn.example.com (Worker) ──[Cache API]──> ヒットならそのまま返す
                                     └─ ミス時だけ ──> OCI Object Storage
```

## 機能

- `.env` を書いて **`npm run deploy` 一発**で Worker・カスタムドメイン・秘密情報をまとめて設定
- エッジキャッシュ（Cache API）でオリジンへのアクセスを最小化
  - クエリ文字列は既定でキャッシュキーから除外（`?random` でキャッシュを素通りさせる攻撃で OCI の枠を消費されない）
  - 404 も短時間キャッシュ（存在しないパスの総当たり対策）
  - キャッシュ期間（既定: オブジェクト 30 日 / 404 は 5 分）は `.env` で変更可能
- Range リクエスト（動画のシーク等）、`If-None-Match` / `If-Modified-Since`（304）、HEAD に対応
- オリジンへの接続方式を 3 種類から選択
  | モード | 必要なもの | 備考 |
  |---|---|---|
  | **PAR**（推奨） | 事前認証済リクエストの URL | バケットはプライベートのまま。設定が最も簡単 |
  | **S3 互換** | 顧客秘密キー（アクセスキー/シークレット） | 有効期限なし。SigV4 署名 |
  | パブリック | なし | オリジンを直接叩かれると枠を消費されるので非推奨 |
- OCI 固有のレスポンスヘッダ（`opc-request-id` 等）は除去、CORS は任意で付与

> OCI を課金なしで使い続けるための設定や注意点は **[OCI Object Storage を完全無料で使うためのガイド](docs/oci-free-tier-guide.md)** にまとめています。

## 使い方

前提: Node.js 20.12 以上、Cloudflare にゾーン（ドメイン）を登録済み。

```bash
git clone https://github.com/yuba/oci-cloudflare-cdn-worker.git
```

```bash
cd oci-cloudflare-cdn-worker && cp .env.example .env
```

`.env` を編集して（下記参照）、

```bash
npm run deploy
```

初回は依存関係のインストールも自動で行います。`.env` を変えたら同じコマンドを再実行するだけです。

| コマンド | 内容 |
|---|---|
| `npm run deploy` | 接続確認してからデプロイ（再実行で設定更新） |
| `npm run check` | 接続確認とビルド確認だけ行う（アップロードしない） |
| `npm run destroy` | Worker を削除 |
| `npm test` | ローカルのモック・オリジンで動作テスト |

`--env-file=path` で `.env` 以外のファイルも使えます（例: `npm run deploy -- --env-file=.env.prod`）。

### 接続確認

`check` と `deploy` は、最初に次の項目を実際に API を呼んで確認します。問題があれば `deploy` は中止されます（`--skip-verify` で省略可）。

| 対象 | 確認内容 |
|---|---|
| Cloudflare API トークン | 有効か（有効期限も表示） |
| アカウント ID | そのトークンで Workers を操作できるか |
| `CUSTOM_DOMAIN` | ゾーンがアカウントにあるか、別の Worker に使われていないか、既存の DNS レコードがないか |
| OCI | 存在しないオブジェクトを 1 回取得し、返ってきたエラーの種類で PAR / キー / バケット名の正否を判定（OCI の API リクエストを 1 回消費） |

トークンに DNS 読取り権限がない場合、DNS レコードの確認は警告だけになります。
S3 互換モードでバケットの一覧権限（`BUCKET_INSPECT`）がない場合は、キーが正しくても 403 になるため、警告だけになります。

### 1. Cloudflare の準備

- **API トークン**: ダッシュボード → My Profile → API Tokens → Create Token → テンプレート「**Edit Cloudflare Workers**」。
  Zone Resources で公開に使うゾーンを含めてください（カスタムドメインの DNS レコード作成に必要）。
- **アカウント ID**: ダッシュボードの Workers & Pages のページ右側などに表示されています。
- **CUSTOM_DOMAIN**: そのゾーンのサブドメイン（例 `cdn.example.com`）。**DNS レコードはまだ作らないでください**。
  Worker のカスタムドメインとして DNS レコードと証明書が自動で作られます。

### 2. OCI の準備

#### A. 事前認証済リクエスト（PAR）— 推奨

1. バケットを **プライベート** で作成（既存でも可）
2. バケット詳細 → 事前認証済リクエスト → 作成
   - ターゲット: **バケット**
   - アクセス・タイプ: **バケット内のオブジェクトの読取りを許可**
   - オブジェクト・リスト: **有効にしない**
   - 有効期限: 長めに（期限切れになると配信が止まるので注意）
3. 表示された URL（`https://objectstorage.<region>.oraclecloud.com/p/<token>/n/<namespace>/b/<bucket>/o/`）を `OCI_PAR_URL` に設定

> PAR の URL はそれ自体が鍵なので、Worker の **Secret** として暗号化保存されます（ダッシュボードからも値は見えません）。

#### B. S3 互換 API

1. プロファイル → 顧客秘密キー → 秘密キーの生成
2. `OCI_ACCESS_KEY_ID` / `OCI_SECRET_ACCESS_KEY` / `OCI_REGION`（例 `ap-tokyo-1`）/ `OCI_NAMESPACE` / `OCI_BUCKET` を設定
3. キーのユーザーに、そのバケットのオブジェクト読取り権限（`OBJECT_READ`。404 を正しく返すには `BUCKET_INSPECT` も）を付与

エンドポイントは `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com` を使います（`OCI_ENDPOINT` で上書き可）。

モードは `OCI_PAR_URL` → S3 キー → パブリックの順で自動判定されます。

### 3. 配信

`https://cdn.example.com/path/to/file.png` → オブジェクト `path/to/file.png`（`PATH_PREFIX` を付けるとその下を参照）。
レスポンスヘッダ `x-cache: HIT / MISS / BYPASS` でキャッシュ状況が分かります。

## オプション

`.env.example` に全項目と説明があります。キャッシュ期間は秒数のほか `30d` `5m` `1h30m` のように単位付きで書けます（`s` `m` `h` `d` `w`）。主なもの:

| 変数 | 既定値 | 説明 |
|---|---|---|
| `EDGE_CACHE_TTL` | `30d` | エッジでオブジェクトをキャッシュする期間 |
| `NEGATIVE_CACHE_TTL` | `5m` | 404 をエッジにキャッシュする期間（`0` で無効） |
| `BROWSER_CACHE_TTL` | `1h` | ブラウザに返す `Cache-Control: max-age` |
| `MAX_CACHE_SIZE_MB` | `512` | これより大きいオブジェクトはキャッシュせず素通し |
| `CACHE_KEY_INCLUDE_QUERY` | `false` | クエリ文字列をキャッシュキーに含める |
| `PATH_PREFIX` | なし | オブジェクト名の接頭辞 |
| `INDEX_DOCUMENT` | なし | `/` で終わるパスに付けるファイル名（例 `index.html`） |
| `CORS_ALLOW_ORIGIN` | なし | `*` またはカンマ区切りのオリジン |

## 注意点・制約

- **Workers の無料枠は 1 日 10 万リクエスト**です。Worker はキャッシュの手前で動くので、ヒット・ミスに関わらず全リクエストがカウントされます（月 300 万程度が上限の目安）。それでも OCI 側の 5 万/月よりはずっと大きく、OCI へは基本的に「オブジェクトごと・エッジのデータセンターごとに 1 回」しか行きません。
- **Cache API は `*.workers.dev` では効きません**。必ず `CUSTOM_DOMAIN` を設定してください。
- キャッシュはデータセンター単位です。世界中からアクセスされる場合、各拠点で初回だけオリジンに行きます。
- Range 付きリクエストがキャッシュミスした場合は、オブジェクト全体を取得してキャッシュに格納してから該当範囲を返します（大きな動画の初回再生だけ少し待たされます）。`MAX_CACHE_SIZE_MB` を超えるものは Range ごとオリジンに素通しになります。
- **オブジェクトを上書きしたとき**はキャッシュが残ります。Cloudflare ダッシュボード → Caching → Configuration → Purge Cache で消すか、ファイル名を変えて（`app.v2.js` など）配信してください。クエリ文字列での更新は既定では効きません（`CACHE_KEY_INCLUDE_QUERY=true` で有効化できますが、その分キャッシュを回避されやすくなります）。
- 秘密情報（`OCI_PAR_URL` / `OCI_ACCESS_KEY_ID` / `OCI_SECRET_ACCESS_KEY`）は Worker Secret として、それ以外は通常の環境変数として登録されます。モードを切り替えて再デプロイすると、使わなくなった Secret は削除されます。

## License

MIT
