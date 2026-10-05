# 開発・動作確認

## 開発

Node.js 24 と Docker が必要。ツールチェーンは Vite+ (`vp`) で、`vite-plus` はこの workspace の devDependency。

```bash
pnpm install
cp .env.example .env   # 任意。既定値と同じ
pnpm exec vp run db:up   # PostgreSQL 18.6 / MySQL 8.4.11 を起動(docker compose)
pnpm exec vp test run    # 契約テスト(DB に接続できなければ失敗する)
pnpm exec vp check       # format / lint / 型チェック
pnpm exec vp run -r build  # 各パッケージを vp pack でビルド
pnpm exec vp run db:down
```

`db:reset` はボリュームも削除して再作成する。ホスト側ポートは `PG_PORT`(15432)/ `MYSQL_PORT`(13306)で変更できる。

## 手動で動作確認する

[examples/basic](../examples/basic)(JWT 認証 + scope + テーブルを跨ぐ hook + OpenAPI)を、3 つの DB のどれでも動かせる。
Node.js 24 と Docker(PostgreSQL / MySQL を使うとき)が必要。以降はリポジトリのルートで実行する。初回は `pnpm install`。

### 1. まとめて自動確認(最短)

```bash
pnpm verify            # sqlite / postgres / mysql の全部
pnpm verify postgres   # 1 つだけ(postgres | mysql | sqlite)
```

ビルド → (必要なら)`docker compose up` → サーバー起動 → 確認シナリオ(`examples/basic/src/smoke.ts`)→ 停止、を DB ごとに行い、最後に DB ごとの OK / FAIL を出す。
ポートは `PORT`(既定 3210)で変更できる。確認する内容:

- 認証なしは 401、他ユーザーの行は一覧・GET・PATCH で見えない(`scope`)
- `create` / `read` 許可外の列は 400、CHECK 制約違反は 400(`invalid_value`)
- フィルタ(`gte` / `in`)、`order`、`limit` / `offset` / `select`、PATCH
- hook が同一トランザクションで在庫を減らし、在庫切れなら注文ごとロールバックされる
- `/openapi.json` が 3.1 で、非公開列(`internal_note`)を含まない

### 2. サーバーを起動して自分で叩く

```bash
pnpm example:sqlite     # SQLite(.data/example.sqlite に保存)
pnpm example:postgres   # PostgreSQL 18.6(docker compose で起動)
pnpm example:mysql      # MySQL 8.4.11(docker compose で起動)
```

起動のたびに `orders` / `inventory` は作り直され、データも消える。**データを消さずに**再起動するときは `KEEP_DATA=1` を付ける(テーブルが無ければ作る)。

```bash
KEEP_DATA=1 pnpm example:sqlite
KEEP_DATA=1 pnpm example:postgres
KEEP_DATA=1 pnpm example:mysql
```

TablePlus で足した列や登録したデータを残したまま、再起動して Swagger に反映したいときに使う。データを初期状態に戻したいときは `KEEP_DATA` なしで起動する。

起動すると `http://localhost:3210` で待ち受け(`PORT` で変更)、ユーザー `alice` / `bob` の JWT と curl の例が表示される。

```bash
export BASE=http://localhost:3210
export ALICE=<表示された JWT>
curl -s -X POST $BASE/api/orders -H "Authorization: Bearer $ALICE" -H 'content-type: application/json' -d '{"total":500}'
curl -s "$BASE/api/orders?order=total.desc&limit=5" -H "Authorization: Bearer $ALICE"
curl -s $BASE/api/inventory -H "Authorization: Bearer $ALICE"   # 注文のたびに stock が減る
curl -s $BASE/openapi.json
```

起動中のサーバーに確認シナリオだけを流すこともできる(サーバーは起動のたびにデータを初期化するので、再実行する前に再起動する)。

```bash
BASE_URL=http://localhost:3210 pnpm --filter @yuiitsu/example-basic smoke
```

### Swagger UI で確認する

サーバー起動後、ブラウザで `http://localhost:3210/docs`(`PORT` を変えたらそのポート)を開く。`/openapi.json` を読み込んで、全ルートの定義(列の型・必須・フィルタの書式・エラーレスポンス)を表示し、そのまま実行できる。

