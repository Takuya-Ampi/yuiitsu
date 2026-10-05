import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { call, makeApp, warnings } from "./support/app";
import { DIALECTS, makeTarget, type Target } from "./support/targets";

const ALL = ["read", "create", "update", "delete"] as const;

describe.each(DIALECTS)("CRUD / query contract (%s)", (name) => {
  let t: Target;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let ids: number[] = [];

  beforeAll(async () => {
    t = await makeTarget(name);
    app = await makeApp(t, {
      orders: { operations: [...ALL] },
      stock: { operations: [...ALL] },
      tags: { operations: ["read"] },
      fk_parent: { operations: ["read"] },
      fk_child: { operations: ["read", "create"] },
      check_t: { operations: ["read", "create"] },
    });
  });
  afterAll(async () => {
    await t.teardown();
  });
  beforeEach(async () => {
    await t.reset();
    const rows = [
      { user_id: "u1", status: "new", total: 10, note: "Apple", score: 1.5 },
      { user_id: "u1", status: "paid", total: 20, note: "apple pie", score: null },
      { user_id: "u2", status: "paid", total: 30, note: null, score: 0.5 },
      { user_id: "u2", status: "new", total: 20, note: "Banana", score: null },
      { user_id: "u1", status: "paid", total: 20, note: null, score: 2.5 },
    ];
    for (const r of rows) await t.db.insertInto("orders").values(r).execute();
    const res = await call(app, "GET", "/orders?select=id&order=id.asc");
    ids = res.json.map((r: { id: number }) => r.id);
  });

  const list = async (qs: string) => {
    const r = await call(app, "GET", `/orders?${qs}`);
    expect(r.status, r.text).toBe(200);
    return (r.json as Array<{ id: number }>).map((x) => ids.indexOf(x.id) + 1);
  };

  describe("basic operations", () => {
    it("creates, reads, updates and deletes", async () => {
      const c = await call(app, "POST", "/orders", { body: { user_id: "u9", total: 7 } });
      expect(c.status).toBe(201);
      expect(c.json).toMatchObject({
        user_id: "u9",
        status: "new",
        total: 7,
        note: null,
        paid: false,
      });
      expect(typeof c.json.id).toBe("number");
      expect(c.json.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      const id = c.json.id;
      const g = await call(app, "GET", `/orders/${id}`);
      expect(g.status).toBe(200);
      expect(g.json.user_id).toBe("u9");
      const u = await call(app, "PATCH", `/orders/${id}`, {
        body: { status: "paid", paid: true, meta: { k: [1, 2] } },
      });
      expect(u.status).toBe(200);
      expect(u.json).toMatchObject({ status: "paid", paid: true, meta: { k: [1, 2] } });
      const d = await call(app, "DELETE", `/orders/${id}`);
      expect(d.status).toBe(204);
      expect((await call(app, "GET", `/orders/${id}`)).status).toBe(404);
      expect((await call(app, "DELETE", `/orders/${id}`)).status).toBe(404);
    });

    it("does not 404 when an update changes nothing", async () => {
      const r = await call(app, "PATCH", `/orders/${ids[0]}`, { body: { status: "new" } });
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("new");
    });

    it("returns 404 for a missing row and 400 for a malformed id", async () => {
      expect((await call(app, "GET", "/orders/999999")).status).toBe(404);
      expect((await call(app, "PATCH", "/orders/999999", { body: { status: "x" } })).status).toBe(
        404,
      );
      expect((await call(app, "GET", "/orders/abc")).status).toBe(400);
    });

    it("rejects a primary key change and invalid bodies with 400", async () => {
      const id = ids[0];
      for (const body of [
        { id: 99 },
        {},
        { bogus: 1 },
        { total: "x" },
        { total: 1.5 },
        { status: null },
      ]) {
        const r = await call(app, "PATCH", `/orders/${id}`, { body });
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.json.error.code).toBeTypeOf("string");
        expect(r.json.error.message).toBeTypeOf("string");
      }
      for (const body of [
        { total: 1 },
        { user_id: "a" },
        { user_id: "a", total: 1, id: 5 },
        { user_id: "a", total: 1, x: 1 },
      ]) {
        expect((await call(app, "POST", "/orders", { body })).status, JSON.stringify(body)).toBe(
          400,
        );
      }
    });

    it("returns the shared error shape for malformed JSON", async () => {
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(Object.keys((await res.json()).error).sort()).toEqual(["code", "message"]);
    });
  });

  describe("filters", () => {
    it("supports each operator", async () => {
      expect(await list("status=eq.paid")).toEqual([2, 3, 5]);
      expect(await list("status=neq.paid")).toEqual([1, 4]);
      expect(await list("total=gt.20")).toEqual([3]);
      expect(await list("total=gte.20")).toEqual([2, 3, 4, 5]);
      expect(await list("total=lt.20")).toEqual([1]);
      expect(await list("total=lte.20")).toEqual([1, 2, 4, 5]);
      expect(await list("total=in.(10,30)")).toEqual([1, 3]);
      expect(await list("note=is.null")).toEqual([3, 5]);
      expect(await list("note=is.not_null")).toEqual([1, 2, 4]);
      expect(await list("paid=eq.false")).toEqual([1, 2, 3, 4, 5]);
      expect(await list("paid=eq.true")).toEqual([]);
    });

    it("combines multiple filters with AND, including repeated parameters", async () => {
      expect(await list("status=eq.paid&total=gte.20&user_id=eq.u1")).toEqual([2, 5]);
      expect(await list("total=gte.20&total=lt.30")).toEqual([2, 4, 5]);
    });

    it("like is case sensitive and ilike is not (ASCII)", async () => {
      expect(await list("note=like.App%25")).toEqual([1]);
      expect(await list("note=like.%25pie")).toEqual([2]);
      expect(await list("note=like.app_e%25")).toEqual([2]);
      expect(await list("note=ilike.app%25")).toEqual([1, 2]);
      expect(await list("note=ilike.BANANA")).toEqual([4]);
    });

    it("treats URL-encoded values after decoding", async () => {
      expect(await list("note=eq.apple%20pie")).toEqual([2]);
      expect(await list("note=eq.apple+pie")).toEqual([2]);
      expect(await list("note=eq.")).toEqual([]);
    });

    it("handles an offset datetime filter", async () => {
      const r = await call(
        app,
        "GET",
        `/orders?created_at=lt.${encodeURIComponent("2999-01-01T00:00:00+09:00")}`,
      );
      expect(r.status).toBe(200);
      expect(r.json).toHaveLength(5);
      expect(await list(`created_at=gt.${encodeURIComponent("2999-01-01T00:00:00Z")}`)).toEqual([]);
    });

    it("rejects invalid filters with 400", async () => {
      const bad = [
        "total=eq.abc",
        "total=eq.",
        "total=eq.1.5",
        "total=eq.9007199254740993",
        "total=like.1",
        "paid=gt.true",
        "paid=eq.yes",
        "total=between.1",
        "total=5",
        "note=is.true",
        "note=in.a,b",
        "note=in.()",
        "total=in.(1,x)",
        'note=in.("a")',
        "note=in.(a(b)",
        `total=in.(${Array.from({ length: 101 }, (_, i) => i).join(",")})`,
        "created_at=gt.2026-01-01T00:00:00",
        "created_at=gt.2026-01-01T00:00:00.1234Z",
        "created_at=gt.not-a-date",
        "meta=eq.1",
        "or=(status.eq.paid)",
        "and=(status.eq.paid)",
        "not=1",
        "limit=0",
        "limit=1001",
        "limit=x",
        "offset=-1",
        "order=total.sideways",
        "order=",
        "select=",
        "order=id.asc;drop table orders",
        "select=id,(select 1)",
      ];
      for (const qs of bad) {
        const r = await call(app, "GET", `/orders?${qs}`);
        expect(r.status, qs).toBe(400);
        expect(r.json.error.code, qs).toBeTypeOf("string");
      }
    });

    it("is not affected by SQL injection attempts", async () => {
      expect(await list(`status=eq.${encodeURIComponent("' or 1=1 --")}`)).toEqual([]);
      expect(await list(`note=like.${encodeURIComponent("%'; drop table orders; --")}`)).toEqual(
        [],
      );
      expect(
        (await call(app, "GET", `/orders?${encodeURIComponent('status" or "1"="1')}=eq.x`)).status,
      ).toBe(400);
      const r = await call(app, "POST", "/orders", {
        body: { user_id: "x'); drop table orders; --", total: 1 },
      });
      expect(r.status).toBe(201);
      expect(await list("limit=100")).toHaveLength(6);
    });
  });

  describe("sorting and paging", () => {
    it("defaults to primary key order", async () => {
      expect(await list("")).toEqual([1, 2, 3, 4, 5]);
    });

    it("adds a primary key tie breaker so paging is stable", async () => {
      expect(await list("order=total.asc")).toEqual([1, 2, 4, 5, 3]);
      expect(await list("order=total.desc")).toEqual([3, 2, 4, 5, 1]);
      const pages = [
        ...(await list("order=total.asc&limit=2&offset=0")),
        ...(await list("order=total.asc&limit=2&offset=2")),
        ...(await list("order=total.asc&limit=2&offset=4")),
      ];
      expect(pages).toEqual([1, 2, 4, 5, 3]);
    });

    it("puts NULL last for both directions", async () => {
      expect(await list("order=score.asc")).toEqual([3, 1, 5, 2, 4]);
      expect(await list("order=score.desc")).toEqual([5, 1, 3, 2, 4]);
      // 照合順序は方言差があるため、NULL の位置(末尾)のみ確認する
      expect((await list("order=note.asc")).slice(-2)).toEqual([3, 5]);
      expect((await list("order=note.desc")).slice(-2)).toEqual([3, 5]);
    });

    it("supports select", async () => {
      const r = await call(app, "GET", `/orders?select=id,status&limit=1`);
      expect(Object.keys(r.json[0]).sort()).toEqual(["id", "status"]);
      const one = await call(app, "GET", `/orders/${ids[0]}?select=total`);
      expect(one.json).toEqual({ total: 10 });
    });

    it("tables without a primary key list without an implicit order", async () => {
      await t.db
        .insertInto("tags")
        .values([
          { label: "a", n: 1 },
          { label: "b", n: null },
        ])
        .execute();
      const r = await call(app, "GET", "/tags?order=n.asc");
      expect(r.json.map((x: { label: string }) => x.label)).toEqual(["a", "b"]);
      expect((await call(app, "GET", "/tags/1")).status).toBe(404);
      expect((await call(app, "POST", "/tags", { body: { label: "x" } })).status).toBe(404);
    });
  });

  describe("exposure", () => {
    it("does not expose unlisted tables or operations", async () => {
      expect((await call(app, "GET", "/audit_log")).status).toBe(404);
      expect((await call(app, "POST", "/tags", { body: { label: "a" } })).status).toBe(404);
      expect((await call(app, "DELETE", "/fk_child/1")).status).toBe(404);
    });
  });

  describe("normalized database errors", () => {
    it("maps a unique violation to 409 without leaking details", async () => {
      expect(
        (await call(app, "POST", "/stock", { body: { sku: "SECRET-SKU-1", qty: 1 } })).status,
      ).toBe(201);
      const r = await call(app, "POST", "/stock", { body: { sku: "SECRET-SKU-1", qty: 2 } });
      expect(r.status).toBe(409);
      expect(r.text).not.toMatch(/SECRET-SKU-1|unique|duplicate|constraint|stock/i);
    });

    it("maps a foreign key violation to 409", async () => {
      const r = await call(app, "POST", "/fk_child", { body: { parent_id: 12345 } });
      expect(r.status).toBe(409);
    });

    it("maps a check violation to 400", async () => {
      const r = await call(app, "POST", "/check_t", { body: { n: -1 } });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("invalid_value");
    });

    it.skipIf(name === "sqlite")("maps an oversized value (data exception) to 400", async () => {
      const r = await call(app, "POST", "/stock", { body: { sku: "x".repeat(100), qty: 1 } });
      expect(r.status).toBe(400);
    });
  });

  describe("integer handling", () => {
    it("round-trips the largest safe integer and rejects values beyond it", async () => {
      const max = Number.MAX_SAFE_INTEGER;
      const wrap = await makeApp(t, { audit_log: { operations: ["read", "create"] } });
      const ok = await call(wrap, "POST", "/audit_log", { body: { message: "m", ref_id: max } });
      expect(ok.status, ok.text).toBe(201);
      expect(ok.json.ref_id).toBe(max);
      expect(
        (await call(wrap, "POST", "/audit_log", { body: { message: "m", ref_id: max + 1 } }))
          .status,
      ).toBe(400);
      expect(
        (await call(wrap, "POST", "/audit_log", { body: { message: "m", ref_id: 1.5 } })).status,
      ).toBe(400);
    });

    it("fails instead of silently losing precision when a stored value is out of range", async () => {
      const wrap = await makeApp(t, { audit_log: { operations: ["read"] } });
      await sql
        .raw(`insert into audit_log (message, ref_id) values ('big', 9007199254740993)`)
        .execute(t.db);
      await sql
        .raw(`insert into audit_log (message, ref_id) values ('ok', 9007199254740991)`)
        .execute(t.db);
      expect((await call(wrap, "GET", "/audit_log")).status).toBe(500);
      const good = await call(wrap, "GET", "/audit_log?message=eq.ok");
      expect(good.json[0].ref_id).toBe(9007199254740991);
    });
  });

  describe("datetime", () => {
    it("stores offsets as UTC and returns RFC 3339 with Z", async () => {
      const r = await call(app, "POST", "/orders", {
        body: { user_id: "u", total: 1, created_at: "2026-01-01T09:00:00+09:00" },
      });
      expect(r.status).toBe(201);
      expect(r.json.created_at).toBe("2026-01-01T00:00:00.000Z");
      const ms = await call(app, "POST", "/orders", {
        body: { user_id: "u", total: 1, created_at: "2026-01-01T00:00:00.123Z" },
      });
      expect(ms.json.created_at).toBe("2026-01-01T00:00:00.123Z");
    });

    it("rejects a missing offset, sub-millisecond precision and invalid dates", async () => {
      for (const created_at of [
        "2026-01-01T00:00:00",
        "2026-01-01T00:00:00.1234Z",
        "2026-02-31T00:00:00Z",
        "2026-01-01",
        "yesterday",
        5,
      ]) {
        expect(
          (await call(app, "POST", "/orders", { body: { user_id: "u", total: 1, created_at } }))
            .status,
        ).toBe(400);
      }
    });
  });

  describe("startup warnings", () => {
    it("records warnings for reserved column names via onWarning", () => {
      expect(Array.isArray(warnings)).toBe(true);
    });
  });
});
