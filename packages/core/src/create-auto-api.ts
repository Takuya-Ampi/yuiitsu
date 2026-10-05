import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import { sql } from "kysely";
import type { Kysely, SqlBool } from "kysely";
import { errorBody, forbidden, internal, notFound, toErrorResponse } from "./errors";
import { runAfterCommit } from "./hooks-runner";
import {
  buildWhere,
  parseListQuery,
  parseSelectOnly,
  parseTextValue,
  scopeToConditions,
  type Condition,
  type QueryContext,
} from "./query";
import {
  createSchema,
  errorSchema,
  idSchema,
  listQuerySchema,
  readSchema,
  selectQuerySchema,
  updateSchema,
} from "./schemas";
import { buildRuntimes, resolveLimits, type ResolvedLimits, type TableRuntime } from "./validate";
import type { AutoApiOptions, ColumnMeta, DefaultDB, DialectAdapter, SchemaMeta } from "./types";

/** スキーマ情報を JSON に書き出すための関数 */
export async function introspectSchema(
  db: Kysely<any>,
  dialect: DialectAdapter,
  options: { pgSchema?: string } = {},
): Promise<SchemaMeta> {
  return dialect.introspect(db, options);
}

type AnyContext = Context<any>;

const jsonContent = (schema: z.ZodType) => ({ "application/json": { schema } });
const errorResponse = (description: string) => ({ description, content: jsonContent(errorSchema) });

export async function createAutoApi<DB = DefaultDB, E extends Env = Env>(
  options: AutoApiOptions<DB, E>,
): Promise<OpenAPIHono<E>> {
  const { db, dialect } = options;
  const limits = resolveLimits(options.limits);
  const afterCommitTimeoutMs = options.hooks?.afterCommitTimeoutMs ?? 5000;
  const warn = options.onWarning ?? ((m: string) => console.warn(`[autoapi] ${m}`));

  const schema = options.schema ?? (await dialect.introspect(db, { pgSchema: options.pgSchema }));
  if (schema.dialect !== dialect.name) {
    throw new Error(
      `schema was generated for ${schema.dialect} but the dialect is ${dialect.name}`,
    );
  }
  const { runtimes, warnings } = buildRuntimes(
    options as AutoApiOptions<any, any>,
    schema,
    dialect,
  );
  const exposesDatetime = runtimes.some((r) => r.readCols.some((c) => c.type === "datetime"));
  warnings.push(...(await dialect.preflight(db, { exposesDatetime })));
  for (const w of warnings) warn(w);

  const api = new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = (result.error as z.ZodError).issues
          .map((i) => `${i.path.length > 0 ? i.path.join(".") : "request"}: ${i.message}`)
          .join("; ");
        return c.json(errorBody("validation_error", message), 400);
      }
    },
  });
  // 自動生成ルートのエラー処理は、利用者のアプリの onError に依存せず、ここで完結させる
  api.onError((error, c) => toErrorResponse(error, dialect, c));

  const tagsOf = (table: string) => {
    const t = options.openapi?.tags;
    return typeof t === "function" ? t(table) : (t ?? [table]);
  };
  const security = options.openapi?.security;
  const register = (
    route: ReturnType<typeof createRoute>,
    handler: (c: AnyContext) => Promise<Response>,
  ) => {
    (api as OpenAPIHono<any>).openapi(route as never, handler as never);
  };

  for (const rt of runtimes) {
    registerTable({
      rt,
      options: options as AutoApiOptions<any, any>,
      limits,
      afterCommitTimeoutMs,
      register,
      tagsOf,
      security,
    });
  }
  return api;
}

type Registrar = (
  route: ReturnType<typeof createRoute>,
  handler: (c: AnyContext) => Promise<Response>,
) => void;

