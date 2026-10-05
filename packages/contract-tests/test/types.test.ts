import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { NormalizedType, TableMeta } from "@yuiitsu/core";
import { call, makeApp } from "./support/app";
import { DIALECTS, makeTarget, type DialectName, type Target } from "./support/targets";

const TYPED_DDL: Record<DialectName, string[]> = {
  postgres: [
    `create type mood as enum ('happy', 'sad')`,
    `create table typed (
      id bigint primary key, big bigint, i2 smallint, f4 real, f8 double precision,
      ts timestamp, d date, tm time, num numeric(10,2), uid uuid, j json, jb jsonb,
      t text, v varchar(10), c char(3), b bool, tz timestamptz(3), arr integer[], bin bytea, m mood
    )`,
  ],
  mysql: [
    `create table typed (
      id bigint primary key, big bigint, ti tinyint, tb tinyint(1), b boolean, f float, d double,
      tz timestamp(3) null, dt datetime, dd date, tm time, yr year, num decimal(10,2), j json,
      t text, v varchar(10), c char(3), bin binary(16), blb blob, en enum('a','b'), bits bit(3)
    ) engine=InnoDB`,
  ],
  sqlite: [
    `create table typed (
      id int primary key, big bigint, n_int int, r real, b boolean, bo bool, dt datetime, tz timestamp,
      d date, num numeric, dec decimal(10,2), j json, t text, v varchar(10), u uuid, bl blob, anything
    )`,
  ],
};

const EXPECTED: Record<DialectName, Record<string, NormalizedType>> = {
  postgres: {
    id: "integer",
    big: "integer",
    i2: "integer",
    f4: "number",
    f8: "number",
    ts: "unknown",
    d: "unknown",
    tm: "unknown",
    num: "unknown",
    uid: "uuid",
    j: "json",
    jb: "json",
    t: "text",
    v: "text",
    c: "text",
    b: "boolean",
    tz: "datetime",
    arr: "unknown",
    bin: "unknown",
    m: "unknown",
  },
  mysql: {
    id: "integer",
    big: "integer",
    ti: "integer",
    tb: "boolean",
    b: "boolean",
    f: "number",
    d: "number",
    tz: "datetime",
    dt: "unknown",
    dd: "unknown",
    tm: "unknown",
    yr: "unknown",
    num: "unknown",
    j: "json",
    t: "text",
    v: "text",
    c: "text",
    bin: "unknown",
    blb: "unknown",
    en: "unknown",
    bits: "unknown",
  },
  sqlite: {
    id: "integer",
    big: "integer",
    n_int: "integer",
    r: "number",
    b: "boolean",
    bo: "boolean",
    dt: "datetime",
    tz: "datetime",
    d: "unknown",
    num: "unknown",
    dec: "unknown",
    j: "json",
    t: "text",
    v: "text",
    u: "uuid",
    bl: "unknown",
    anything: "unknown",
  },
};

