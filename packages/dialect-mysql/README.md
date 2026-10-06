# @yuiitsu/dialect-mysql

[`@yuiitsu/core`](https://www.npmjs.com/package/@yuiitsu/core) の MySQL ダイアレクト。

## インストール

```bash
npm i @yuiitsu/core @yuiitsu/dialect-mysql mysql2 kysely hono @hono/zod-openapi zod
```

## 使い方

```ts
import { createAutoApi } from "@yuiitsu/core";
import { mysqlDialect } from "@yuiitsu/dialect-mysql";

const api = await createAutoApi<DB>({
  db, // mysql2 を使った Kysely インスタンス
  dialect: mysqlDialect(),
  tables: { orders: { operations: ["read"] } },
});
```

## ドライバの前提設定

- `mysql2` に `supportBigNumbers: true`、`bigNumberStrings: true`、`timezone: "Z"` を設定する。
- セッションの `time_zone` を `+00:00` にする。
- `CLIENT_FOUND_ROWS` を無効にしない(既定で有効)。
- InnoDB のみ、`lower_case_table_names=0` 前提。

全体の使い方・制約・利用者の責務は [yuiitsu のリポジトリ](https://github.com/Takuya-Ampi/yuiitsu#readme) を参照。

## ライセンス

MIT
