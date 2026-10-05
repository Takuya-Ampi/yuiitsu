# 実装中の判断・確認結果

「yuiitsu PoC 設計書」(以下、設計書。章番号はその章)に対する、実装時の確認結果と判断。

## 1. バージョン固定(16章)

- PostgreSQL `postgres:18.6` / MySQL `mysql:8.4.11`(Docker Hub の最新パッチ。2026-10-04 時点)
- SQLite 3.53.4(better-sqlite3 13.0.3 同梱)。起動時に 3.37 以上を `preflight` で検査し、テストでも `sqlite_version()` を記録・assert する
- `@hono/zod-openapi` 1.6.3(peer: `zod ^4`、`hono >=4.10`)/ hono 4.13.12 / kysely 0.29.6 / zod 4.6.x
- 開発・テスト用ドライバ: pg 8.23.1 / mysql2 3.24.5 / better-sqlite3 13.0.3
- Vite+ 1.0.0 は workspace の devDependency としてローカル導入(グローバルな `vp` は不要)。Node は mise の 24.14.0
  - `pnpm add` 時の `unmet peer vite@... found 1.0.0` は vite-plus が vite を別名で提供するため。実害なし
  - better-sqlite3 13 は prebuild を同梱するので `onlyBuiltDependencies` に入れない(入れると `node-gyp` が走って失敗する)
- ホスト側ポートの既定は PG 15432 / MySQL 13306(同リポジトリの別 PoC の 25432 などと衝突しない値。環境変数で変更可)

## 2. 16章の確認結果

