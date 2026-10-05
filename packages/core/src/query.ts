import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import { badRequest, unknownColumn } from "./errors";
import { UUID_RE, parseApiDatetime, formatDatetime } from "./codec";
import type { ColumnMeta, DialectAdapter, FilterOp, NormalizedType, ScopeFilter } from "./types";

export const RESERVED_PARAMS = ["order", "limit", "offset", "select", "and", "or", "not"] as const;
const NESTED_RESERVED = new Set(["and", "or", "not"]);
const LIST_PARAMS = new Set(["order", "limit", "offset", "select"]);

export type Condition = {
  column: string;
  type: NormalizedType;
  op: FilterOp | "is_null" | "is_not_null";
  /** DB 側の表現(encodeValue 済み)。in は配列 */
  value: unknown;
};

export const OPS_BY_TYPE: Record<NormalizedType, FilterOp[]> = {
  text: ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is"],
  integer: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is"],
  boolean: ["eq", "neq", "is"],
  datetime: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is"],
  uuid: ["eq", "neq", "in", "is"],
  json: ["is"],
  unknown: ["is"],
};

const ALL_OPS = new Set<string>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "in",
  "is",
]);

/** クエリ文字列の値(文字列)を、API 上の JSON 値(型に応じた値)へ */
export function parseTextValue(type: NormalizedType, raw: string, what = "value"): unknown {
  switch (type) {
    case "text":
      return raw;
    case "integer": {
      if (!/^-?\d+$/.test(raw)) throw badRequest(`Invalid integer ${what}`, "invalid_value");
      const n = Number(raw);
      if (!Number.isSafeInteger(n))
        throw badRequest(`Integer ${what} out of range`, "invalid_value");
      return n;
    }
    case "number": {
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw))
        throw badRequest(`Invalid number ${what}`, "invalid_value");
      const n = Number(raw);
      if (!Number.isFinite(n)) throw badRequest(`Invalid number ${what}`, "invalid_value");
      return n;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw badRequest(`Invalid boolean ${what}`, "invalid_value");
    case "datetime": {
      const d = parseApiDatetime(raw);
      if (!d)
        throw badRequest(
          `Invalid datetime ${what} (RFC 3339 with offset required)`,
          "invalid_value",
        );
      return formatDatetime(d);
    }
    case "uuid":
      if (!UUID_RE.test(raw)) throw badRequest(`Invalid uuid ${what}`, "invalid_value");
      return raw;
    default:
      throw badRequest(`Unsupported ${what}`, "invalid_value");
  }
}

export type ListQuery = {
  filters: Condition[];
  order: Array<{ column: string; direction: "asc" | "desc" }>;
  limit: number;
  offset: number;
  select: string[];
};

export type QueryContext = {
  dialect: DialectAdapter;
  /** columns.read のカラム(フィルタ・ソート・select に使える唯一の集合) */
  readable: Map<string, ColumnMeta>;
  limits: { defaultLimit: number; maxLimit: number; maxInValues: number };
};

