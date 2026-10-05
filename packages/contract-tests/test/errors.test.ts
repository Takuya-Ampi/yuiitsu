import { describe, expect, it } from "vite-plus/test";
import { mysqlDialect, normalizeMysqlError } from "@yuiitsu/dialect-mysql";
import { normalizePgError, postgresDialect } from "@yuiitsu/dialect-postgres";
import { likeToGlob, normalizeSqliteError, sqliteDialect } from "@yuiitsu/dialect-sqlite";

// 6.5.1 の表。メッセージ文字列ではなく code / errno だけで判定する
const PG: Array<[unknown, string]> = [
  [{ code: "23505" }, "unique_violation"],
  [{ code: "23503" }, "foreign_key_violation"],
  [{ code: "23502" }, "not_null_violation"],
  [{ code: "23514" }, "check_violation"],
  [{ code: "22001" }, "data_exception"],
  [{ code: "22003" }, "data_exception"],
  [{ code: "40001" }, "serialization_failure"],
  [{ code: "40P01" }, "deadlock"],
  [{ code: "55P03" }, "lock_timeout"],
  [{ code: "57014" }, "timeout"],
  [{ code: "08006" }, "connection_error"],
  [{ code: "ECONNREFUSED" }, "connection_error"],
  [{ code: "ECONNRESET" }, "connection_error"],
  [{ code: "42P01" }, "unknown"],
  [new Error("duplicate key value violates unique constraint"), "unknown"],
  [null, "unknown"],
];
const MYSQL: Array<[unknown, string]> = [
  [{ errno: 1062 }, "unique_violation"],
  [{ errno: 1451 }, "foreign_key_violation"],
  [{ errno: 1452 }, "foreign_key_violation"],
  [{ errno: 1048 }, "not_null_violation"],
  [{ errno: 1364 }, "not_null_violation"],
  [{ errno: 3819 }, "check_violation"],
  [{ errno: 1406 }, "data_exception"],
  [{ errno: 1264 }, "data_exception"],
  [{ errno: 1213 }, "deadlock"],
  [{ errno: 1205 }, "lock_timeout"],
  [{ errno: 3024 }, "timeout"],
  [{ code: "PROTOCOL_CONNECTION_LOST" }, "connection_error"],
  [{ code: "ECONNREFUSED" }, "connection_error"],
  [{ code: "ECONNRESET" }, "connection_error"],
  [{ errno: 1146 }, "unknown"],
  [new Error("Duplicate entry"), "unknown"],
];
const SQLITE: Array<[unknown, string]> = [
  [{ code: "SQLITE_CONSTRAINT_UNIQUE" }, "unique_violation"],
  [{ code: "SQLITE_CONSTRAINT_PRIMARYKEY" }, "unique_violation"],
  [{ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }, "foreign_key_violation"],
  [{ code: "SQLITE_CONSTRAINT_NOTNULL" }, "not_null_violation"],
  [{ code: "SQLITE_CONSTRAINT_CHECK" }, "check_violation"],
  [{ code: "SQLITE_CONSTRAINT_DATATYPE" }, "data_exception"],
  [{ code: "SQLITE_BUSY" }, "lock_timeout"],
  [{ code: "SQLITE_BUSY_SNAPSHOT" }, "lock_timeout"],
  [{ code: "SQLITE_ERROR" }, "unknown"],
];

describe("DB error normalization", () => {
  it.each(PG)("postgres %j → %s", (e, type) => {
    expect(normalizePgError(e).type).toBe(type);
    expect(postgresDialect().normalizeError(e).cause).toBe(e);
  });
  it.each(MYSQL)("mysql %j → %s", (e, type) => {
    expect(normalizeMysqlError(e).type).toBe(type);
    expect(mysqlDialect().normalizeError(e).type).toBe(type);
  });
  it.each(SQLITE)("sqlite %j → %s", (e, type) => {
    expect(normalizeSqliteError(e).type).toBe(type);
    expect(sqliteDialect().normalizeError(e).type).toBe(type);
  });
});

describe("likeToGlob", () => {
  it("converts LIKE wildcards and escapes GLOB specials", () => {
    expect(likeToGlob("App%")).toBe("App*");
    expect(likeToGlob("a_c")).toBe("a?c");
    expect(likeToGlob("*?[x")).toBe("[*][?][[]x");
  });
});
