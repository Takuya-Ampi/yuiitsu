import {
  ValueError,
  decodeUnknown,
  formatDatetime,
  isSafeIntegerLike,
  isValidJsonText,
  parseApiDatetime,
  toBoolean01,
  toFiniteNumber,
  toSafeInteger,
  toText,
  toUuid,
} from "@yuiitsu/core";
import type {
  ColumnMeta,
  DialectAdapter,
  NormalizedDatabaseError,
  NormalizedType,
  SchemaMeta,
  TableMeta,
} from "@yuiitsu/core";
import { sql } from "kysely";
import type { Kysely } from "kysely";

const TEXT_TYPES = new Set(["char", "varchar", "tinytext", "text", "mediumtext", "longtext"]);
const INT_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "bigint"]);

/** columnType は COLUMN_TYPE(例: `tinyint(1)`、`varchar(255)`) */
export function normalizeMysqlType(dataType: string, columnType: string): NormalizedType {
  const t = dataType.toLowerCase();
  if (columnType.toLowerCase() === "tinyint(1)") return "boolean";
  if (TEXT_TYPES.has(t)) return "text";
  if (INT_TYPES.has(t)) return "integer";
  if (t === "float" || t === "double") return "number";
  if (t === "timestamp") return "datetime";
  if (t === "json") return "json";
  return "unknown";
}

const errno = (e: unknown): number | undefined =>
  e && typeof e === "object" && typeof (e as { errno?: unknown }).errno === "number"
    ? (e as { errno: number }).errno
    : undefined;
const code = (e: unknown): string | undefined =>
  e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : undefined;