describe.each(DIALECTS)("type normalization and introspection (%s)", (name) => {
  let t: Target;
  let typed: TableMeta;

  beforeAll(async () => {
    t = await makeTarget(name, TYPED_DDL[name]);
    const schema = await t.dialect.introspect(t.db, { pgSchema: t.pgSchema });
    typed = schema.tables.find((x) => x.name === "typed")!;
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("normalizes native types as specified (6.4.2)", () => {
    const actual = Object.fromEntries(typed.columns.map((c) => [c.name, c.type]));
    expect(actual).toEqual(EXPECTED[name]);
  });

  it("timezone-less datetime types are unknown (never datetime)", () => {
    const naive = { postgres: ["ts", "d", "tm"], mysql: ["dt", "dd", "tm", "yr"], sqlite: ["d"] }[
      name
    ];
    for (const n of naive) expect(typed.columns.find((c) => c.name === n)!.type).toBe("unknown");
  });

  it("detects primary keys, auto increment, generated columns and foreign keys", async () => {
    const schema = await t.dialect.introspect(t.db, { pgSchema: t.pgSchema });
    const orders = schema.tables.find((x) => x.name === "orders")!;
    expect(orders.primaryKey).toEqual(["id"]);
    const id = orders.columns.find((c) => c.name === "id")!;
    expect(id).toMatchObject({
      isAutoIncrement: true,
      isGenerated: true,
      hasDefault: true,
      nullable: false,
    });
    const status = orders.columns.find((c) => c.name === "status")!;
    expect(status).toMatchObject({ isAutoIncrement: false, hasDefault: true });
    expect(orders.columns.find((c) => c.name === "user_id")).toMatchObject({
      hasDefault: false,
      nullable: false,
    });
    expect(schema.tables.find((x) => x.name === "tags")!.primaryKey).toEqual([]);
    const child = schema.tables.find((x) => x.name === "fk_child")!;
    expect(child.foreignKeys).toHaveLength(1);
    expect(child.foreignKeys[0]).toMatchObject({
      columns: ["parent_id"],
      refTable: "fk_parent",
      refColumns: ["id"],
    });
  });

  it("only lists base tables of the target schema", async () => {
    await t.exec([`create view v_orders as select id from orders`]);
    const schema = await t.dialect.introspect(t.db, { pgSchema: t.pgSchema });
    expect(schema.tables.some((x) => x.name === "v_orders")).toBe(false);
    expect(schema.tables.some((x) => x.name.startsWith("sqlite_"))).toBe(false);
    expect(schema.dialect).toBe(name);
    if (name === "postgres") expect(schema.tables.every((x) => x.schema === t.pgSchema)).toBe(true);
    if (name === "sqlite") expect(schema.tables.every((x) => x.schema === null)).toBe(true);
    await t.exec([`drop view v_orders`]);
  });

  it("introspection output is plain JSON (usable as options.schema)", async () => {
    const schema = await t.dialect.introspect(t.db, { pgSchema: t.pgSchema });
    const app = await makeApp(
      t,
      { orders: { operations: ["read"] } },
      { schema: JSON.parse(JSON.stringify(schema)) },
    );
    expect((await call(app, "GET", "/orders")).status).toBe(200);
  });

  describe("reading and writing", () => {
    beforeEach(async () => {
      await sql.raw("delete from typed").execute(t.db);
    });

    it("exposes unknown columns read-only and refuses to write them", async () => {
      const writable = Object.entries(EXPECTED[name])
        .filter(([, ty]) => ty !== "unknown")
        .map(([n]) => n);
      const app = await makeApp(t, { typed: { operations: ["read", "create", "update"] } });
      const unknownCol = Object.entries(EXPECTED[name]).find(([, ty]) => ty === "unknown")![0];
      const r = await call(app, "POST", "/typed", { body: { id: 1, [unknownCol]: "x" } });
      expect(r.status).toBe(400);
      expect(writable).toContain("id");
      // 起動時の検証: unknown カラムを書き込み用に指定するとエラー
      await expect(
        makeApp(t, {
          typed: { operations: ["create"], columns: { create: [unknownCol as never] } },
        }),
      ).rejects.toThrow(/unsupported type/);
    });

    it("round-trips json, booleans, numbers and datetimes", async () => {
      const app = await makeApp(t, { typed: { operations: ["read", "create", "update"] } });
      const body: Record<string, unknown> = { id: 1, j: { a: [1, "x", null], b: { c: true } } };
      if (name === "postgres")
        Object.assign(body, {
          b: true,
          f8: 1.25,
          tz: "2026-03-04T05:06:07.089Z",
          jb: [1, 2],
          i2: -5,
        });
      if (name === "mysql")
        Object.assign(body, {
          b: true,
          tb: false,
          d: 1.25,
          tz: "2026-03-04T05:06:07.089Z",
          ti: -5,
        });
      if (name === "sqlite")
        Object.assign(body, {
          b: true,
          bo: false,
          r: 1.25,
          tz: "2026-03-04T05:06:07.089Z",
          n_int: -5,
        });
      const c = await call(app, "POST", "/typed", { body });
      expect(c.status, c.text).toBe(201);
      const g = await call(app, "GET", "/typed/1");
      expect(g.json.j).toEqual({ a: [1, "x", null], b: { c: true } });
      expect(g.json.tz).toBe("2026-03-04T05:06:07.089Z");
      expect(g.json.b).toBe(true);
      if (name === "mysql") expect(g.json.tb).toBe(false);
      const u = await call(app, "PATCH", "/typed/1", { body: { j: null, t: "x" } });
      expect(u.json.j).toBeNull();
      const arr = await call(app, "PATCH", "/typed/1", { body: { j: [1, 2, 3] } });
      expect(arr.json.j).toEqual([1, 2, 3]);
      const scalar = await call(app, "PATCH", "/typed/1", { body: { j: "text" } });
      expect(scalar.json.j).toBe("text");
    });

    it("represents unknown columns deterministically", async () => {
      const app = await makeApp(t, { typed: { operations: ["read"] } });
      if (name === "postgres") {
        await sql
          .raw(
            `insert into typed (id, num, d, ts) values (1, 12.50, '2026-01-02', '2026-01-02 03:04:05')`,
          )
          .execute(t.db);
        const g = await call(app, "GET", "/typed/1");
        expect(g.json.num).toBe("12.50");
      }
      if (name === "mysql") {
        await sql
          .raw(`insert into typed (id, num, dt) values (1, 12.50, '2026-01-02 03:04:05')`)
          .execute(t.db);
        const g = await call(app, "GET", "/typed/1");
        expect(g.json.num).toBe("12.50");
        expect(g.status).toBe(200);
      }
      if (name === "sqlite") {
        await sql
          .raw(`insert into typed (id, num, anything) values (1, 12.5, 'free')`)
          .execute(t.db);
        const g = await call(app, "GET", "/typed/1");
        expect(g.json.anything).toBe("free");
      }
    });

    it("rejects stored values that do not match the declared type instead of coercing", async () => {
      if (name === "sqlite") {
        const app = await makeApp(t, { typed: { operations: ["read"] } });
        await sql.raw(`insert into typed (id, tz) values (1, 'not a date')`).execute(t.db);
        expect((await call(app, "GET", "/typed/1")).status).toBe(500);
        await sql.raw(`delete from typed`).execute(t.db);
        await sql.raw(`insert into typed (id, b) values (1, 2)`).execute(t.db);
        expect((await call(app, "GET", "/typed/1")).status).toBe(500);
        await sql.raw(`delete from typed`).execute(t.db);
        await sql.raw(`insert into typed (id, n_int) values (1, 'abc')`).execute(t.db);
        expect((await call(app, "GET", "/typed/1")).status).toBe(500);
      }
      if (name === "mysql") {
        const app = await makeApp(t, { typed: { operations: ["read"] } });
        await sql.raw(`insert into typed (id, tb) values (1, 5)`).execute(t.db);
        expect((await call(app, "GET", "/typed/1")).status).toBe(500);
      }
    });

    it("reads 64-bit values: safe range ok, out of range fails", async () => {
      const app = await makeApp(t, { typed: { operations: ["read"] } });
      await sql
        .raw(
          `insert into typed (id, big) values (1, 9007199254740991), (2, -9007199254740991), (3, 9007199254740992)`,
        )
        .execute(t.db);
      expect((await call(app, "GET", "/typed/1")).json.big).toBe(9007199254740991);
      expect((await call(app, "GET", "/typed/2")).json.big).toBe(-9007199254740991);
      expect((await call(app, "GET", "/typed/3")).status).toBe(500);
    });
  });
});
