# @yuiitsu/dialect-postgres

[`@yuiitsu/core`](https://www.npmjs.com/package/@yuiitsu/core) の PostgreSQL ダイアレクト。

## インストール

```bash
npm i @yuiitsu/core @yuiitsu/dialect-postgres pg kysely hono @hono/zod-openapi zod
```

## 使い方

```ts
import { createAutoApi } from "@yuiitsu/core";
import { postgresDialect } from "@yuiitsu/dialect-postgres";

const api = await createAutoApi<DB>({
  db, // pg を使った Kysely インスタンス
  dialect: postgresDialect(),
  tables: { orders: { operations: ["read"] } },
});
```

## ドライバの前提設定

- `pg` が `int8` を文字列で返す既定を変えない(64 ビット整数の精度を保つため)。
- 既定以外のスキーマを使うときは `createAutoApi` に `pgSchema` を渡す。

全体の使い方・制約・利用者の責務は [yuiitsu のリポジトリ](https://github.com/Takuya-Ampi/yuiitsu#readme) を参照。

## ライセンス

MIT