function parseFilter(col: ColumnMeta, raw: string, qc: QueryContext): Condition {
  const dot = raw.indexOf(".");
  if (dot < 0) throw badRequest(`Invalid filter for ${col.name}`, "invalid_filter");
  const op = raw.slice(0, dot);
  const rest = raw.slice(dot + 1);
  if (!ALL_OPS.has(op)) throw badRequest(`Unsupported operator for ${col.name}`, "invalid_filter");
  const fop = op as FilterOp;
  if (!OPS_BY_TYPE[col.type].includes(fop)) {
    throw badRequest(`Operator ${op} is not available for ${col.name}`, "invalid_filter");
  }
  if ((fop === "like" || fop === "ilike") && !qc.dialect.supportsPatternMatch(col)) {
    throw badRequest(`Operator ${op} is not available for ${col.name}`, "invalid_filter");
  }
  if (fop === "is") {
    if (rest === "null") return { column: col.name, type: col.type, op: "is_null", value: null };
    if (rest === "not_null")
      return { column: col.name, type: col.type, op: "is_not_null", value: null };
    throw badRequest(
      `Unsupported value for is on ${col.name} (use null or not_null)`,
      "invalid_filter",
    );
  }
  if (fop === "in") {
    if (!rest.startsWith("(") || !rest.endsWith(")") || rest.length < 2) {
      throw badRequest(`Invalid in list for ${col.name}`, "invalid_filter");
    }
    const inner = rest.slice(1, -1);
    if (inner === "") throw badRequest(`Empty in list for ${col.name}`, "invalid_filter");
    if (inner.includes('"'))
      throw badRequest(`Quoted values are not supported in in list`, "invalid_filter");
    if (/[()]/.test(inner)) throw badRequest(`Invalid in list for ${col.name}`, "invalid_filter");
    const items = inner.split(",");
    if (items.length > qc.limits.maxInValues) {
      throw badRequest(
        `Too many values in in list (max ${qc.limits.maxInValues})`,
        "invalid_filter",
      );
    }
    const values = items.map((i) =>
      qc.dialect.encodeValue(col.type, parseTextValue(col.type, i, "in element")),
    );
    return { column: col.name, type: col.type, op: "in", value: values };
  }
  const value = qc.dialect.encodeValue(col.type, parseTextValue(col.type, rest));
  return { column: col.name, type: col.type, op: fop, value };
}

function parseIntParam(raw: string, name: string, min: number): number {
  if (!/^\d+$/.test(raw)) throw badRequest(`Invalid ${name}`, "invalid_value");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) throw badRequest(`Invalid ${name}`, "invalid_value");
  return n;
}

/** 一覧のクエリ文字列を解釈する(URL デコード → 予約パラメータ判定 → カラム照合 → `op.value` 分解の順) */
export function parseListQuery(params: URLSearchParams, qc: QueryContext): ListQuery {
  const filters: Condition[] = [];
  const order: ListQuery["order"] = [];
  let limit = qc.limits.defaultLimit;
  let offset = 0;
  let select: string[] | null = null;
  const seen = new Set<string>();

  for (const [key, value] of params) {
    if (NESTED_RESERVED.has(key)) {
      throw badRequest(`Nested conditions are not supported: ${key}`, "unsupported");
    }
    if (LIST_PARAMS.has(key)) {
      if (seen.has(key)) throw badRequest(`Duplicate parameter: ${key}`, "invalid_value");
      seen.add(key);
      if (key === "limit") {
        limit = parseIntParam(value, "limit", 1);
        if (limit > qc.limits.maxLimit)
          throw badRequest(`limit must be ${qc.limits.maxLimit} or less`, "invalid_value");
      } else if (key === "offset") {
        offset = parseIntParam(value, "offset", 0);
      } else if (key === "order") {
        if (value === "") throw badRequest("Invalid order", "invalid_value");
        for (const part of value.split(",")) {
          const [name = "", dir, ...extra] = part.split(".");
          if (extra.length > 0 || (dir !== undefined && dir !== "asc" && dir !== "desc")) {
            throw badRequest("Invalid order", "invalid_value");
          }
          if (!qc.readable.has(name)) throw unknownColumn(name);
          order.push({ column: name, direction: dir === "desc" ? "desc" : "asc" });
        }
      } else {
        if (value === "") throw badRequest("Invalid select", "invalid_value");
        select = value === "*" ? [...qc.readable.keys()] : value.split(",");
        for (const name of select) if (!qc.readable.has(name)) throw unknownColumn(name);
      }
      continue;
    }
    const col = qc.readable.get(key);
    if (!col) throw unknownColumn(key);
    filters.push(parseFilter(col, value, qc));
  }
  return { filters, order, limit, offset, select: select ?? [...qc.readable.keys()] };
}

/** GET /:id など。select だけを受け付ける */
export function parseSelectOnly(params: URLSearchParams, qc: QueryContext): string[] {
  const select: string[] = [];
  let given = false;
  for (const [key, value] of params) {
    if (key !== "select") throw unknownColumn(key);
    if (given) throw badRequest("Duplicate parameter: select", "invalid_value");
    given = true;
    if (value === "") throw badRequest("Invalid select", "invalid_value");
    const names = value === "*" ? [...qc.readable.keys()] : value.split(",");
    for (const n of names) {
      if (!qc.readable.has(n)) throw unknownColumn(n);
      select.push(n);
    }
  }
  return given ? select : [...qc.readable.keys()];
}

