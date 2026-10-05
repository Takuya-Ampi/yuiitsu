import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vite-plus/test";
import { DDL, buildApp, type DB } from "../src/app";

describe("examples/basic", () => {
  it("combines auth middleware, scope, a cross-table hook and doc31", async () => {
    const raw = new Database(":memory:");
    raw.defaultSafeIntegers(true);
    raw.pragma("foreign_keys = ON");
    const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
    for (const ddl of DDL) await sql.raw(ddl).execute(db);
    await db.insertInto("inventory").values({ sku: "WIDGET", stock: 2 }).execute();
    const app = await buildApp(db, "s3cret");

    const token = (sub: string) => sign({ sub }, "s3cret", "HS256");
    const auth = async (sub: string) => ({
      authorization: `Bearer ${await token(sub)}`,
      "content-type": "application/json",
    });

    expect((await app.request("/api/orders")).status).toBe(401);

    const alice = await auth("alice");
    const bob = await auth("bob");
    const created = await app.request("/api/orders", {
      method: "POST",
      headers: alice,
      body: JSON.stringify({ total: 5 }),
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as { id: number };
    expect(Object.keys(order).sort()).toEqual(["id", "status", "total"]);

    // 他のユーザーからは見えない
    expect(await (await app.request("/api/orders", { headers: bob })).json()).toEqual([]);
    expect((await app.request(`/api/orders/${order.id}`, { headers: bob })).status).toBe(404);

    // 在庫が同じトランザクションで減る。在庫が尽きたら注文ごとロールバックされる
    expect(
      Number((await db.selectFrom("inventory").select("stock").executeTakeFirstOrThrow()).stock),
    ).toBe(1);
    await app.request("/api/orders", {
      method: "POST",
      headers: bob,
      body: JSON.stringify({ total: 1 }),
    });
    const soldOut = await app.request("/api/orders", {
      method: "POST",
      headers: bob,
      body: JSON.stringify({ total: 1 }),
    });
    expect(soldOut.status).toBe(400);
    expect((await db.selectFrom("orders").select("id").execute()).length).toBe(2);

    const doc: any = await (await app.request("/openapi.json")).json();
    expect(Object.keys(doc.paths)).toContain("/api/orders");
    expect(doc.components.schemas.Orders.properties.internal_note).toBeUndefined();
  });
});