1. 起動ログに表示される `ALICE`(または `BOB`)の JWT をコピーする。
2. 画面右上の **Authorize** を押し、値の欄に JWT だけを貼る(`Bearer ` は付けない)。**Authorize** → **Close**。
3. `POST /api/orders` → **Try it out** → body に `{"total": 500}` → **Execute**。
4. `GET /api/orders` や `GET /api/inventory` を実行する。`BOB` の JWT に付け替えると、`ALICE` の注文は見えなくなる(`scope`)。

- 他のプロセスが同じポートを使っていると、`localhost` が別のサーバーに繋がることがある(IPv6 の `::1` を先に使うため。実際に別プロジェクトの vite で発生した)。開けないときは `lsof -nP -iTCP:3210 -sTCP:LISTEN` で確認し、`PORT=<空きポート>` で起動し直す。
- Swagger UI は CDN(unpkg)から読み込むので、ネットワーク接続が必要。`/docs` は例のサーバーが提供するもので、ライブラリの機能ではない(配信は利用者の責務)。
- 定義だけ欲しいときは `curl -s http://localhost:3210/openapi.json`。他のツール(Postman / Insomnia など)にはこの URL をインポートする。
- `/openapi.json` と `/docs` は認証なしで見られる(`/api/*` のみ JWT 必須)。

### DB の中身を GUI(TablePlus など)で見る

サーバー(または `pnpm verify`)を起動した状態で、次の接続を作る。PostgreSQL / MySQL は `docker compose` のコンテナ(`pnpm exec vp run db:up`)。値は `.env` で変えていなければ既定値。

| 項目     | PostgreSQL                         | MySQL                  | SQLite                          |
| -------- | ---------------------------------- | ---------------------- | ------------------------------- |
| Host     | `127.0.0.1`                        | `127.0.0.1`            | -                               |
| Port     | `15432`(`PG_PORT`)                 | `13306`(`MYSQL_PORT`)  | -                               |
| User     | `autoapi`                          | `autoapi`              | -                               |
| Password | `autoapi_dev`                      | `autoapi_dev`          | -                               |
| Database | `autoapi_example`                  | `autoapi_test_example` | ファイル `.data/example.sqlite` |
| 対象     | `public` の `orders` / `inventory` | `orders` / `inventory` | `orders` / `inventory`          |

- PostgreSQL の `autoapi_example` と MySQL の `autoapi_test_example` は、サーバーを一度起動すると作られる(契約テストの DB とは別)。
- MySQL は管理用に `root` / `root_dev`(`MYSQL_ROOT_PASSWORD`)でも入れる。
- SQLite は `pnpm example:sqlite` のときだけファイルに保存される(`SQLITE_FILE` で変更可)。`pnpm verify` と、`SQLITE_FILE` なしの起動はインメモリで、外から見られない。
- サーバーは起動のたびに `orders` / `inventory` を作り直す。見終わったら TablePlus 側は再読み込みする。契約テスト用の DB は `autoapi_test_w*`(MySQL)/ `test_w*`(PostgreSQL)で、テスト終了後に使い回される領域。

注意:

- PostgreSQL は `autoapi_example`、MySQL は `autoapi_test_example` データベースを使う(契約テストとは別)。起動のたびにその中の `orders` / `inventory` を **drop して作り直す**。接続先は `.env`(`PG_*` / `MYSQL_*`、`.env.example` 参照)で変える。
- `KEEP_DATA=1` を付けると、`orders` / `inventory` が既にあれば作り直さない(DB に直接足した列やデータが残る)。無ければ通常どおり作る。例: `KEEP_DATA=1 pnpm example:postgres`。列を足した後は再起動すると、起動時の DB 構造の読み取りで Swagger に反映される(`columns` で絞っている場合は許可リストにも足す)。`pnpm verify` は常に作り直す。
- 直接 DB を見る: `docker compose exec postgres psql -U autoapi -d autoapi_example` /
  `docker compose exec mysql mysql -uautoapi -pautoapi_dev autoapi_test_example`
- 終了: `Ctrl-C`。DB コンテナは `pnpm exec vp run db:down` で止める。
