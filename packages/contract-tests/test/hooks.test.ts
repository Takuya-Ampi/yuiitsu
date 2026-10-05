import { HTTPException } from "hono/http-exception";
import type { Generated } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createAutoApi } from "@yuiitsu/core";
import { call, makeApp, type TestEnv } from "./support/app";
import { DIALECTS, makeTarget, type Target } from "./support/targets";

/** kysely-codegen で生成した型の代わり */
interface DB {
  orders: {
    id: Generated<number>;
    user_id: string;
    status: Generated<string>;
    total: number;
    note: string | null;
    secret: string | null;
  };
  stock: { id: Generated<number>; sku: string; qty: number };
  audit_log: { id: Generated<number>; message: string; ref_id: number | null };
}

const count = async (t: Target, table: string, where = "1=1") =>
  Number(
    (
      (
        await sql<{
          n: unknown;
        }>`select count(*) as n from ${sql.table(table)} where ${sql.raw(where)}`.execute(t.db)
      ).rows[0] as any
    ).n,
  );
const stockQty = async (t: Target) =>
  Number(
    (
      (await sql<{ q: unknown }>`select qty as q from stock where sku = 'A'`.execute(t.db))
        .rows[0] as any
    ).q,
  );

describe.each(DIALECTS)("hooks (%s)", (name) => {
  let t: Target;

  beforeAll(async () => {
    t = await makeTarget(name);
  });
  afterAll(async () => {
    await t.teardown();
  });
  beforeEach(async () => {
    await t.reset();
    await t.db.insertInto("stock").values({ sku: "A", qty: 10 }).execute();
    vi.restoreAllMocks();
  });

  it("only calls hooks configured for that table and operation", async () => {
    const calls: string[] = [];
    const app = await makeApp<DB, TestEnv>(t, {
      orders: {
        operations: ["read", "create", "update", "delete"],
        hooks: { beforeCreate: async (_ctx, d) => (calls.push("orders.beforeCreate"), d) },
      },
      stock: { operations: ["read", "create"] },
    });
    await call(app, "POST", "/stock", { body: { sku: "B", qty: 1 } });
    const c = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
    await call(app, "PATCH", `/orders/${c.json.id}`, { body: { total: 2 } });
    await call(app, "DELETE", `/orders/${c.json.id}`);
    expect(calls).toEqual(["orders.beforeCreate"]);
  });

  it("gives after* hooks the full row (including columns outside columns.read)", async () => {
    const seen: any = {};
    const app = await makeApp<DB, TestEnv>(t, {
      orders: {
        operations: ["read", "create", "update", "delete"],
        columns: {
          read: ["id", "status", "total"],
          create: ["total", "secret"],
          update: ["total"],
        },
        hooks: {
          beforeCreate: async (ctx, d) => ({
            ...d,
            status: "created",
            user_id: ctx.c.get("userId"),
          }),
          afterCreate: async (ctx, row) => {
            seen.afterCreate = row;
            seen.table = ctx.table;
          },
          afterCommitCreate: async (_ctx, row) => {
            seen.commitCreate = row;
          },
          beforeUpdate: async (_ctx, id, d) => {
            seen.updateId = id;
            return d;
          },
          afterUpdate: async (_ctx, row) => {
            seen.afterUpdate = row;
          },
          afterCommitUpdate: async (_ctx, row) => {
            seen.commitUpdate = row;
          },
          afterDelete: async (_ctx, row) => {
            seen.afterDelete = row;
          },
          afterCommitDelete: async (_ctx, row) => {
            seen.commitDelete = row;
          },
        },
      },
    });
    const c = await call(app, "POST", "/orders", {
      user: "alice",
      body: { total: 4, secret: "S" },
    });
    expect(c.status, c.text).toBe(201);
    expect(c.json).toEqual({ id: c.json.id, status: "created", total: 4 });
    for (const row of [seen.afterCreate, seen.commitCreate]) {
      expect(row).toMatchObject({ user_id: "alice", status: "created", secret: "S" });
      expect(Number(row.total)).toBe(4);
      expect(Number(row.id)).toBe(c.json.id);
    }
    expect(seen.table).toBe("orders");
    await call(app, "PATCH", `/orders/${c.json.id}`, { body: { total: 5 } });
    expect(Number(seen.updateId)).toBe(c.json.id);
    expect(seen.afterUpdate).toMatchObject({ secret: "S", user_id: "alice" });
    expect(Number(seen.commitUpdate.total)).toBe(5);
    await call(app, "DELETE", `/orders/${c.json.id}`);
    expect(seen.afterDelete).toMatchObject({ secret: "S", user_id: "alice" });
    expect(seen.commitDelete).toMatchObject({ secret: "S" });
  });

  it("maps a NOT NULL violation caused by a hook-provided null to 400", async () => {
    const app = await makeApp<DB, TestEnv>(t, {
      orders: {
        operations: ["create"],
        hooks: { beforeCreate: async (_ctx, d) => ({ ...d, user_id: null as never }) },
      },
    });
    const r = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_value");
  });

  describe("transactions", () => {
    const build = (fail: "before" | "after" | "http" | null) =>
      makeApp<DB, TestEnv>(t, {
        orders: {
          operations: ["read", "create", "update", "delete"],
          hooks: {
            beforeCreate: async (_ctx, d) => {
              if (fail === "before") throw new Error("boom");
              if (fail === "http") throw new HTTPException(422, { message: "rejected by hook" });
              return d;
            },
            afterCreate: async (ctx) => {
              // テーブルを跨ぐ書き込み(同一トランザクション)
              await sql`update stock set qty = qty - 1 where sku = 'A'`.execute(ctx.db);
              if (fail === "after") throw new Error("after failed");
            },
          },
        },
      });

    it("writes across tables atomically", async () => {
      const app = await build(null);
      expect(
        (await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } })).status,
      ).toBe(201);
      expect(await stockQty(t)).toBe(9);
    });

    it("rolls back everything when before* throws", async () => {
      const app = await build("before");
      const r = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
      expect(r.status).toBe(500);
      expect(r.text).not.toContain("boom");
      expect(await count(t, "orders")).toBe(0);
    });

    it("uses the HTTPException status and message", async () => {
      const app = await build("http");
      const r = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
      expect(r.status).toBe(422);
      expect(r.json.error.message).toBe("rejected by hook");
      expect(await count(t, "orders")).toBe(0);
    });

    it("rolls back all tables when after* throws", async () => {
      const app = await build("after");
      const r = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
      expect(r.status).toBe(500);
      expect(r.text).not.toContain("after failed");
      expect(await count(t, "orders")).toBe(0);
      expect(await stockQty(t)).toBe(10);
    });

    it("rolls back updates and deletes when their after* hooks throw", async () => {
      await t.db.insertInto("orders").values({ user_id: "u", total: 1 }).execute();
      const id = Number(
        ((await sql<{ id: unknown }>`select id from orders`.execute(t.db)).rows[0] as any).id,
      );
      const app = await makeApp<DB, TestEnv>(t, {
        orders: {
          operations: ["read", "update", "delete"],
          hooks: {
            afterUpdate: async () => {
              throw new Error("x");
            },
            afterDelete: async () => {
              throw new Error("x");
            },
          },
        },
      });
      expect((await call(app, "PATCH", `/orders/${id}`, { body: { total: 99 } })).status).toBe(500);
      expect((await call(app, "DELETE", `/orders/${id}`)).status).toBe(500);
      expect(await count(t, "orders", "total = 1")).toBe(1);
    });

    it("ctx.db inside before*/after* sees the uncommitted write", async () => {
      let visible = -1;
      const app = await makeApp<DB, TestEnv>(t, {
        orders: {
          operations: ["create"],
          hooks: {
            afterCreate: async (ctx, row) => {
              visible = (
                await ctx.db.selectFrom("orders").select("id").where("id", "=", row.id).execute()
              ).length;
            },
          },
        },
      });
      await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
      expect(visible).toBe(1);
    });
  });

  describe("afterCommit", () => {
    it("runs after commit (the row is visible through a normal connection)", async () => {
      let visible = -1;
      const app = await makeApp<DB, TestEnv>(t, {
        orders: {
          operations: ["create"],
          hooks: {
            afterCommitCreate: async (ctx, row) => {
              visible = (
                await ctx.db.selectFrom("orders").select("id").where("id", "=", row.id).execute()
              ).length;
            },
          },
        },
      });
      expect(
        (await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } })).status,
      ).toBe(201);
      expect(visible).toBe(1);
    });

    it("does not run when the transaction rolls back", async () => {
      const commit = vi.fn(async () => {});
      const app = await makeApp<DB, TestEnv>(t, {
        orders: {
          operations: ["create"],
          hooks: {
            afterCreate: async () => {
              throw new Error("x");
            },
            afterCommitCreate: commit,
          },
        },
      });
      await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
      expect(commit).not.toHaveBeenCalled();
    });

    it("reports a failure to onAfterCommitError without affecting the response or the commit", async () => {
      const reports: any[] = [];
      const app = await makeApp<DB, TestEnv>(
        t,
        {
          orders: {
            operations: ["read", "create"],
            hooks: {
              afterCommitCreate: async () => {
                throw new Error("mail down");
              },
            },
          },
        },
        {
          hooks: {
            onAfterCommitError: (error, info) => {
              reports.push({ error, info });
            },
          },
        },
      );
      const r = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
      expect(r.status).toBe(201);
      expect(await count(t, "orders")).toBe(1);
      expect(reports).toHaveLength(1);
      expect(reports[0].info).toMatchObject({
        table: "orders",
        operation: "create",
        reason: "error",
      });
      expect((reports[0].error as Error).message).toBe("mail down");
      expect(Object.keys(reports[0].info).sort()).toEqual(["c", "operation", "reason", "table"]);
    });

    it("times out, aborts ctx.signal and reports reason=timeout", async () => {
      const reports: any[] = [];
      let signal: AbortSignal | undefined;
      const app = await makeApp<DB, TestEnv>(
        t,
        {
          orders: {
            operations: ["read", "create"],
            hooks: {
              afterCommitCreate: async (ctx) => {
                signal = ctx.signal;
                await new Promise((_, reject) =>
                  ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))),
                );
              },
            },
          },
        },
        {
          hooks: {
            afterCommitTimeoutMs: 50,
            onAfterCommitError: (e, info) => void reports.push({ e, info }),
          },
        },
      );
      const r = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
      expect(r.status).toBe(201);
      expect(signal?.aborted).toBe(true);
      expect(reports).toHaveLength(1);
      expect(reports[0].info.reason).toBe("timeout");
    });

    it("swallows errors thrown by onAfterCommitError itself", async () => {
      const app = await makeApp<DB, TestEnv>(
        t,
        {
          orders: {
            operations: ["create"],
            hooks: {
              afterCommitCreate: async () => {
                throw new Error("x");
              },
            },
          },
        },
        {
          hooks: {
            onAfterCommitError: () => {
              throw new Error("reporter broke");
            },
          },
        },
      );
      expect(
        (await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } })).status,
      ).toBe(201);
    });

    it("logs only table, operation and the error by default (no row values)", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const app = await makeApp<DB, TestEnv>(t, {
        orders: {
          operations: ["create"],
          hooks: {
            afterCommitCreate: async () => {
              throw new Error("boom");
            },
          },
        },
      });
      await call(app, "POST", "/orders", {
        body: { user_id: "private-user", total: 1, secret: "private-secret" },
      }).catch(() => {});
      const logged = JSON.stringify(spy.mock.calls, (_k, v) =>
        v instanceof Error ? v.message : v,
      );
      expect(logged).toContain("orders");
      expect(logged).toContain("create");
      expect(logged).not.toContain("private-");
    });
  });

  it.skipIf(name !== "postgres")(
    "detects (does not hang on) a hook that uses the outer connection with a pool of 1",
    async () => {
      const small = await t.open({ poolSize: 1, acquireTimeoutMs: 300 });
      try {
        const app = await makeApp<DB, TestEnv>({ ...t, db: small } as Target, {
          orders: {
            operations: ["create"],
            hooks: {
              afterCreate: async () => {
                await small.selectFrom("orders").select("id").execute(); // ctx.db ではなく外側の接続(誤用)
              },
            },
          },
        });
        const started = Date.now();
        const r = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
        expect(r.status).toBe(500);
        expect(Date.now() - started).toBeLessThan(5000);
      } finally {
        await small.destroy();
      }
    },
  );
});

