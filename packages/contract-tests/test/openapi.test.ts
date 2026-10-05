import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { SchemaMeta } from "@yuiitsu/core";
import { call, makeApp } from "./support/app";
import { DIALECTS, makeTarget, type DialectName, type Target } from "./support/targets";

const ALL = ["read", "create", "update", "delete"] as const;

const docOf = async (app: Awaited<ReturnType<typeof makeApp>>): Promise<any> => {
  app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "API", version: "1.0.0" } });
  return (await app.request("/openapi.json")).json();
};

const validatorFor = (doc: any, schema: unknown) => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile({ ...(schema as object), components: doc.components } as never);
};
const resolve = (doc: any, ref: string) => doc.components.schemas[ref.split("/").pop()!];

const config = {
  orders: {
    operations: [...ALL],
    columns: {
      read: ["id", "user_id", "status", "total", "note", "paid", "meta", "score", "created_at"],
      create: ["user_id", "status", "total", "note", "paid", "meta", "score", "created_at"],
      update: ["status", "total", "note", "meta"],
    },
  },
  stock: { operations: ["read", "update"] },
  tags: { operations: ["read"] },
} as const;

describe.each(DIALECTS)("OpenAPI (%s)", (name) => {
  let t: Target;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let doc: any;

  beforeAll(async () => {
    t = await makeTarget(name);
    app = await makeApp(t, config as never, { openapi: { security: [{ bearerAuth: [] }] } });
    doc = await docOf(app);
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("is a valid OpenAPI document that includes mounted routes with their prefix", async () => {
    await SwaggerParser.validate(JSON.parse(JSON.stringify(doc)));
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/orders",
      "/api/orders/{id}",
      "/api/stock",
      "/api/stock/{id}",
      "/api/tags",
    ]);
  });

  it("only documents exposed tables, operations and columns", () => {
    expect(Object.keys(doc.paths["/api/orders"]).sort()).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths["/api/orders/{id}"]).sort()).toEqual(["delete", "get", "patch"]);
    expect(Object.keys(doc.paths["/api/stock"])).toEqual(["get"]);
    expect(Object.keys(doc.paths["/api/stock/{id}"]).sort()).toEqual(["get", "patch"]);
    expect(Object.keys(doc.paths["/api/tags"])).toEqual(["get"]);
    expect(JSON.stringify(doc)).not.toMatch(/audit_log|fk_child/);
    expect(Object.keys(doc.components.schemas.Orders.properties)).not.toContain("secret");
    const names = doc.paths["/api/orders"].get.parameters.map((p: any) => p.name);
    expect(names).not.toContain("secret");
    expect(names.sort()).toEqual(
      [
        "created_at",
        "id",
        "limit",
        "meta",
        "note",
        "offset",
        "order",
        "paid",
        "score",
        "select",
        "status",
        "total",
        "user_id",
      ].sort(),
    );
  });

  it("describes create / update schemas strictly", () => {
    const create = doc.components.schemas.OrdersCreate;
    expect(create.additionalProperties).toBe(false);
    expect(new Set(create.required)).toEqual(new Set(["total", "user_id"]));
    expect(create.properties.id).toBeUndefined();
    const update = doc.components.schemas.OrdersUpdate;
    expect(update.additionalProperties).toBe(false);
    expect(update.minProperties).toBe(1);
    expect(update.required ?? []).toEqual([]);
    expect(doc.components.schemas.Orders.additionalProperties).toBe(false);
  });

  it("matches runtime for required fields of the create schema", async () => {
    for (const body of [{ user_id: "a" }, { total: 1 }]) {
      expect((await call(app, "POST", "/orders", { body })).status).toBe(400);
    }
    expect((await call(app, "POST", "/orders", { body: { user_id: "a", total: 1 } })).status).toBe(
      201,
    );
  });

  it("types {id} from the primary key and applies the security setting", () => {
    const p = doc.paths["/api/orders/{id}"].get.parameters.find((x: any) => x.name === "id");
    expect(p.in).toBe("path");
    expect(p.schema.type).toBe("integer");
    for (const path of Object.values<any>(doc.paths)) {
      for (const op of Object.values<any>(path)) expect(op.security).toEqual([{ bearerAuth: [] }]);
    }
    expect(doc.paths["/api/orders"].get.tags).toEqual(["orders"]);
    expect(doc.paths["/api/tags"].get.description).toMatch(/no primary key/);
  });

  it("real responses conform to the response schemas", async () => {
    await t.reset();
    const created = await call(app, "POST", "/orders", {
      body: {
        user_id: "a",
        total: 3,
        meta: { x: [1] },
        score: 1.5,
        note: "n",
        created_at: "2026-01-01T00:00:00+09:00",
      },
    });
    expect(created.status, created.text).toBe(201);
    await t.db.insertInto("tags").values({ label: "x", n: null }).execute();
    await t.db.insertInto("stock").values({ sku: "k", qty: 2 }).execute();
    const stock = (await call(app, "GET", "/stock")).json[0];

    const check = (path: string, method: string, status: string, value: unknown) => {
      const resp = doc.paths[path][method].responses[status];
      const schema = resp.content["application/json"].schema;
      const validate = validatorFor(doc, schema);
      expect(
        validate(value),
        JSON.stringify({ path, method, errors: validate.errors, value }),
      ).toBe(true);
    };
    check("/api/orders", "post", "201", created.json);
    check("/api/orders", "get", "200", (await call(app, "GET", "/orders")).json);
    check(
      "/api/orders/{id}",
      "get",
      "200",
      (await call(app, "GET", `/orders/${created.json.id}`)).json,
    );
    const patched = await call(app, "PATCH", `/orders/${created.json.id}`, {
      body: { note: null },
    });
    check("/api/orders/{id}", "patch", "200", patched.json);
    check("/api/tags", "get", "200", (await call(app, "GET", "/tags")).json);
    const sp = await call(app, "PATCH", `/stock/${stock.id}`, { body: { qty: 5 } });
    expect(sp.status).toBe(200);
    check("/api/stock/{id}", "patch", "200", sp.json);
    const err = await call(app, "GET", "/orders/999999");
    check("/api/orders/{id}", "get", "404", err.json);
    const bad = await call(app, "GET", "/orders?bogus=eq.1");
    check("/api/orders", "get", "400", bad.json);
    // 文書化された入力スキーマが、実際に受け付ける入力を受け付ける
    const createSchema = validatorFor(doc, doc.components.schemas.OrdersCreate);
    expect(createSchema({ user_id: "a", total: 3, meta: { x: [1] } })).toBe(true);
    expect(createSchema({ user_id: "a" })).toBe(false);
    expect(createSchema({ user_id: "a", total: 3, id: 1 })).toBe(false);
    expect(resolve(doc, "#/components/schemas/Error").required).toEqual(["error"]);
  });
});

