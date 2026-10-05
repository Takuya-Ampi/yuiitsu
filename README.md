# yuiitsu

既存の [Hono](https://hono.dev) アプリに組み込める、複数 DB(PostgreSQL / MySQL / SQLite)対応の REST API 自動生成ライブラリ。

`createAutoApi()` は Hono のサブアプリ(`OpenAPIHono`)を返す。`app.route()` でマウントするだけで、テーブルごとの
CRUD API と OpenAPI 3.1 定義(`@hono/zod-openapi`)を得られる。認証・認可の判断・デプロイには関与しない。

> **0.x の間は破壊的変更が入りうる。**

## インストール

```bash
pnpm add @yuiitsu/core @yuiitsu/dialect-postgres   # または dialect-mysql / dialect-sqlite
pnpm add hono @hono/zod-openapi zod kysely          # peerDependencies
```

DB ドライバ(`pg` / `mysql2` / `better-sqlite3`)は利用者が選んで入れ、Kysely インスタンスとして渡す。

動作確認は Node.js 24。要件: `hono >=4.10`、`@hono/zod-openapi ^1.6.3`、`zod ^4`、`kysely ^0.29`。

## 使い方

```ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { jwt } from "hono/jwt";
import { createAutoApi } from "@yuiitsu/core";
import { sqliteDialect } from "@yuiitsu/dialect-sqlite"; // postgresDialect() / mysqlDialect()

const app = new OpenAPIHono<AppEnv>();
app.use("/api/*", jwt({ secret, alg: "HS256" })); // 認証は利用者の責務。マウントより前に登録する

const api = await createAutoApi<DB, AppEnv>({
  db, // 利用者が作った Kysely インスタンス
  dialect: sqliteDialect(),
  tables: {
    orders: {
      operations: ["read", "create", "update"],
      columns: { read: ["id", "status", "total"], create: ["total"], update: ["status"] },
      scope: (c) => ({ user_id: { eq: c.get("jwtPayload").sub } }), // 行の絞り込み
      hooks: { afterCommitCreate: async (ctx, row) => {} },
    },
  },
});
app.route("/api", api);
app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "API", version: "1.0.0" } });
```

動く例は [examples/basic](examples/basic)。手元での確認手順は [docs/development.md](docs/development.md)。

## パッケージ

| パッケージ                                         | 内容                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@yuiitsu/core`                                    | `createAutoApi`、ルート登録、クエリ解釈、scope、hooks、zod / OpenAPI 生成。DB 固有の分岐は持たない |
| `@yuiitsu/dialect-postgres` / `-mysql` / `-sqlite` | `DialectAdapter`(イントロスペクション、型変換、トランザクション、エラー正規化)                     |

リポジトリ内の `packages/contract-tests`(3 DB 共通の契約テスト)と `examples/basic` は公開しない。

`hono`、`@hono/zod-openapi`、`zod`、`kysely` は peerDependencies。DB ドライバ・認証ライブラリには依存しない。

## 開発

[docs/development.md](docs/development.md) を参照。実装中の判断・確認結果は [docs/decisions.md](docs/decisions.md)。

## 利用者の責務

- 認証(Hono のミドルウェアで、**マウントより前に**登録する)と、行の絞り込みに使う値(ユーザー ID など)を Context に設定すること
- DB 接続、接続プール、シークレットの管理。ロック待ち・ステートメントのタイムアウトなど接続ごとの設定
- リクエストボディのサイズ制限(`hono/body-limit` など)、CORS
- OpenAPI ドキュメントの配信(`app.doc31()`)と、その公開範囲
- DB スキーマを変更したら、アプリを再起動する(`schema` を渡している場合は再生成してから)
- 次の「ドライバ・DB の前提設定」

### ドライバ・DB の前提設定

| 対象             | 設定                                                    | 理由                                                      |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `pg`             | `int8` を文字列で返す既定を変えない                     | 64 ビット整数の精度を保つ                                 |
| `mysql2`         | `supportBigNumbers: true`, `bigNumberStrings: true`     | 未設定だと `BIGINT` の精度が黙って失われる                |
| `mysql2`         | `timezone: 'Z'` と、セッション `time_zone = '+00:00'`   | `TIMESTAMP` を UTC として解釈する                         |
| `mysql2`         | `CLIENT_FOUND_ROWS` を無効にしない(既定で有効)          | UPDATE で「一致した行数」を得る                           |
| `better-sqlite3` | `db.defaultSafeIntegers(true)`                          | 64 ビット整数を `bigint` で受け、範囲を検査する           |
| SQLite           | `PRAGMA foreign_keys = ON`、`PRAGMA busy_timeout`(推奨) | 外部キーは接続ごとに有効化が必要。BUSY の即時発生を避ける |

起動時に確認できるもの(MySQL の `time_zone`、SQLite の `foreign_keys` とバージョン)は警告・例外にする。

## 信頼境界

- hooks は `ctx.db` を直接使える。**hooks 内の DB 操作は `scope` の適用対象外**(仕様上の信頼境界)。
- ただし、hooks が値を書き換えても、自動 CRUD の書き込みには**書き込み後の `scope` 確認**が適用される
  (満たさなければロールバックして 403)。
- 自動生成ルート以外に利用者が足した Hono ルートには、ライブラリは一切関与しない。
- hook の中では必ず渡された `ctx.db` を使う。外側の接続を使うと、接続プールが 1 の環境でデッドロックする。
  `pg` は `connectionTimeoutMillis` でタイムアウトとして検出できるが、`mysql2` と SQLite(Kysely)には接続取得のタイムアウトがなく検出できない。

## 方言差・既知の制約

- `like` は全方言で大文字小文字を区別する。`ilike` は PostgreSQL は `ILIKE`、MySQL は `utf8mb4_0900_as_ci`(アクセントは区別)、SQLite は ASCII のみ。
- `eq` などは照合順序を強制しない。MySQL の既定(`utf8mb4_0900_ai_ci`)では大文字小文字を区別しない。
- 順序: `limit` / `offset` のため、主キーのあるテーブルは主キー昇順を tie breaker にする。主キーのないテーブルは `order` 未指定だと順序が不定。NULL は昇順・降順とも最後。
- `integer` は安全な整数(±(2^53−1))の JSON number。範囲外の値を読むとエラーにする(黙って丸めない)。
- `datetime` はタイムゾーンを持つ型のみ(PostgreSQL `timestamptz`、MySQL `TIMESTAMP`、SQLite `DATETIME`/`TIMESTAMP`)。ミリ秒精度の UTC `Z` 形式で、`timestamptz` のマイクロ秒はミリ秒に切り捨てられる(`timestamptz(3)` を推奨)。MySQL `TIMESTAMP` は 2038 年問題がある。
- `numeric` / `DECIMAL` / `timestamp` / `DATETIME` / `date` / enum などは `unknown`(読み取り専用。値はドライバが返す文字列などをそのまま返す)。
- `afterCommit*` は最大 1 回の best effort(await するが、失敗・タイムアウトはレスポンスに影響しない)。配送保証が必要な処理には使わない。冪等性キーは未実装。
- MySQL は InnoDB のみ・`lower_case_table_names=0` 前提(テーブル名は大文字小文字を区別して照合)。MySQL の `float` は単精度のため、読み出し値に誤差が出る。
- 複合主キー、ビュー、パーティションテーブル、埋め込みリソース、`and` / `or` のネスト条件、集計は未対応。

## ライセンス

[MIT](LICENSE)
