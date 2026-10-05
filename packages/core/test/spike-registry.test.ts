import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { describe, expect, it } from "vite-plus/test";

// 10.1: app.route() でマウントしたサブアプリの定義が親の registry に prefix 付きで入るか
describe("spike: sub-app registry merge", () => {
  it("includes mounted sub-app routes with prefix in app.doc31()", async () => {
    const sub = new OpenAPIHono();
    sub.openapi(
      createRoute({
        method: "get",
        path: "/orders",
        responses: {
          200: {
            description: "ok",
            content: {
              "application/json": { schema: z.array(z.object({ id: z.number().int() })) },
            },
          },
        },
      }),
      (c) => c.json([{ id: 1 }], 200),
    );
    const app = new OpenAPIHono();
    app.route("/api", sub);
    app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "t", version: "1" } });
    const res = await app.request("/openapi.json");
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(["/api/orders"]);
    expect((await app.request("/api/orders")).status).toBe(200);
  });
});