describe("OpenAPI is identical across dialects for the same schema and settings", () => {
  const targets: Target[] = [];
  const docs: Partial<Record<DialectName, any>> = {};
  beforeAll(async () => {
    for (const n of DIALECTS) {
      const t = await makeTarget(n);
      targets.push(t);
      docs[n] = await docOf(await makeApp(t, config as never));
    }
  });
  afterAll(async () => {
    for (const t of targets) await t.teardown();
  });

  it("has the same definition for postgres, mysql and sqlite", () => {
    expect(docs.mysql).toEqual(docs.postgres);
    expect(docs.sqlite).toEqual(docs.postgres);
  });

  it("differs only where decisions.md says so (uuid format on MySQL)", async () => {
    const make = async (n: DialectName, ddl: string) => {
      const t = await makeTarget(n, [ddl]);
      targets.push(t);
      return docOf(await makeApp(t, { uuids: { operations: ["read"] } } as never));
    };
    const pg = await make("postgres", "create table uuids (id uuid primary key, label text)");
    const my = await make(
      "mysql",
      "create table uuids (id char(36) primary key, label varchar(10)) engine=InnoDB",
    );
    const lite = await make("sqlite", "create table uuids (id uuid primary key, label text)");
    expect(pg.components.schemas.Uuids.properties.id.format).toBe("uuid");
    expect(lite.components.schemas.Uuids.properties.id.format).toBe("uuid");
    expect(my.components.schemas.Uuids.properties.id.format).toBeUndefined();
  });
});

// 型だけの確認用(SchemaMeta の import が未使用にならないように)
export type _Unused = SchemaMeta;
