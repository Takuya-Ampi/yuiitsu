import { z } from "@hono/zod-openapi";
import { RFC3339_RE, UUID_RE, parseApiDatetime } from "./codec";
import { OPS_BY_TYPE, RESERVED_PARAMS } from "./query";
import type { ColumnMeta, DialectAdapter, NormalizedType } from "./types";

const MAX = Number.MAX_SAFE_INTEGER;

const jsonValue = z.union([
  z.null(),
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

/** 書き込み入力用 */
export function inputSchema(type: NormalizedType, required: boolean): z.ZodType {
  switch (type) {
    case "text":
      return z.string();
    case "integer":
      return z.number().int().min(-MAX).max(MAX);
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "datetime":
      return z
        .string()
        .regex(
          RFC3339_RE,
          "must be an RFC 3339 datetime with offset (millisecond precision at most)",
        )
        .refine((s) => parseApiDatetime(s) !== null, "invalid datetime")
        .openapi({ format: "date-time" } as never);
    case "uuid":
      return z
        .string()
        .regex(UUID_RE, "must be a UUID")
        .openapi({ format: "uuid" } as never);
    case "json":
      // 必須のとき、undefined(キーなし)を拒否するため具体的な JSON 値の union にする
      return required ? jsonValue : z.unknown();
    case "unknown":
      return z.unknown();
  }
}

/** レスポンス用(decodeValue 後の JSON 値) */
export function outputSchema(type: NormalizedType): z.ZodType {
  switch (type) {
    case "text":
      return z.string();
    case "integer":
      return z.number().int().min(-MAX).max(MAX);
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "datetime":
      return z.string().openapi({ format: "date-time" } as never);
    case "uuid":
      return z.string().openapi({ format: "uuid" } as never);
    default:
      return z.unknown();
  }
}

export function pascalCase(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}

const withNull = (s: z.ZodType, c: ColumnMeta) => (c.nullable ? s.nullable() : s);

export function readSchema(name: string, cols: ColumnMeta[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const c of cols) shape[c.name] = withNull(outputSchema(c.type), c);
  return z.object(shape).strict().openapi(pascalCase(name));
}

export function isRequiredOnCreate(c: ColumnMeta): boolean {
  return !c.nullable && !c.hasDefault && !c.isGenerated;
}

export function createSchema(name: string, cols: ColumnMeta[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const c of cols) {
    const required = isRequiredOnCreate(c);
    let s = withNull(inputSchema(c.type, required), c);
    if (!required) s = s.optional();
    shape[c.name] = s;
  }
  return z
    .object(shape)
    .strict()
    .openapi(`${pascalCase(name)}Create`);
}

export function updateSchema(name: string, cols: ColumnMeta[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const c of cols) shape[c.name] = withNull(inputSchema(c.type, false), c).optional();
  return z
    .object(shape)
    .strict()
    .refine((v) => Object.keys(v).length > 0, "at least one property is required")
    .openapi(`${pascalCase(name)}Update`, { minProperties: 1 } as never);
}

export const errorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

export function idSchema(pk: ColumnMeta) {
  const base = z.string().min(1);
  const param = { name: "id", in: "path" };
  switch (pk.type) {
    case "integer":
      return base.openapi({ type: "integer", minimum: -MAX, maximum: MAX, param } as never);
    case "number":
      return base.openapi({ type: "number", param } as never);
    case "uuid":
      return base.openapi({ type: "string", format: "uuid", param } as never);
    case "datetime":
      return base.openapi({ type: "string", format: "date-time", param } as never);
    case "boolean":
      return base.openapi({ type: "boolean", param } as never);
    default:
      return base.openapi({ type: "string", param } as never);
  }
}

function filterDescription(c: ColumnMeta, dialect: DialectAdapter): string {
  const ops = OPS_BY_TYPE[c.type].filter(
    (o) => !((o === "like" || o === "ilike") && !dialect.supportsPatternMatch(c)),
  );
  const parts = ops.map((o) =>
    o === "in" ? "in.(a,b,c)" : o === "is" ? "is.null|is.not_null" : `${o}.<value>`,
  );
  return `Filter on "${c.name}". Format: <op>.<value>. Operators: ${parts.join(", ")}. Multiple filters are combined with AND.`;
}

/** 一覧のクエリ。フィルタは実行時にライブラリの parser が解釈する(OpenAPI 上は任意の文字列として列挙) */
export function listQuerySchema(
  readCols: ColumnMeta[],
  dialect: DialectAdapter,
  limits: { defaultLimit: number; maxLimit: number },
  hasPrimaryKey: boolean,
) {
  const reserved = new Set<string>(RESERVED_PARAMS);
  const loose = (o: Record<string, unknown>) =>
    z
      .any()
      .optional()
      .openapi(o as never);
  const shape: Record<string, z.ZodType> = {
    limit: loose({
      type: "integer",
      minimum: 1,
      maximum: limits.maxLimit,
      default: limits.defaultLimit,
      description: "Page size",
    }),
    offset: loose({ type: "integer", minimum: 0, default: 0, description: "Rows to skip" }),
    order: loose({
      type: "string",
      description: hasPrimaryKey
        ? "Sort: <column>.<asc|desc>[,...]. NULL values sort last. A primary key tie breaker is appended."
        : "Sort: <column>.<asc|desc>[,...]. NULL values sort last. This table has no primary key: without order the row order is not guaranteed.",
    }),
    select: loose({
      type: "string",
      description:
        "Comma separated columns to return. The response contains only the selected columns.",
    }),
  };
  for (const c of readCols) {
    if (reserved.has(c.name)) continue;
    shape[c.name] = loose({ type: "string", description: filterDescription(c, dialect) });
  }
  return z.object(shape);
}

export function selectQuerySchema() {
  return z.object({
    select: z
      .any()
      .optional()
      .openapi({ type: "string", description: "Comma separated columns to return" } as never),
  });
}
