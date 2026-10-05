import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { sqliteDialect } from "@yuiitsu/dialect-sqlite";
import { call, makeApp } from "./support/app";
import { makeTarget, type Target } from "./support/targets";

// 16 章: ドライバ・DB の実際の挙動の確認(結果は docs/decisions.md に記録)

describe("PostgreSQL driver / DB assumptions", () => {
  let t: Target;
  beforeAll(async () => {
    t = await makeTarget("postgres");
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("pg returns int8 as string and timestamptz as Date", async () => {
    const r = (
      await sql<any>`select 9007199254740993::int8 as big, now()::timestamptz as ts`.execute(t.db)
    ).rows[0];
    expect(r.big).toBe("9007199254740993");
    expect(r.ts).toBeInstanceOf(Date);
  });

  it("writeTransaction uses READ COMMITTED", async () => {
    const level = await t.dialect.writeTransaction(t.db, async (trx) => {
      return (await sql<any>`show transaction_isolation`.execute(trx)).rows[0]
        .transaction_isolation;
    });
    expect(level).toBe("read committed");
  });
});

describe("MySQL driver / DB assumptions", () => {
  let t: Target;
  beforeAll(async () => {
    t = await makeTarget("mysql");
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("BIGINT arrives as a string (supportBigNumbers + bigNumberStrings)", async () => {
    const r = (
      await sql<any>`select cast(9007199254740993 as signed) as big, cast(5 as signed) as small`.execute(
        t.db,
      )
    ).rows[0];
    expect(r.big).toBe("9007199254740993");
  });

  it("writeTransaction uses READ COMMITTED (a later read sees other transactions' commits)", async () => {
    // @@transaction_isolation は次のトランザクション用の設定を反映しないため、挙動で確認する
    const seen = await t.dialect.writeTransaction(t.db, async (trx) => {
      const count = async () =>
        Number((await sql<any>`select count(*) as n from stock`.execute(trx)).rows[0].n);
      const before = await count();
      await t.db
        .insertInto("stock")
        .values({ sku: `rc-${Date.now()}`, qty: 1 })
        .execute();
      return (await count()) - before;
    });
    expect(seen).toBe(1);
  });

  it("numUpdatedRows counts matched rows (CLIENT_FOUND_ROWS) and insertId is a bigint", async () => {
    const ins = await t.db
      .insertInto("stock")
      .values({ sku: "x", qty: 1 })
      .executeTakeFirstOrThrow();
    expect(typeof ins.insertId).toBe("bigint");
    const same = await t.db
      .updateTable("stock")
      .set({ qty: 1 })
      .where("sku", "=", "x")
      .executeTakeFirstOrThrow();
    expect(same.numUpdatedRows).toBe(1n);
  });

  it("TIMESTAMP round-trips as UTC with timezone Z and session time_zone +00:00", async () => {
    const app = await makeApp(t, { orders: { operations: ["read", "create"] } });
    const c = await call(app, "POST", "/orders", {
      body: { user_id: "u", total: 1, created_at: "2026-06-01T12:34:56.789+09:00" },
    });
    expect(c.json.created_at).toBe("2026-06-01T03:34:56.789Z");
    const raw = (await sql<any>`select cast(created_at as char) as c from orders`.execute(t.db))
      .rows[0];
    expect(raw.c).toBe("2026-06-01 03:34:56.789");
  });

  it("BOOLEAN / TINYINT(1) columns are reported as tinyint(1)", async () => {
    const r = (
      await sql<any>`select COLUMN_TYPE as ct from information_schema.COLUMNS where TABLE_SCHEMA = database() and TABLE_NAME = 'orders' and COLUMN_NAME = 'paid'`.execute(
        t.db,
      )
    ).rows[0];
    expect(r.ct).toBe("tinyint(1)");
  });

  it("COLLATE utf8mb4_0900_as_cs / as_ci behave as expected for LIKE", async () => {
    const q = async (coll: string, pattern: string) =>
      (
        await sql<any>`select ('Äpfel' collate utf8mb4_0900_ai_ci) as v, (${sql.raw(`'Apple' collate ${coll}`)} like ${pattern}) as m`.execute(
          t.db,
        )
      ).rows[0].m;
    expect(Number(await q("utf8mb4_0900_as_cs", "apple"))).toBe(0);
    expect(Number(await q("utf8mb4_0900_as_cs", "Apple"))).toBe(1);
    expect(Number(await q("utf8mb4_0900_as_ci", "apple"))).toBe(1);
    const accent = (
      await sql<any>`select ('cafe' collate utf8mb4_0900_as_ci like 'café') as m`.execute(t.db)
    ).rows[0].m;
    expect(Number(accent)).toBe(0); // アクセントは区別する
  });
});

describe("SQLite driver / DB assumptions", () => {
  let t: Target;
  beforeAll(async () => {
    t = await makeTarget("sqlite");
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("defaultSafeIntegers(true) works through Kysely (integers arrive as bigint)", async () => {
    const r = (await sql<any>`select 9007199254740993 as big`.execute(t.db)).rows[0];
    expect(r.big).toBe(9007199254740993n);
  });

  it("SQLite is 3.37 or newer", async () => {
    const v = String((await sql<any>`select sqlite_version() as v`.execute(t.db)).rows[0].v);
    console.info(`SQLite version: ${v}`);
    const [maj, min] = v.split(".").map(Number);
    expect(maj! > 3 || (maj === 3 && min! >= 37)).toBe(true);
  });

  it("writeTransaction takes the write lock up front (BEGIN IMMEDIATE) so a second writer gets BUSY immediately", async () => {
    const file = join(tmpdir(), `autoapi-busy-${process.pid}-${Date.now()}.db`);
    const open = () => {
      const raw = new Database(file);
      raw.defaultSafeIntegers(true);
      raw.pragma("busy_timeout = 0");
      return new Kysely<any>({ dialect: new SqliteDialect({ database: raw }) });
    };
    const a = open();
    const b = open();
    try {
      await sql`create table if not exists k (id integer primary key, v text)`.execute(a);
      const dialect = sqliteDialect();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const holder = dialect.writeTransaction(a, async () => {
        entered();
        await gate;
      });
      await inside;
      let error: unknown;
      try {
        await dialect.writeTransaction(b, async () => {});
      } catch (e) {
        error = e;
      }
      expect(dialect.normalizeError(error).type).toBe("lock_timeout");
      release();
      await holder;
      await dialect.writeTransaction(b, async (trx) => {
        await sql`insert into k (v) values ('ok')`.execute(trx);
      });
    } finally {
      await a.destroy();
      await b.destroy();
      for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
        try {
          unlinkSync(f);
        } catch {
          // 無ければ良い
        }
      }
    }
  });

  it("maps SQLITE_BUSY to 503 over HTTP", async () => {
    const file = join(tmpdir(), `autoapi-busy2-${process.pid}-${Date.now()}.db`);
    const open = () => {
      const raw = new Database(file);
      raw.defaultSafeIntegers(true);
      raw.pragma("busy_timeout = 0");
      return new Kysely<any>({ dialect: new SqliteDialect({ database: raw }) });
    };
    const a = open();
    const b = open();
    try {
      await sql`create table k (id integer primary key autoincrement, v text not null)`.execute(a);
      const dialect = sqliteDialect();
      const app = await makeApp({ ...t, db: b, dialect } as Target, {
        k: { operations: ["read", "create"] },
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const holder = dialect.writeTransaction(a, async () => {
        entered();
        await gate;
      });
      await inside;
      const r = await call(app, "POST", "/k", { body: { v: "x" } });
      expect(r.status).toBe(503);
      release();
      await holder;
    } finally {
      await a.destroy();
      await b.destroy();
      for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
        try {
          unlinkSync(f);
        } catch {
          // 無ければ良い
        }
      }
    }
  });
});
