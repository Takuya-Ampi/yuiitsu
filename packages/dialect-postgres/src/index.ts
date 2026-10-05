import {
  ValueError,
  decodeUnknown,
  formatDatetime,
  isSafeIntegerLike,
  isValidJsonText,
  parseApiDatetime,
  toFiniteNumber,
  toSafeInteger,
  toText,
  toUuid,
  UUID_RE,
} from "@yuiitsu/core";
import type {
  ColumnMeta,
  DialectAdapter,
  ForeignKeyMeta,
  NormalizedDatabaseError,
  NormalizedType,
  SchemaMeta,
  TableMeta,
} from "@yuiitsu/core";
import { sql } from "kysely";
import type { Kysely } from "kysely";

const TYPE_MAP: Record<string, NormalizedType> = {
  text: "text",
  varchar: "text",
  bpchar: "text",
  int2: "integer",
  int4: "integer",
  int8: "integer",
  float4: "number",
  float8: "number",
  bool: "boolean",
  timestamptz: "datetime",
  json: "json",
  jsonb: "json",
  uuid: "uuid",
};

/** typtype が 'b'(base) 以外(domain / enum / composite など)と配列は unknown */
export function normalizePgType(
  typname: string,
  typtype: string,
  typcategory: string,
): NormalizedType {
  if (typtype !== "b" || typcategory === "A") return "unknown";
  return TYPE_MAP[typname] ?? "unknown";
}

const code = (e: unknown): string | undefined =>
  e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : undefined;

