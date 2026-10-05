import {
  ValueError,
  decodeUnknown,
  formatDatetime,
  isSafeIntegerLike,
  isValidJsonText,
  parseApiDatetime,
  parseStoredIso,
  toBoolean01,
  toFiniteNumber,
  toSafeInteger,
  toText,
  toUuid,
  UUID_RE,
  STORED_ISO_RE,
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
import type { Kysely, Transaction } from "kysely";

/** 宣言型 → NormalizedType(6.4.1 の表。上から順に判定) */
export function normalizeSqliteType(declared: string): NormalizedType {
  const t = declared.trim().toUpperCase();
  if (t === "BOOLEAN" || t === "BOOL") return "boolean";
  if (t === "DATETIME" || t === "TIMESTAMP") return "datetime";
  if (t === "JSON") return "json";
  if (t === "UUID") return "uuid";
  if (t.includes("INT")) return "integer";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "text";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "number";
  return "unknown";
}

const code = (e: unknown): string | undefined =>
  e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : undefined;

export function normalizeSqliteError(error: unknown): NormalizedDatabaseError {
  const cause = error;
  const c = code(error);
  if (!c) return { type: "unknown", cause };
  switch (c) {
    case "SQLITE_CONSTRAINT_UNIQUE":
    case "SQLITE_CONSTRAINT_PRIMARYKEY":
      return { type: "unique_violation", cause };
    case "SQLITE_CONSTRAINT_FOREIGNKEY":
      return { type: "foreign_key_violation", cause };
    case "SQLITE_CONSTRAINT_NOTNULL":
      return { type: "not_null_violation", cause };
    case "SQLITE_CONSTRAINT_CHECK":
      return { type: "check_violation", cause };
    case "SQLITE_CONSTRAINT_DATATYPE":
      return { type: "data_exception", cause };
  }
  if (c.startsWith("SQLITE_BUSY")) return { type: "lock_timeout", cause };
  return { type: "unknown", cause };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** LIKE のパターンを GLOB へ変換(`%` → `*`、`_` → `?`。GLOB の特殊文字はエスケープ) */
export function likeToGlob(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "%") out += "*";
    else if (ch === "_") out += "?";
    else if (ch === "*" || ch === "?" || ch === "[") out += `[${ch}]`;
    else out += ch;
  }
  return out;
}

