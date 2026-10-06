# @yuiitsu/dialect-sqlite

[`@yuiitsu/core`](https://www.npmjs.com/package/@yuiitsu/core) の SQLite ダイアレクト。

## インストール

```bash
npm i @yuiitsu/core @yuiitsu/dialect-sqlite better-sqlite3 kysely hono @hono/zod-openapi zod
```

## 使い方

```ts
import { createAutoApi } from "@yuiitsu/core";
import { sqliteDialect } from "@yuiitsu/dialect-sqlite";

const api = await createAutoApi<DB>({
  db, // better-sqlite3 を使った Kysely インスタンス
  dialect: sqliteDialect(),
  tables: { orders: { operations: ["read"] } },
});
```

## ドライバの前提設定

- `db.defaultSafeIntegers(true)` を設定する。
- `PRAGMA foreign_keys = ON` を設定する。`PRAGMA busy_timeout` も推奨。

全体の使い方・制約・利用者の責務は [yuiitsu のリポジトリ](https://github.com/Takuya-Ampi/yuiitsu#readme) を参照。

## ライセンス

MIT