| 項目                                                  | 結果                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.route()` でマウントしたサブアプリの OpenAPI 定義 | 親の `app.doc31()` に `/api/...` の prefix 付きで取り込まれる(`core/test/spike-registry.test.ts`、`openapi.test.ts`)。代替案 `registerAutoApiDocs` は不要                                                                                                                                                                                                                                       |
| SQLite の `BEGIN IMMEDIATE`                           | `SqliteDialect` の `transaction()` では指定できない。`db.connection()` の中で `begin immediate` / `commit` / `rollback` を発行する方式で実装(`drivers.test.ts` で、2 本目の書き込みが即 `SQLITE_BUSY` → 503 になることを確認)                                                                                                                                                                   |
| MySQL `numUpdatedRows`                                | mysql2 の `affectedRows` に対応。`CLIENT_FOUND_ROWS` が既定で有効で、同じ値での UPDATE も 1 行(404 にならない)                                                                                                                                                                                                                                                                                  |
| MySQL `insertId`                                      | `bigint`。`0n` または `undefined` なら主キーを特定できないとして 500 + ロールバック                                                                                                                                                                                                                                                                                                             |
| `setIsolationLevel('read committed')`                 | PG は `show transaction_isolation` が `read committed`。MySQL は `@@transaction_isolation` が次のトランザクション用の設定を反映しないため、挙動(他トランザクションのコミットが後続の読み取りで見える)で確認                                                                                                                                                                                     |
| mysql2 の `supportBigNumbers` / `bigNumberStrings`    | `BIGINT` が文字列で返る                                                                                                                                                                                                                                                                                                                                                                         |
| mysql2 の `timezone: 'Z'` + セッション `+00:00`       | `TIMESTAMP(3)` が UTC で往復する(`+09:00` 入力 → DB 内 `03:34:56.789`)                                                                                                                                                                                                                                                                                                                          |
| better-sqlite3 の `defaultSafeIntegers(true)`         | Kysely の `SqliteDialect` 経由でも効く(整数は `bigint`)                                                                                                                                                                                                                                                                                                                                         |
| pg                                                    | `int8` は文字列、`timestamptz` は `Date`                                                                                                                                                                                                                                                                                                                                                        |
| 接続プール 1 で hook が外側の接続を使った場合         | **PostgreSQL のみ検出可能**(`pg.Pool` の `connectionTimeoutMillis` でタイムアウト → 500。テストあり)。**mysql2 には接続取得のタイムアウトがなく、Kysely の SqliteDriver は接続を mutex で直列化するため、MySQL / SQLite ではハングする**。ライブラリ側で検出する手段がないため、README に「hook 内は必ず `ctx.db`」と明記し、設計書 12.2 の「全方言で検出される」は PostgreSQL のみ充足。要判断 |
| MySQL 8.4 の `BOOLEAN` / `TINYINT(1)`                 | `COLUMN_TYPE` が `tinyint(1)`                                                                                                                                                                                                                                                                                                                                                                   |
| `COLLATE utf8mb4_0900_as_cs` / `as_ci` の LIKE        | 想定どおり(`as_cs` は大文字小文字を区別、`as_ci` は区別せず、アクセントは区別)                                                                                                                                                                                                                                                                                                                  |
| 6.5.1 のエラーコード                                  | 実 DB で確認: unique(409)、foreign key(409)、check(400)、NOT NULL(400)、data exception(PG / MySQL。400)、SQLite の BUSY(503)。表そのもの(全コード)は単体テスト。実 DB で再現していないもの: serialization_failure、deadlock、lock_timeout(PG / MySQL)、timeout、connection_error                                                                                                                |
| `vp pack`                                             | peerDependencies(`hono`、`@hono/zod-openapi`、`kysely`、`zod`、`@yuiitsu/core`)は外部依存のまま、バンドルに含まれない                                                                                                                                                                                                                                                                           |
| `vp check`                                            | 既定では型チェックを含まない。ルートの `vite.config.ts` に `lint.options.typeAware` / `typeCheck: true` を設定して実行する                                                                                                                                                                                                                                                                      |

## 3. 設計書からの差分・補足した判断

- `SchemaMeta.tables[].engine?` を追加(MySQL のストレージエンジン)。InnoDB 以外を `tables` に指定した場合に起動時エラーにするため。
- `DialectAdapter` に `assertTableSupported(table)` と `preflight(db, { exposesDatetime })` を追加。MySQL の InnoDB / `time_zone` / DB 未選択、SQLite のバージョン / `foreign_keys` といった方言固有の起動時検証を `core` の分岐にしないため。
- `orderByNullsLast()` は `Expression[]` を返し、`core` が順に `orderBy()` へ渡す(MySQL は `col is null` + `col dir` の 2 要素)。
- 起動時エラーの種別を `tables.<name>: ...` 形式のメッセージで返す。警告の出力先は `options.onWarning`(既定 `console.warn`)。
- `is` 演算子は `is.null` / `is.not_null` のみ。scope では `{ is: null }` / `{ is: 'not_null' }`。
- `limit` が `maxLimit` を超える場合は丸めず 400。`limit=0` も 400。`select=*` は read 用の全カラム。
- 存在しないカラムと許可されていないカラムのエラーは、メッセージにカラム名も含めず完全に同一(`Unknown column or parameter`)。
- `unknown` 型の読み取り表現: 文字列・数値・真偽値はそのまま、`bigint` は文字列、`Date` は ISO 文字列、バイナリは base64、配列・オブジェクトはそのまま。それ以外は 500。
- hooks に渡す json カラムの DB 側表現は **JSON テキスト**(`encodeValue` の出力)。`validateDbValue('json', v)` は JSON としてパースできる文字列のみ受け付ける。PG の配列パラメータ誤解釈を避けるため。
- hook の戻り値が空(更新対象なし)の場合の update は 500。
- MySQL の `data_exception` に errno 1366 / 1292 も含めた(不正な値)。
- OpenAPI の読み取りレスポンスは、`select=` で列を絞るとレスポンスが `required` を満たさなくなるが、OpenAPI では表現できないため `select` パラメータの description に記載。
- 必須の json カラムは、キー欠落を zod で拒否するため入力スキーマを JSON 値の union にしている(任意の json カラムは `z.unknown()`)。
- SQLite の `INTEGER PRIMARY KEY`(rowid の別名)は `isGenerated` / `isAutoIncrement` と判定され、既定では書き込めない。`INT PRIMARY KEY` や `WITHOUT ROWID` は別名ではない(設計書 6.4 のとおり)。
- PostgreSQL の `pg_attribute.attname` は `name` 型で、配列にすると `pg` がパースしない。外部キーのカラム列は `::text` にキャストして集約する。

## 4. 方言差(契約テストで暗黙に無視していないもの)

| 項目                           | 差                                                                                                            | テスト                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `eq` の大文字小文字            | PG / SQLite は区別する。MySQL(既定の照合順序)は区別しない                                                     | `startup.test.ts`(方言別の期待値) |
| `like`                         | 全方言で大文字小文字を区別(SQLite は GLOB に変換)                                                             | `crud.test.ts`(全方言同一)        |
| `ilike`                        | ASCII の範囲は全方言同一。ASCII 外の大文字小文字は PG / MySQL / SQLite で異なる。MySQL はアクセントを区別する | `crud.test.ts`、`drivers.test.ts` |
| `like` / `ilike` の提供        | MySQL の `utf8mb4` 以外のカラムでは 400(OpenAPI の description も変わる)                                      | `startup.test.ts`                 |
| 文字列長超過(`data_exception`) | PG / MySQL は 400。SQLite は長さを強制しないため対象外                                                        | `crud.test.ts`(SQLite のみ skip)  |
| OpenAPI の `uuid`              | MySQL には UUID 型がないため `format: uuid` が付かない(PG / SQLite は付く)。それ以外の定義は全方言で一致      | `openapi.test.ts`                 |
| 並行実行                       | 全方言で、並列の作成・更新・削除に 5xx が出ないこと                                                           | `concurrency.test.ts`             |

## 5. 未対応(Should / スコープ外)

- Should(14.2)のうち未着手: `introspectSchema()` の JSON 書き出し CLI、`schema` と実 DB のずれ検出、`Prefer: count=exact`、MySQL 9.7 / PG 19 の CI マトリクス、ASCII 外・アクセントの網羅的な照合順序の記録
- Should のうち実施済み: 同時書き込みの統合テスト(`concurrency.test.ts`。ロック競合の網羅ではない)、native type の一部拡張はしていない
- `introspectSchema(db, dialect, options)` は export 済み(`schema` に渡せる JSON を返す)
