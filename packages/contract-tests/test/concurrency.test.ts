import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { call, makeApp } from "./support/app";
import { DIALECTS, makeTarget, type Target } from "./support/targets";

describe.each(DIALECTS)("concurrent writes (%s)", (name) => {
  let t: Target;
  let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    t = await makeTarget(name);
    app = await makeApp(t, { orders: { operations: ["read", "create", "update", "delete"] } });
  });
  afterAll(async () => {
    await t.teardown();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it("creates in parallel without errors or duplicate keys", async () => {
    const rs = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        call(app, "POST", "/orders", { body: { user_id: `u${i}`, total: i + 1 } }),
      ),
    );
    expect(rs.map((r) => r.status)).toEqual(Array(30).fill(201));
    expect(new Set(rs.map((r) => r.json.id)).size).toBe(30);
  });

  it("serializes updates and deletes of the same row", async () => {
    const c = await call(app, "POST", "/orders", { body: { user_id: "u", total: 1 } });
    const id = c.json.id;
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call(app, "PATCH", `/orders/${id}`, { body: { total: i + 100 } }),
      ),
    );
    expect(rs.map((r) => r.status)).toEqual(Array(20).fill(200));
    const final = (await call(app, "GET", `/orders/${id}`)).json.total;
    expect(final).toBeGreaterThanOrEqual(100);
    const dels = await Promise.all(
      Array.from({ length: 5 }, () => call(app, "DELETE", `/orders/${id}`)),
    );
    const statuses = dels.map((r) => r.status);
    expect(statuses.filter((x) => x === 204)).toHaveLength(1);
    expect(statuses.filter((x) => x === 404)).toHaveLength(4);
  });
});