// 型付けの確認(tsc で検証する。実行はしない)
export async function typecheckOnly(t: Target) {
  await createAutoApi<DB, TestEnv>({
    db: t.db,
    dialect: t.dialect,
    tables: {
      orders: {
        operations: ["read"],
        columns: {
          read: ["id"],
          // @ts-expect-error 存在しないカラム
          create: ["nope"],
        },
        scope: (c) => ({ user_id: { eq: c.get("userId") } }),
        hooks: {
          beforeCreate: async (ctx, data) => {
            const owner: string = data.user_id;
            ctx.c.get("userId").toUpperCase();
            // @ts-expect-error 存在しないカラム
            void data.nope;
            return { ...data, user_id: owner };
          },
          afterCommitDelete: async (_ctx, row) => {
            const n: number = row.total;
            void n;
          },
        },
      },
    },
  });
  await createAutoApi<DB, TestEnv>({
    db: t.db,
    dialect: t.dialect,
    tables: {
      // @ts-expect-error 存在しないテーブル
      nope: { operations: ["read"] },
    },
  });
  await createAutoApi<DB, TestEnv>({
    db: t.db,
    dialect: t.dialect,
    tables: {
      // @ts-expect-error 存在しないテーブル
      nope: { operations: ["read"] },
    },
  });
}
