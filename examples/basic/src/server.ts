import { serve } from "@hono/node-server";
import { sign } from "hono/jwt";
import { buildApp } from "./app.ts";
import { DB_NAMES, connect, prepareExampleTables, type DbName } from "./connect.ts";

const name = (process.env.DB ?? "sqlite") as DbName;
if (!DB_NAMES.includes(name)) {
  console.error(`DB must be one of: ${DB_NAMES.join(", ")} (got "${name}")`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3210);
const secret = process.env.JWT_SECRET ?? "dev-secret";

const conn = await connect(name).catch((e) => {
  console.error(`failed to connect (${name}): ${e instanceof Error ? e.message : e}`);
  console.error("PostgreSQL / MySQL は先に `pnpm exec vp run db:up` で起動する");
  process.exit(1);
});
const created = await prepareExampleTables(name, conn.db);
if (!created) console.info("KEEP_DATA=1: 既存の orders / inventory をそのまま使う");
const app = await buildApp(conn.db, secret, conn.dialect);

const server = serve({ fetch: app.fetch, port }, async (info) => {
  const base = `http://localhost:${info.port}`;
  const alice = await sign({ sub: "alice" }, secret, "HS256");
  const bob = await sign({ sub: "bob" }, secret, "HS256");
  console.info(`DB: ${conn.label}`);
  console.info(`listening on ${base}  (Swagger UI: ${base}/docs, OpenAPI: ${base}/openapi.json)`);
  console.info(`\nexport BASE=${base}\nexport ALICE=${alice}\nexport BOB=${bob}`);
  console.info(`\ncurl -s -X POST $BASE/api/orders -H "Authorization: Bearer $ALICE" \\`);
  console.info(`  -H 'content-type: application/json' -d '{"total":500}'`);
  console.info(`curl -s "$BASE/api/orders?order=total.desc" -H "Authorization: Bearer $ALICE"`);
  console.info(`curl -s $BASE/api/inventory -H "Authorization: Bearer $ALICE"\n`);
});

const stop = async () => {
  server.close();
  await conn.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