export function normalizePgError(error: unknown): NormalizedDatabaseError {
  const c = code(error);
  const cause = error;
  if (!c) return { type: "unknown", cause };
  switch (c) {
    case "23505":
      return { type: "unique_violation", cause };
    case "23503":
      return { type: "foreign_key_violation", cause };
    case "23502":
      return { type: "not_null_violation", cause };
    case "23514":
      return { type: "check_violation", cause };
    case "40001":
      return { type: "serialization_failure", cause };
    case "40P01":
      return { type: "deadlock", cause };
    case "55P03":
      return { type: "lock_timeout", cause };
    case "57014":
      return { type: "timeout", cause };
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EPIPE":
    case "ETIMEDOUT":
    case "ENOTFOUND":
      return { type: "connection_error", cause };
  }
  if (/^22[0-9A-Z]{3}$/.test(c)) return { type: "data_exception", cause };
  if (/^08[0-9A-Z]{3}$/.test(c)) return { type: "connection_error", cause };
  return { type: "unknown", cause };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function postgresDialect(): DialectAdapter {
  return {
    name: "postgres",
    capabilities: {
      returning: true,
      lockingRead: true,
      jsonOperators: true,
      foreignKeyIntrospection: true,
      retryOnSerializationFailure: true,
    },

    async introspect(db: Kysely<any>, options: { pgSchema?: string }): Promise<SchemaMeta> {
      const schema = options.pgSchema ?? "public";
      const tables = (
        await sql<Row>`
          select c.oid::int8 as oid, c.relname as name
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${schema} and c.relkind = 'r' and not c.relispartition
          order by c.relname`.execute(db)
      ).rows;
      const columns = (
        await sql<Row>`
          select c.relname as table_name, a.attname as name, t.typname, t.typtype, t.typcategory,
                 a.attnotnull as notnull, a.atthasdef as hasdef, a.attgenerated as generated,
                 a.attidentity as identity, pg_get_expr(d.adbin, d.adrelid) as default_expr
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          join pg_type t on t.oid = a.atttypid
          left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
          where n.nspname = ${schema} and c.relkind = 'r' and not c.relispartition
          order by c.relname, a.attnum`.execute(db)
      ).rows;
      const pks = (
        await sql<Row>`
          select c.relname as table_name, a.attname as name
          from pg_index i
          join pg_class c on c.oid = i.indrelid
          join pg_namespace n on n.oid = c.relnamespace
          cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where n.nspname = ${schema} and i.indisprimary
          order by c.relname, k.ord`.execute(db)
      ).rows;
      const fks = (
        await sql<Row>`
          select c.relname as table_name, con.conname as con_name, rn.nspname as ref_schema, rc.relname as ref_table,
                 (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
                 (select array_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as ref_cols
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
          join pg_class rc on rc.oid = con.confrelid
          join pg_namespace rn on rn.oid = rc.relnamespace
          where n.nspname = ${schema} and con.contype = 'f'
          order by c.relname, con.conname`.execute(db)
      ).rows;

      const metas: TableMeta[] = tables.map((t) => {
        const name = String(t.name);
        const cols: ColumnMeta[] = columns
          .filter((c) => c.table_name === name)
          .map((c) => {
            const identity = String(c.identity ?? "") !== "";
            const generated = String(c.generated ?? "") !== "";
            const serial =
              typeof c.default_expr === "string" && c.default_expr.startsWith("nextval(");
            const auto = identity || serial;
            return {
              name: String(c.name),
              type: normalizePgType(String(c.typname), String(c.typtype), String(c.typcategory)),
              nativeType: String(c.typname),
              nullable: !c.notnull,
              hasDefault: Boolean(c.hasdef) || identity,
              isGenerated: generated || auto,
              isAutoIncrement: auto,
              charset: null,
            };
          });
        const foreignKeys: ForeignKeyMeta[] = fks
          .filter((f) => f.table_name === name)
          .map((f) => ({
            columns: f.cols as string[],
            refSchema: String(f.ref_schema),
            refTable: String(f.ref_table),
            refColumns: f.ref_cols as string[],
          }));
        return {
          schema,
          name,
          primaryKey: pks.filter((p) => p.table_name === name).map((p) => String(p.name)),
          columns: cols,
          foreignKeys,
        };
      });
      return { dialect: "postgres", tables: metas };
    },

    assertTableSupported() {},
    async preflight() {
      return [];
    },

    decodeValue(type, value) {
      if (value === null || value === undefined) return null;
      switch (type) {
        case "text":
          return toText(value);
        case "integer":
          return toSafeInteger(value);
        case "number":
          return toFiniteNumber(value);
        case "boolean":
          if (typeof value === "boolean") return value;
          throw new ValueError("expected boolean");
        case "datetime": {
          if (value instanceof Date) return formatDatetime(value);
          if (typeof value === "string") {
            const d = new Date(value);
            return formatDatetime(d);
          }
          throw new ValueError("expected datetime");
        }
        case "json":
          return value;
        case "uuid":
          return toUuid(value);
        case "unknown":
          return decodeUnknown(value);
      }
    },

    encodeValue(type, value) {
      if (value === null) return null;
      switch (type) {
        case "datetime": {
          const d = typeof value === "string" ? parseApiDatetime(value) : null;
          if (!d) throw new ValueError("invalid datetime");
          return d;
        }
        case "json":
          return JSON.stringify(value);
        case "unknown":
          throw new ValueError("unknown type is not writable");
        default:
          return value;
      }
    },

    validateDbValue(type, value) {
      if (value === null) return true;
      switch (type) {
        case "text":
          return typeof value === "string";
        case "integer":
          return isSafeIntegerLike(value);
        case "number":
          return typeof value === "number" ? Number.isFinite(value) : typeof value === "bigint";
        case "boolean":
          return typeof value === "boolean";
        case "datetime":
          return value instanceof Date && !Number.isNaN(value.getTime());
        case "json":
          return isValidJsonText(value);
        case "uuid":
          return typeof value === "string" && UUID_RE.test(value);
        case "unknown":
          return false;
      }
    },

    async writeTransaction(db, fn) {
      return db.transaction().setIsolationLevel("read committed").execute(fn);
    },

    orderByNullsLast(column, direction) {
      return [sql`${sql.ref(column)} ${sql.raw(direction)} nulls last`];
    },
    caseSensitiveLike(column, pattern) {
      return sql<boolean>`${sql.ref(column)} like ${pattern}`;
    },
    caseInsensitiveLike(column, pattern) {
      return sql<boolean>`${sql.ref(column)} ilike ${pattern}`;
    },
    supportsPatternMatch() {
      return true;
    },

    normalizeError: normalizePgError,
  };
}
