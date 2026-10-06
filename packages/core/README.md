# @yuiitsu/core

既存の [Hono](https://hono.dev) アプリに組み込める REST API 自動生成ライブラリ本体。
Kysely のテーブルから CRUD API と OpenAPI 3.1 定義を生成する。DB ごとのダイアレクト(`@yuiitsu/dialect-*`)と組み合わせて使う。

> **0.x の間は破壊的変更が入りうる。**

## インストール

```bash
npm i @yuiitsu/core @yuiitsu/dialect-postgres   # または dialect-mysql / dialect-sqlite
npm i hono @hono/zod-openapi zod kysely         # peerDependencies
```

要件: Node.js 22.18 以上、`hono >=4.10`、`@hono/zod-openapi ^1.6.3`、`zod ^4`、`kysely ^0.29`。

## 使い方

```ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { createAutoApi } from "@yuiitsu/core";
import { postgresDialect } from "@yuiitsu/dialect-postgres";

const app = new OpenAPIHono();
// 認証は利用者の責務。マウントより前にミドルウェアを登録する

const api = await createAutoApi<DB>({
  db, // 利用者が作った Kysely インスタンス
  dialect: postgresDialect(),
  tables: {
    orders: {
      operations: ["read", "create", "update"],
      columns: { read: ["id", "status", "total"], create: ["total"], update: ["status"] },
    },
  },
});
app.route("/api", api);
app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "API", version: "1.0.0" } });
```

`scope`(行の絞り込み)や `hooks` の例は [examples/basic](https://github.com/Takuya-Ampi/yuiitsu/tree/main/examples/basic) を参照。

全体の使い方・制約・利用者の責務は [yuiitsu のリポジトリ](https://github.com/Takuya-Ampi/yuiitsu#readme) を参照。

## ライセンス

MIT
