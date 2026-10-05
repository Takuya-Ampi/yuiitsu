import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";
import { createAutoApi } from "@yuiitsu/core";
import type { AutoApiOptions } from "@yuiitsu/core";
import type { Target } from "./targets";

export type TestEnv = { Variables: { userId: string } };

export const warnings: string[] = [];

/** 利用者のアプリ想定: 認証ミドルウェア(ここでは x-user ヘッダ)を登録してからマウントする */
export async function makeApp<DB = any, E extends Env = TestEnv>(
  target: Target,
  tables: AutoApiOptions<DB, E>["tables"],
  extra: Partial<AutoApiOptions<DB, E>> = {},
) {
  const app = new OpenAPIHono<E>();
  app.use("/api/*", async (c, next) => {
    const u = c.req.header("x-user");
    if (u) (c as any).set("userId", u);
    await next();
  });
  const api = await createAutoApi<DB, E>({
    db: target.db,
    dialect: target.dialect,
    pgSchema: target.pgSchema,
    onWarning: (m) => warnings.push(m),
    tables,
    ...extra,
  } as AutoApiOptions<DB, E>);
  app.route("/api", api);
  return app as unknown as OpenAPIHono<any>;
}

export async function call(
  app: OpenAPIHono<any>,
  method: string,
  path: string,
  opts: { body?: unknown; user?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.user) headers["x-user"] = opts.user;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await app.request(`/api${path}`, { method, headers, body });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}