function registerTable(args: {
  rt: TableRuntime;
  options: AutoApiOptions<any, any>;
  limits: ResolvedLimits;
  afterCommitTimeoutMs: number;
  register: Registrar;
  tagsOf: (table: string) => string[];
  security: Array<Record<string, string[]>> | undefined;
}) {
  const { rt, options, limits, afterCommitTimeoutMs, register, tagsOf, security } = args;
  const { dialect, db } = options;
  const caps = dialect.capabilities;
  const hooks = (rt.config.hooks ?? {}) as Record<
    string,
    ((...a: any[]) => Promise<any>) | undefined
  >;
  const base = `/${rt.name}`;
  const tags = tagsOf(rt.name);
  const hasRead = rt.ops.has("read");
  const pk = rt.pk;
  const allColumns = rt.byName;

  const qc: QueryContext = { dialect, readable: rt.readMap, limits };
  const tbl = (d: Kysely<any>) => (rt.meta.schema ? d.withSchema(rt.meta.schema) : d);

  const readSch = readSchema(rt.name, rt.readCols);
  const common = { tags, ...(security ? { security } : {}) };
  const errs = {
    400: errorResponse("Invalid request"),
    500: errorResponse("Internal server error"),
  };

  // ---- 共通の処理 -----------------------------------------------------------

  const evalScope = async (c: AnyContext): Promise<Condition[] | null> => {
    const fn = rt.config.scope;
    if (!fn) return null;
    // scope が例外を投げたら処理を中止する(全行を対象にするフォールバックはしない)
    const result = await fn(c);
    return scopeToConditions(result, allColumns, dialect);
  };

  const idCondition = (value: unknown): Condition => ({
    column: pk!.name,
    type: pk!.type,
    op: "eq",
    value,
  });

  const parseId = (c: AnyContext): unknown => {
    const raw = c.req.param("id") as string;
    return dialect.encodeValue(pk!.type, parseTextValue(pk!.type, raw, "id"));
  };

  const toApiRow = (row: Record<string, unknown>, cols: ColumnMeta[]) => {
    const out: Record<string, unknown> = {};
    for (const col of cols) out[col.name] = dialect.decodeValue(col.type, row[col.name]);
    return out;
  };

  const pkWhere = (scope: Condition[] | null, value: unknown) => (eb: any) =>
    buildWhere(eb, dialect, { scope, extra: [idCondition(value)] })!;

  /** 書き込み後の行が scope を満たすか、同一トランザクション内で確認する(満たさなければ 403) */
  const assertInScope = async (
    trx: Kysely<any>,
    scope: Condition[] | null,
    row: Record<string, unknown>,
  ) => {
    if (!scope || scope.length === 0) return;
    const found = await tbl(trx)
      .selectFrom(rt.name)
      .select(pk!.name)
      .where(pkWhere(scope, row[pk!.name]))
      .executeTakeFirst();
    if (!found) throw forbidden();
  };

  /** hook が返した値(DB 側の表現)の再検証 */
  const verifyHookData = (data: unknown, mode: "create" | "update"): Record<string, unknown> => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw internal();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (v === undefined) continue;
      const col = allColumns.get(k);
      if (!col || col.type === "unknown") throw internal();
      if (mode === "update" && k === pk!.name) throw internal();
      if (!dialect.validateDbValue(col.type, v)) throw internal();
      out[k] = v;
    }
    return out;
  };

  const afterCommit = (
    c: AnyContext,
    operation: "create" | "update" | "delete",
    hook: ((ctx: any, row: any) => Promise<void>) | undefined,
    row: unknown,
  ) =>
    runAfterCommit({
      hook,
      c,
      db,
      table: rt.name,
      operation,
      row,
      options: { timeoutMs: afterCommitTimeoutMs, onError: options.hooks?.onAfterCommitError },
    });

  const hookCtx = (c: AnyContext, trx: Kysely<any>) => ({ c, db: trx, table: rt.name });

  // ---- read ---------------------------------------------------------------

  if (hasRead) {
    register(
      createRoute({
        method: "get",
        path: base,
        ...common,
        summary: `List ${rt.name}`,
        description: pk
          ? undefined
          : "This table has no primary key: the row order is not guaranteed unless `order` is given.",
        request: { query: listQuerySchema(rt.readCols, dialect, limits, pk !== null) },
        responses: {
          200: { description: "Rows", content: jsonContent(z.array(readSch)) },
          ...errs,
          503: errorResponse("Service unavailable"),
        },
      }),
      async (c) => {
        const q = parseListQuery(new URL(c.req.url).searchParams, qc);
        const scope = await evalScope(c);
        const selectCols = q.select.map((n) => rt.readMap.get(n)!);
        let qb = tbl(db)
          .selectFrom(rt.name)
          .select(q.select)
          .where(
            (eb) => buildWhere(eb, dialect, { scope, request: q.filters }) ?? sql<SqlBool>`1 = 1`,
          );
        for (const o of q.order) {
          for (const expr of dialect.orderByNullsLast(o.column, o.direction)) qb = qb.orderBy(expr);
        }
        if (pk && !q.order.some((o) => o.column === pk.name)) qb = qb.orderBy(pk.name, "asc");
        const rows = await qb.limit(q.limit).offset(q.offset).execute();
        return c.json(
          rows.map((r) => toApiRow(r, selectCols)),
          200,
        );
      },
    );

    if (pk) {
      register(
        createRoute({
          method: "get",
          path: `${base}/{id}`,
          ...common,
          summary: `Get a ${rt.name} row`,
          request: { params: z.object({ id: idSchema(pk) }), query: selectQuerySchema() },
          responses: {
            200: { description: "Row", content: jsonContent(readSch) },
            ...errs,
            404: errorResponse("Not found"),
          },
        }),
        async (c) => {
          const select = parseSelectOnly(new URL(c.req.url).searchParams, qc);
          const id = parseId(c);
          const scope = await evalScope(c);
          const row = await tbl(db)
            .selectFrom(rt.name)
            .select(select)
            .where(pkWhere(scope, id))
            .executeTakeFirst();
          if (!row) throw notFound();
          return c.json(
            toApiRow(
              row,
              select.map((n) => rt.readMap.get(n)!),
            ),
            200,
          );
        },
      );
    }
  }

  // ---- create -------------------------------------------------------------

  if (rt.ops.has("create") && pk) {
    register(
      createRoute({
        method: "post",
        path: base,
        ...common,
        summary: `Create a ${rt.name} row`,
        request: {
          body: { required: true, content: jsonContent(createSchema(rt.name, rt.createCols)) },
        },
        responses: {
          201: hasRead
            ? { description: "Created", content: jsonContent(readSch) }
            : { description: "Created" },
          ...errs,
          403: errorResponse("The created row is outside of the allowed scope"),
          409: errorResponse("Conflict"),
          503: errorResponse("Service unavailable"),
        },
      }),
      async (c) => {
        const body = (c.req as any).valid("json") as Record<string, unknown>;
        const scope = await evalScope(c);
        let data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) {
          data[k] = dialect.encodeValue(allColumns.get(k)!.type, v);
        }
        const { row, response } = await dialect.writeTransaction(db, async (trx) => {
          if (hooks.beforeCreate) data = await hooks.beforeCreate(hookCtx(c, trx), data);
          const values = verifyHookData(data, "create");

          const ins = tbl(trx).insertInto(rt.name);
          const stmt = Object.keys(values).length > 0 ? ins.values(values) : ins.defaultValues();
          let written: Record<string, unknown>;
          if (caps.returning) {
            written = (await stmt.returningAll().executeTakeFirstOrThrow()) as Record<
              string,
              unknown
            >;
          } else {
            // RETURNING 非対応: 同一トランザクション内で主キーを特定し、全カラムを SELECT する
            const res = await stmt.executeTakeFirstOrThrow();
            let pkValue: unknown = values[pk.name];
            if (pkValue === undefined) {
              const id = res.insertId;
              if (!pk.isAutoIncrement || id === undefined || id === 0n) throw internal();
              pkValue = id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString();
            }
            const fetched = await tbl(trx)
              .selectFrom(rt.name)
              .selectAll()
              .where(pkWhere(null, pkValue))
              .executeTakeFirst();
            if (!fetched) throw internal();
            written = fetched as Record<string, unknown>;
          }
          await assertInScope(trx, scope, written);
          if (hooks.afterCreate) await hooks.afterCreate(hookCtx(c, trx), written);
          return { row: written, response: hasRead ? toApiRow(written, rt.readCols) : null };
        });
        await afterCommit(c, "create", hooks.afterCommitCreate, row);
        return response ? c.json(response, 201) : c.body(null, 201);
      },
    );
  }

  // ---- update -------------------------------------------------------------

  if (rt.ops.has("update") && pk) {
    register(
      createRoute({
        method: "patch",
        path: `${base}/{id}`,
        ...common,
        summary: `Update a ${rt.name} row`,
        request: {
          params: z.object({ id: idSchema(pk) }),
          body: { required: true, content: jsonContent(updateSchema(rt.name, rt.updateCols)) },
        },
        responses: {
          ...(hasRead
            ? { 200: { description: "Updated", content: jsonContent(readSch) } }
            : { 204: { description: "Updated" } }),
          ...errs,
          403: errorResponse("The updated row is outside of the allowed scope"),
          404: errorResponse("Not found"),
          409: errorResponse("Conflict"),
          503: errorResponse("Service unavailable"),
        },
      }),
      async (c) => {
        const body = (c.req as any).valid("json") as Record<string, unknown>;
        const id = parseId(c);
        const scope = await evalScope(c);
        let data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) {
          data[k] = dialect.encodeValue(allColumns.get(k)!.type, v);
        }
        const { row, response } = await dialect.writeTransaction(db, async (trx) => {
          if (hooks.beforeUpdate) data = await hooks.beforeUpdate(hookCtx(c, trx), id, data);
          const values = verifyHookData(data, "update");
          if (Object.keys(values).length === 0) throw internal();

          const upd = tbl(trx).updateTable(rt.name).set(values).where(pkWhere(scope, id));
          let written: Record<string, unknown>;
          if (caps.returning) {
            const r = await upd.returningAll().executeTakeFirst();
            if (!r) throw notFound();
            written = r as Record<string, unknown>;
          } else {
            // 一致した行数で判定する(mysql2 の CLIENT_FOUND_ROWS が前提)
            const res = await upd.executeTakeFirstOrThrow();
            if (res.numUpdatedRows === 0n) throw notFound();
            const fetched = await tbl(trx)
              .selectFrom(rt.name)
              .selectAll()
              .where(pkWhere(null, id))
              .executeTakeFirst();
            if (!fetched) throw internal();
            written = fetched as Record<string, unknown>;
          }
          await assertInScope(trx, scope, written);
          if (hooks.afterUpdate) await hooks.afterUpdate(hookCtx(c, trx), written);
          return { row: written, response: hasRead ? toApiRow(written, rt.readCols) : null };
        });
        await afterCommit(c, "update", hooks.afterCommitUpdate, row);
        return response ? c.json(response, 200) : c.body(null, 204);
      },
    );
  }

  // ---- delete -------------------------------------------------------------

  if (rt.ops.has("delete") && pk) {
    register(
      createRoute({
        method: "delete",
        path: `${base}/{id}`,
        ...common,
        summary: `Delete a ${rt.name} row`,
        request: { params: z.object({ id: idSchema(pk) }) },
        responses: {
          204: { description: "Deleted" },
          ...errs,
          404: errorResponse("Not found"),
          409: errorResponse("Conflict"),
          503: errorResponse("Service unavailable"),
        },
      }),
      async (c) => {
        const id = parseId(c);
        const scope = await evalScope(c);
        const row = await dialect.writeTransaction(db, async (trx) => {
          if (hooks.beforeDelete) await hooks.beforeDelete(hookCtx(c, trx), id);
          let deleted: Record<string, unknown>;
          if (caps.returning) {
            const r = await tbl(trx)
              .deleteFrom(rt.name)
              .where(pkWhere(scope, id))
              .returningAll()
              .executeTakeFirst();
            if (!r) throw notFound();
            deleted = r as Record<string, unknown>;
          } else {
            // ロック付き SELECT は削除する行の内容を取るためのもの。scope の判断は DELETE の WHERE で行う
            const locked = await tbl(trx)
              .selectFrom(rt.name)
              .selectAll()
              .where(pkWhere(scope, id))
              .forUpdate()
              .executeTakeFirst();
            if (!locked) throw notFound();
            const res = await tbl(trx)
              .deleteFrom(rt.name)
              .where(pkWhere(scope, id))
              .executeTakeFirstOrThrow();
            if (res.numDeletedRows === 0n) throw notFound();
            deleted = locked as Record<string, unknown>;
          }
          if (hooks.afterDelete) await hooks.afterDelete(hookCtx(c, trx), deleted);
          return deleted;
        });
        await afterCommit(c, "delete", hooks.afterCommitDelete, row);
        return c.body(null, 204);
      },
    );
  }
}