/** scope(`{ column: { op: value } }`)を AST(Condition[])へ。カラムは全カラムから照合する */
export function scopeToConditions(
  scope: ScopeFilter | true,
  columns: Map<string, ColumnMeta>,
  dialect: DialectAdapter,
): Condition[] {
  if (scope === true) return [];
  if (scope === null || typeof scope !== "object")
    throw new Error("scope must return a filter object or true");
  const out: Condition[] = [];
  for (const [name, ops] of Object.entries(scope)) {
    const col = columns.get(name);
    if (!col) throw new Error(`scope references unknown column: ${name}`);
    if (!ops || typeof ops !== "object") throw new Error(`invalid scope for column: ${name}`);
    for (const [op, value] of Object.entries(ops)) {
      if (!ALL_OPS.has(op) || !OPS_BY_TYPE[col.type].includes(op as FilterOp)) {
        throw new Error(`invalid scope operator ${op} for column ${name}`);
      }
      if (op === "is") {
        if (value === null || value === "null")
          out.push({ column: name, type: col.type, op: "is_null", value: null });
        else if (value === "not_null")
          out.push({ column: name, type: col.type, op: "is_not_null", value: null });
        else throw new Error(`invalid scope value for is on ${name}`);
        continue;
      }
      const enc = (v: unknown) => {
        const e = dialect.encodeValue(col.type, v);
        if (e === null || !dialect.validateDbValue(col.type, e))
          throw new Error(`invalid scope value for ${name}`);
        return e;
      };
      if (op === "in") {
        if (!Array.isArray(value) || value.length === 0)
          throw new Error(`scope in on ${name} needs a non-empty array`);
        out.push({ column: name, type: col.type, op: "in", value: value.map(enc) });
      } else {
        out.push({ column: name, type: col.type, op: op as FilterOp, value: enc(value) });
      }
    }
  }
  return out;
}

function conditionExpr(
  eb: ExpressionBuilder<any, any>,
  c: Condition,
  dialect: DialectAdapter,
): Expression<SqlBool> {
  const ref = eb.ref(c.column);
  switch (c.op) {
    case "eq":
      return eb(ref, "=", c.value);
    case "neq":
      return eb(ref, "<>", c.value);
    case "gt":
      return eb(ref, ">", c.value);
    case "gte":
      return eb(ref, ">=", c.value);
    case "lt":
      return eb(ref, "<", c.value);
    case "lte":
      return eb(ref, "<=", c.value);
    case "in":
      return eb(ref, "in", c.value as unknown[]);
    case "is_null":
      return eb(ref, "is", null);
    case "is_not_null":
      return eb(ref, "is not", null);
    case "like":
      return dialect.caseSensitiveLike(c.column, String(c.value));
    case "ilike":
      return dialect.caseInsensitiveLike(c.column, String(c.value));
    case "is":
      throw new Error("unreachable");
  }
}

/**
 * WHERE 句を組み立てる。scope は、リクエスト由来の条件全体を包む外側の AND として注入する。
 * 条件が 1 つもなければ null。
 */
export function buildWhere(
  eb: ExpressionBuilder<any, any>,
  dialect: DialectAdapter,
  parts: { scope: Condition[] | null; request?: Condition[]; extra?: Condition[] },
): Expression<SqlBool> | null {
  const groups: Expression<SqlBool>[] = [];
  if (parts.scope && parts.scope.length > 0) {
    groups.push(eb.and(parts.scope.map((c) => conditionExpr(eb, c, dialect))));
  }
  if (parts.extra && parts.extra.length > 0) {
    groups.push(eb.and(parts.extra.map((c) => conditionExpr(eb, c, dialect))));
  }
  if (parts.request && parts.request.length > 0) {
    groups.push(eb.and(parts.request.map((c) => conditionExpr(eb, c, dialect))));
  }
  if (groups.length === 0) return null;
  return groups.length === 1 ? groups[0]! : eb.and(groups);
}
