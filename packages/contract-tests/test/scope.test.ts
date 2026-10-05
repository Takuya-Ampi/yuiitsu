import { HTTPException } from "hono/http-exception";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { call, makeApp, type TestEnv } from "./support/app";
import { DIALECTS, makeTarget, type Target } from "./support/targets";

const count = async (t: Target, where = "1=1") =>
  Number(
    (
      (
        await sql<{ n: unknown }>`select count(*) as n from orders where ${sql.raw(where)}`.execute(
          t.db,
        )
      ).rows[0] as any
    ).n,
  );

const READ = ["id", "user_id", "status", "total", "note", "created_at"] as const;

describe.each(DIALECTS)("scope and column allow-lists (%s)", (name) => {
  let t: Target;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let mine: number;
  let theirs: number;

  beforeAll(async () => {
    t = await makeTarget(name);
    app = await makeApp<any, TestEnv>(t, {
      orders: {
        operations: ["read", "create", "update", "delete"],
        columns: {
          read: [...READ],
          create: ["status", "total", "note"],
          update: ["status", "user_id", "total"],
        },
        scope: (c) => ({ user_id: { eq: c.get("userId") } }),
        hooks: {
          // サーバー側で所有者を設定する(columns.create から user_id を外している)
          beforeCreate: async (ctx, data) => ({ ...data, user_id: ctx.c.get("userId") }),
        },
      },
    });
  });
  afterAll(async () => {
    await t.teardown();
  });
  beforeEach(async () => {
    await t.reset();
    await t.db
      .insertInto("orders")
      .values({ user_id: "u1", total: 1, secret: "S-1", note: "mine" })
      .execute();
    await t.db
      .insertInto("orders")
      .values({ user_id: "u2", total: 2, secret: "S-2", note: "theirs" })
      .execute();
    const rows = (
      await sql<{
        id: number;
        user_id: string;
      }>`select id, user_id from orders order by id`.execute(t.db)
    ).rows;
    mine = Number(rows[0]!.id);
    theirs = Number(rows[1]!.id);
  });

  it("hides rows outside the scope in list and single reads", async () => {
    const l = await call(app, "GET", "/orders", { user: "u1" });
    expect(l.json.map((r: any) => r.user_id)).toEqual(["u1"]);
    expect((await call(app, "GET", `/orders/${mine}`, { user: "u1" })).status).toBe(200);
    expect((await call(app, "GET", `/orders/${theirs}`, { user: "u1" })).status).toBe(404);
  });

  it("cannot update or delete rows outside the scope", async () => {
    expect(
      (await call(app, "PATCH", `/orders/${theirs}`, { user: "u1", body: { status: "x" } })).status,
    ).toBe(404);
    expect((await call(app, "DELETE", `/orders/${theirs}`, { user: "u1" })).status).toBe(404);
    expect(await count(t, `id = ${theirs} and status = 'new'`)).toBe(1);
  });

  it("ignores user filters that try to widen the scope", async () => {
    const r = await call(app, "GET", "/orders?user_id=eq.u2", { user: "u1" });
    expect(r.json).toEqual([]);
    const r2 = await call(app, "GET", "/orders?user_id=neq.u1", { user: "u1" });
    expect(r2.json).toEqual([]);
    expect(
      (await call(app, "GET", "/orders?or=(user_id.eq.u2,user_id.eq.u1)", { user: "u1" })).status,
    ).toBe(400);
  });

  it("aborts when scope throws or returns an unusable value (never falls back to all rows)", async () => {
    const r = await call(app, "GET", "/orders"); // x-user なし → undefined
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("mine");

    const boom = await makeApp(t, {
      orders: {
        operations: ["read"],
        scope: () => {
          throw new Error("nope");
        },
      },
    });
    expect((await call(boom, "GET", "/orders")).status).toBe(500);
    const http = await makeApp(t, {
      orders: {
        operations: ["read"],
        scope: () => {
          throw new HTTPException(401, { message: "login required" });
        },
      },
    });
    const h = await call(http, "GET", "/orders");
    expect(h.status).toBe(401);
    expect(h.json.error.message).toBe("login required");
  });

  it("puts the scope into the real UPDATE / DELETE WHERE (not only a pre-check)", async () => {
    // hook が同一トランザクション内で所有者を変えても、UPDATE / DELETE の WHERE が scope を守る
    const racing = await makeApp<any, TestEnv>(t, {
      orders: {
        operations: ["read", "update", "delete"],
        scope: (c) => ({ user_id: { eq: c.get("userId") } }),
        hooks: {
          beforeUpdate: async (ctx, id, data) => {
            await sql`update orders set user_id = 'u2' where id = ${id as number}`.execute(ctx.db);
            return data;
          },
          beforeDelete: async (ctx, id) => {
            await sql`update orders set user_id = 'u2' where id = ${id as number}`.execute(ctx.db);
          },
        },
      },
    });
    expect(
      (await call(racing, "PATCH", `/orders/${mine}`, { user: "u1", body: { status: "x" } }))
        .status,
    ).toBe(404);
    expect(await count(t, `id = ${mine} and status = 'new' and user_id = 'u1'`)).toBe(1);
    expect((await call(racing, "DELETE", `/orders/${mine}`, { user: "u1" })).status).toBe(404);
    expect(await count(t, `id = ${mine} and user_id = 'u1'`)).toBe(1);
  });

  describe("writes outside the scope", () => {
    it("create: a row that ends up outside the scope is rolled back with 403", async () => {
      const hijack = await makeApp<any, TestEnv>(t, {
        orders: {
          operations: ["read", "create"],
          scope: (c) => ({ user_id: { eq: c.get("userId") } }),
          hooks: { beforeCreate: async (_ctx, data) => ({ ...data, user_id: "u2" }) },
        },
      });
      const before = await count(t);
      const r = await call(hijack, "POST", "/orders", {
        user: "u1",
        body: { user_id: "u1", total: 5 },
      });
      expect(r.status).toBe(403);
      expect(await count(t)).toBe(before);
    });

    it("create: values supplied by DB defaults are checked too", async () => {
      const byDefault = await makeApp<any, TestEnv>(t, {
        orders: {
          operations: ["read", "create"],
          columns: { create: ["user_id", "total"] },
          scope: () => ({ status: { eq: "paid" } }), // status の DB デフォルトは 'new'
        },
      });
      const before = await count(t);
      const r = await call(byDefault, "POST", "/orders", { body: { user_id: "u1", total: 5 } });
      expect(r.status).toBe(403);
      expect(await count(t)).toBe(before);
    });

    it("update: moving a row out of the scope is rolled back with 403", async () => {
      const r = await call(app, "PATCH", `/orders/${mine}`, {
        user: "u1",
        body: { user_id: "u2" },
      });
      expect(r.status).toBe(403);
      expect(await count(t, `id = ${mine} and user_id = 'u1'`)).toBe(1);
    });

    it("update: a hook that rewrites the scope column cannot bypass the check", async () => {
      const hijack = await makeApp<any, TestEnv>(t, {
        orders: {
          operations: ["read", "update"],
          scope: (c) => ({ user_id: { eq: c.get("userId") } }),
          hooks: { beforeUpdate: async (_ctx, _id, data) => ({ ...data, user_id: "u2" }) },
        },
      });
      const r = await call(hijack, "PATCH", `/orders/${mine}`, {
        user: "u1",
        body: { status: "paid" },
      });
      expect(r.status).toBe(403);
      expect(await count(t, `id = ${mine} and status = 'new' and user_id = 'u1'`)).toBe(1);
    });

    it("create inside the scope works and the server sets the owner", async () => {
      const r = await call(app, "POST", "/orders", { user: "u1", body: { total: 9 } });
      expect(r.status, r.text).toBe(201);
      expect(r.json.user_id).toBe("u1");
    });
  });

  describe("hook output is re-validated before reaching the database", () => {
    const mk = (hooks: any) =>
      makeApp<any, TestEnv>(t, { orders: { operations: ["read", "create", "update"], hooks } });

    it("rejects a wrong type, an unknown column and a primary key change", async () => {
      const before = await count(t);
      const wrongType = await mk({
        beforeCreate: async (_c: any, d: any) => ({ ...d, total: "abc" }),
      });
      expect(
        (await call(wrongType, "POST", "/orders", { body: { user_id: "a", total: 1 } })).status,
      ).toBe(500);
      const unknownCol = await mk({ beforeCreate: async (_c: any, d: any) => ({ ...d, nope: 1 }) });
      expect(
        (await call(unknownCol, "POST", "/orders", { body: { user_id: "a", total: 1 } })).status,
      ).toBe(500);
      const pkChange = await mk({
        beforeUpdate: async (_c: any, _i: any, d: any) => ({ ...d, id: 99999 }),
      });
      expect(
        (await call(pkChange, "PATCH", `/orders/${mine}`, { body: { status: "x" } })).status,
      ).toBe(500);
      expect(await count(t)).toBe(before);
      expect(await count(t, `id = ${mine} and status = 'new'`)).toBe(1);
    });
  });

  describe("column allow-lists", () => {
    it("never returns columns outside columns.read", async () => {
      const one = await call(app, "GET", `/orders/${mine}`, { user: "u1" });
      expect(Object.keys(one.json).sort()).toEqual([...READ].sort());
      const l = await call(app, "GET", "/orders", { user: "u1" });
      expect(Object.keys(l.json[0])).not.toContain("secret");
      const c = await call(app, "POST", "/orders", { user: "u1", body: { total: 9 } });
      expect(Object.keys(c.json)).not.toContain("secret");
      expect(c.text).not.toContain("secret");
      const u = await call(app, "PATCH", `/orders/${mine}`, {
        user: "u1",
        body: { status: "paid" },
      });
      expect(Object.keys(u.json)).not.toContain("secret");
    });

    it("rejects filtering, sorting and selecting a non-readable column exactly like a missing one", async () => {
      for (const qs of [
        "secret=eq.S-1",
        "order=secret.asc",
        "select=id,secret",
        "paid=eq.false",
        "meta=is.null",
      ]) {
        const hidden = await call(app, "GET", `/orders?${qs}`, { user: "u1" });
        const missing = await call(
          app,
          "GET",
          `/orders?${qs.replace(/secret|paid|meta/, "nonexistent")}`,
          { user: "u1" },
        );
        expect(hidden.status, qs).toBe(400);
        expect(hidden.json, qs).toEqual(missing.json);
      }
      expect((await call(app, "GET", `/orders/${mine}?select=secret`, { user: "u1" })).status).toBe(
        400,
      );
    });

    it("rejects writing a column outside the write allow-lists", async () => {
      expect(
        (await call(app, "POST", "/orders", { user: "u1", body: { total: 1, secret: "x" } }))
          .status,
      ).toBe(400);
      expect(
        (await call(app, "POST", "/orders", { user: "u1", body: { total: 1, user_id: "u2" } }))
          .status,
      ).toBe(400);
      expect(
        (await call(app, "PATCH", `/orders/${mine}`, { user: "u1", body: { note: "x" } })).status,
      ).toBe(400);
    });
  });

  describe("tables without read", () => {
    it("returns no body for writes", async () => {
      const wo = await makeApp<any, TestEnv>(t, { orders: { operations: ["create", "update"] } });
      const c = await call(wo, "POST", "/orders", { body: { user_id: "u1", total: 3 } });
      expect(c.status).toBe(201);
      expect(c.text).toBe("");
      const u = await call(wo, "PATCH", `/orders/${mine}`, { body: { total: 4 } });
      expect(u.status).toBe(204);
      expect(u.text).toBe("");
      expect((await call(wo, "GET", "/orders")).status).toBe(404);
    });
  });

  describe("scope forms", () => {
    it("supports in / is / multiple operators and true", async () => {
      const a = await makeApp(t, {
        orders: {
          operations: ["read"],
          scope: () => ({ user_id: { in: ["u1", "u2"] }, note: { is: "not_null" } }),
        },
      });
      expect((await call(a, "GET", "/orders")).json).toHaveLength(2);
      const b = await makeApp(t, {
        orders: { operations: ["read"], scope: () => ({ total: { gte: 2, lt: 3 } }) },
      });
      expect((await call(b, "GET", "/orders")).json).toHaveLength(1);
      const all = await makeApp(t, {
        orders: { operations: ["read"], scope: async () => true as const },
      });
      expect((await call(all, "GET", "/orders")).json).toHaveLength(2);
      const bad = await makeApp(t, {
        orders: { operations: ["read"], scope: () => ({ nope: { eq: 1 } }) },
      });
      expect((await call(bad, "GET", "/orders")).status).toBe(500);
    });
  });
});