export function normalizeMysqlError(error: unknown): NormalizedDatabaseError {
  const cause = error;
  const n = errno(error);
  const c = code(error);
  switch (n) {
    case 1062:
      return { type: "unique_violation", cause };
    case 1451:
    case 1452:
      return { type: "foreign_key_violation", cause };
    case 1048:
    case 1364:
      return { type: "not_null_violation", cause };
    case 3819:
      return { type: "check_violation", cause };
    case 1406:
    case 1264:
    case 1366:
    case 1292:
      return { type: "data_exception", cause };
    case 1213:
      return { type: "deadlock", cause };
    case 1205:
      return { type: "lock_timeout", cause };
    case 3024:
      return { type: "timeout", cause };
  }
  if (
    c === "PROTOCOL_CONNECTION_LOST" ||
    c === "ECONNREFUSED" ||
    c === "ECONNRESET" ||
    c === "EPIPE" ||
    c === "ETIMEDOUT" ||
    c === "ENOTFOUND"
  ) {
    return { type: "connection_error", cause };
  }
  return { type: "unknown", cause };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function mysqlDialect(): DialectAdapter {
  return {
    name: "mysql",
    capabilities: {
      returning: false,
      lockingRead: true,
      jsonOperators: true,
      foreignKeyIntrospection: true,
      retryOnSerializationFailure: false,
    },

    async introspect(db: Kysely<any>): Promise<SchemaMeta> {
      const dbName = (await sql<Row>`select database() as db`.execute(db)).rows[0]?.db;
      if (typeof dbName !== "string" || dbName === "") {
        throw new Error("MySQL: no database selected (connect with a database name)");
      }
      const tables = (
        await sql<Row>`
          select TABLE_NAME as name, ENGINE as engine
          from information_schema.TABLES
          where TABLE_SCHEMA = ${dbName} and TABLE_TYPE = 'BASE TABLE'
          order by TABLE_NAME`.execute(db)
      ).rows;
      const columns = (
        await sql<Row>`
          select TABLE_NAME as table_name, COLUMN_NAME as name, DATA_TYPE as data_type, COLUMN_TYPE as column_type,
                 IS_NULLABLE as nullable, COLUMN_DEFAULT as col_default, EXTRA as extra,
                 CHARACTER_SET_NAME as charset
          from information_schema.COLUMNS
          where TABLE_SCHEMA = ${dbName}
          order by TABLE_NAME, ORDINAL_POSITION`.execute(db)
      ).rows;
      const keys = (
        await sql<Row>`
          select k.TABLE_NAME as table_name, k.CONSTRAINT_NAME as con_name, k.COLUMN_NAME as col,
                 k.ORDINAL_POSITION as pos, k.REFERENCED_TABLE_SCHEMA as ref_schema,
                 k.REFERENCED_TABLE_NAME as ref_table, k.REFERENCED_COLUMN_NAME as ref_col
          from information_schema.KEY_COLUMN_USAGE k
          where k.TABLE_SCHEMA = ${dbName}
            and (k.CONSTRAINT_NAME = 'PRIMARY' or k.REFERENCED_TABLE_NAME is not null)
          order by k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`.execute(db)
      ).rows;

      const metas: TableMeta[] = tables.map((t) => {
        const name = String(t.name);
        const cols: ColumnMeta[] = columns
          .filter((c) => c.table_name === name)
          .map((c) => {
            const extra = String(c.extra ?? "");
            const auto = /auto_increment/i.test(extra);
            const generated = /(VIRTUAL|STORED) GENERATED/.test(extra);
            const columnType = String(c.column_type);
            const type = normalizeMysqlType(String(c.data_type), columnType);
            return {
              name: String(c.name),
              type,
              nativeType: type === "boolean" ? "tinyint(1)" : String(c.data_type).toLowerCase(),
              nullable: String(c.nullable) === "YES",
              hasDefault:
                c.col_default !== null || /DEFAULT_GENERATED/.test(extra) || auto || generated,
              isGenerated: generated || auto,
              isAutoIncrement: auto,
              charset: typeof c.charset === "string" ? c.charset : null,
            };
          });
        const own = keys.filter((k) => k.table_name === name);
        const fkMap = new Map<string, Row[]>();
        for (const k of own.filter((k) => k.ref_table !== null)) {
          const arr = fkMap.get(String(k.con_name)) ?? [];
          arr.push(k);
          fkMap.set(String(k.con_name), arr);
        }
        return {
          schema: dbName,
          name,
          primaryKey: own.filter((k) => k.con_name === "PRIMARY").map((k) => String(k.col)),
          columns: cols,
          foreignKeys: [...fkMap.values()].map((rows) => ({
            columns: rows.map((r) => String(r.col)),
            refSchema: String(rows[0]!.ref_schema),
            refTable: String(rows[0]!.ref_table),
            refColumns: rows.map((r) => String(r.ref_col)),
          })),
          engine: typeof t.engine === "string" ? t.engine : null,
        };
      });
      return { dialect: "mysql", tables: metas };
    },

    assertTableSupported(table) {
      if (table.engine !== "InnoDB") {
        throw new Error(
          `MySQL table "${table.name}" must use the InnoDB engine (got ${table.engine ?? "unknown"})`,
        );
      }
    },

    async preflight(db, info) {
      const warnings: string[] = [];
      const dbName = (await sql<Row>`select database() as db`.execute(db)).rows[0]?.db;
      if (typeof dbName !== "string" || dbName === "") {
        throw new Error("MySQL: no database selected (connect with a database name)");
      }
      if (info.exposesDatetime) {
        const tz = String(
          (await sql<Row>`select @@session.time_zone as tz`.execute(db)).rows[0]?.tz,
        );
        if (tz !== "+00:00" && tz !== "UTC") {
          warnings.push(
            `MySQL session time_zone is "${tz}" (expected '+00:00'): TIMESTAMP columns may be misread`,
          );
        }
      }
      return warnings;
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
          return toBoolean01(value); // tinyint(1) は 0 / 1 のみ
        case "datetime": {
          if (value instanceof Date) return formatDatetime(value);
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
        case "boolean":
          return value ? 1 : 0;
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
          return value === true || value === false || value === 0 || value === 1;
        case "datetime":
          return value instanceof Date && !Number.isNaN(value.getTime());
        case "json":
          return isValidJsonText(value);
        case "uuid":
          return false;
        case "unknown":
          return false;
      }
    },

    async writeTransaction(db, fn) {
      return db.transaction().setIsolationLevel("read committed").execute(fn);
    },

    orderByNullsLast(column, direction) {
      return [sql`${sql.ref(column)} is null`, sql`${sql.ref(column)} ${sql.raw(direction)}`];
    },
    caseSensitiveLike(column, pattern) {
      return sql<boolean>`${sql.ref(column)} collate utf8mb4_0900_as_cs like ${pattern}`;
    },
    caseInsensitiveLike(column, pattern) {
      return sql<boolean>`${sql.ref(column)} collate utf8mb4_0900_as_ci like ${pattern}`;
    },
    supportsPatternMatch(column) {
      return column.charset?.toLowerCase() === "utf8mb4";
    },

    normalizeError: normalizeMysqlError,
  };
}