export function sqliteDialect(): DialectAdapter {
  return {
    name: "sqlite",
    capabilities: {
      returning: true,
      lockingRead: false,
      jsonOperators: false,
      foreignKeyIntrospection: true,
      retryOnSerializationFailure: false,
    },

    async introspect(db: Kysely<any>): Promise<SchemaMeta> {
      const list = (
        await sql<Row>`select name, wr from pragma_table_list where schema = 'main' and type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name`.execute(
          db,
        )
      ).rows;
      const metas: TableMeta[] = [];
      for (const t of list) {
        const name = String(t.name);
        const withoutRowid = Number(t.wr) === 1;
        const info = (
          await sql<Row>`select name, type, "notnull" as nn, dflt_value, pk, hidden from pragma_table_xinfo(${name}) order by cid`.execute(
            db,
          )
        ).rows.filter((r) => Number(r.hidden) !== 1);
        const pkCols = info
          .filter((r) => Number(r.pk) > 0)
          .sort((a, b) => Number(a.pk) - Number(b.pk));
        const columns: ColumnMeta[] = info.map((r) => {
          const declared = String(r.type ?? "");
          const generated = Number(r.hidden) === 2 || Number(r.hidden) === 3;
          const rowidAlias =
            !withoutRowid &&
            pkCols.length === 1 &&
            pkCols[0]!.name === r.name &&
            declared.trim().toUpperCase() === "INTEGER";
          return {
            name: String(r.name),
            type: normalizeSqliteType(declared),
            nativeType: declared.toLowerCase(),
            nullable: Number(r.nn) === 0 && !(Number(r.pk) > 0 && rowidAlias),
            hasDefault: r.dflt_value !== null || rowidAlias || generated,
            isGenerated: generated || rowidAlias,
            isAutoIncrement: rowidAlias,
            charset: null,
          };
        });
        const fkRows = (
          await sql<Row>`select id, seq, "table" as ref_table, "from" as from_col, "to" as to_col from pragma_foreign_key_list(${name}) order by id, seq`.execute(
            db,
          )
        ).rows;
        const fkMap = new Map<number, Row[]>();
        for (const f of fkRows) {
          const arr = fkMap.get(Number(f.id)) ?? [];
          arr.push(f);
          fkMap.set(Number(f.id), arr);
        }
        metas.push({
          schema: null,
          name,
          primaryKey: pkCols.map((r) => String(r.name)),
          columns,
          foreignKeys: [...fkMap.values()].map((rows) => ({
            columns: rows.map((r) => String(r.from_col)),
            refSchema: null,
            refTable: String(rows[0]!.ref_table),
            // to が null の場合は参照先の主キー(後で補完)
            refColumns: rows.map((r) => (r.to_col === null ? "" : String(r.to_col))),
          })),
        });
      }
      for (const m of metas) {
        for (const fk of m.foreignKeys) {
          if (fk.refColumns.some((c) => c === "")) {
            fk.refColumns = metas.find((x) => x.name === fk.refTable)?.primaryKey ?? fk.refColumns;
          }
        }
      }
      return { dialect: "sqlite", tables: metas };
    },

    assertTableSupported() {},

    async preflight(db) {
      const warnings: string[] = [];
      const version = String((await sql<Row>`select sqlite_version() as v`.execute(db)).rows[0]?.v);
      const [maj = 0, min = 0] = version.split(".").map(Number);
      if (maj < 3 || (maj === 3 && min < 37)) {
        throw new Error(`SQLite ${version} is not supported (3.37 or later is required)`);
      }
      const fk = Number(
        (await sql<Row>`select foreign_keys as v from pragma_foreign_keys`.execute(db)).rows[0]?.v,
      );
      if (fk !== 1)
        warnings.push(
          "SQLite PRAGMA foreign_keys is OFF: foreign key constraints are not enforced",
        );
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
          return toBoolean01(value);
        case "datetime":
          return formatDatetime(parseStoredIso(toText(value)));
        case "json": {
          try {
            return JSON.parse(toText(value));
          } catch {
            throw new ValueError("invalid json");
          }
        }
        case "uuid":
          return toUuid(value);
        case "unknown":
          return decodeUnknown(value);
      }
    },

    encodeValue(type, value) {
      if (value === null) return null;
      switch (type) {
        case "integer":
          return BigInt(value as number);
        case "boolean":
          return value ? 1 : 0;
        case "datetime": {
          const d = typeof value === "string" ? parseApiDatetime(value) : null;
          if (!d) throw new ValueError("invalid datetime");
          return formatDatetime(d);
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
          return value === 0 || value === 1 || value === 0n || value === 1n;
        case "datetime":
          if (typeof value !== "string" || !STORED_ISO_RE.test(value)) return false;
          try {
            parseStoredIso(value);
            return true;
          } catch {
            return false;
          }
        case "json":
          return isValidJsonText(value);
        case "uuid":
          return typeof value === "string" && UUID_RE.test(value);
        case "unknown":
          return false;
      }
    },

    // BEGIN IMMEDIATE で書き込みロックを先に取得する(読み取りロックからの昇格時の BUSY を避ける)
    async writeTransaction(db, fn) {
      return db.connection().execute(async (conn) => {
        await sql`begin immediate`.execute(conn);
        try {
          const result = await fn(conn as unknown as Transaction<any>);
          await sql`commit`.execute(conn);
          return result;
        } catch (error) {
          try {
            await sql`rollback`.execute(conn);
          } catch {
            // ロールバック失敗は元のエラーを優先する
          }
          throw error;
        }
      });
    },

    orderByNullsLast(column, direction) {
      return [sql`${sql.ref(column)} ${sql.raw(direction)} nulls last`];
    },
    caseSensitiveLike(column, pattern) {
      return sql<boolean>`${sql.ref(column)} glob ${likeToGlob(pattern)}`;
    },
    caseInsensitiveLike(column, pattern) {
      return sql<boolean>`${sql.ref(column)} like ${pattern}`;
    },
    supportsPatternMatch() {
      return true;
    },

    normalizeError: normalizeSqliteError,
  };
}
