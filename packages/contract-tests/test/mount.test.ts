import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createAutoApi } from "@yuiitsu/core";
import { DIALECTS, makeTarget, type Target } from "./support/targets";

describe.each(DIALECTS)("mounting in a user app (%s)", (name) => {
  let t: Target;
  let app: OpenAPIHono;
  const order: string[] = [];

  beforeAll(async () => {
    t = await makeTarget(name);
    app = new OpenAPIHono();
    // 利用者の認証ミドルウェア(マウントより前に登録する)
    app.use("/api/*", async (c, next) => {
      order.push("auth");
      if (c.req.header("authorization") !== "Bearer ok")
        return c.json({ error: { code: "unauthorized", message: "no" } }, 401);
      await next();
    });
    const api = await createAutoApi({
      db: t.db,
      dialect: t.dialect,
      pgSchema: t.pgSchema,
      tables: { orders: { operations: ["read"] } },
      openapi: { tags: (table) => [`tag-${table}`] },
    });
    app.route("/api", api);
    app.get("/health", (c) => c.text("ok"));
    app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "t", version: "1" } });
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("runs user middleware before generated routes", async () => {
    order.length = 0;
    expect((await app.request("/api/orders")).status).toBe(401);
    expect(order).toEqual(["auth"]);
    expect(
      (await app.request("/api/orders", { headers: { authorization: "Bearer ok" } })).status,
    ).toBe(200);
  });

  it("serves generated routes only below the mount path and leaves user routes alone", async () => {
    expect((await app.request("/orders")).status).toBe(404);
    expect(await (await app.request("/health")).text()).toBe("ok");
    expect(
      (await app.request("/api/unknown", { headers: { authorization: "Bearer ok" } })).status,
    ).toBe(404);
  });

  it("applies custom tags", async () => {
    const doc: any = await (await app.request("/openapi.json")).json();
    expect(doc.paths["/api/orders"].get.tags).toEqual(["tag-orders"]);
  });
});
