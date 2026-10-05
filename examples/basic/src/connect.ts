import Database from "better-sqlite3";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect, sql } from "kysely";
import { createPool } from "mysql2";
import pg from "pg";
import type { DialectAdapter } from "@yuiitsu/core";
import { mysqlDialect } from "@yuiitsu/dialect-mysql";
import { postgresDialect } from "@yuiitsu/dialect-postgres";
import { sqliteDialect } from "@yuiitsu/dialect-sqlite";
import { DDL, DDL_MYSQL, DDL_POSTGRES, type DB } from "./app.ts";

/** 契約テストなど他の用途と衝突しないよう、例専用のデータベースを使う */
const PG_DATABASE = "autoapi_example";
const MYSQL_DATABASE = "autoapi_test_example"; // docker/mysql/initdb.d の GRANT 対象(autoapi_test%)

export type DbName = "postgres" | "mysql" | "sqlite";
export const DB_NAMES: DbName[] = ["postgres", "mysql", "sqlite"];

export type Connection = {
  db: Kysely<DB>;
  dialect: DialectAdapter;
  /** 接続先の表示用(パスワードは含めない) */
  label: string;
  close(): Promise<void>;
};

const env = (k: string, d: string) => process.env[k] ?? d;

// docker-compose.yml / .env.example と同じ既定値
const pgConfig = () => ({
  host: env("PG_HOST", "127.0.0.1"),
  port: Number(env("PG_PORT", "15432")),
  user: env("PG_USER", "autoapi"),
  password: env("PG_PASSWORD", "autoapi_dev"),
  database: env("PG_DATABASE", "autoapi_test"),
});
const mysqlConfig = () => ({
  host: env("MYSQL_HOST", "127.0.0.1"),
  port: Number(env("MYSQL_PORT", "13306")),
  user: env("MYSQL_USER", "autoapi"),
  password: env("MYSQL_PASSWORD", "autoapi_dev"),
  database: env("MYSQL_DATABASE", "autoapi_test"),
});

/** 接続の設定は利用者の責務(README「ドライバ・DB の前提設定」)。 */
export async function connect(name: DbName): Promise<Connection> {
  if (name === "postgres") {
    const cfg = pgConfig();
    const admin = new pg.Client(cfg);
    await admin.connect();
    const found = await admin.query("select 1 from pg_database where datname = $1", [PG_DATABASE]);
    if (found.rowCount === 0) await admin.query(`create database ${PG_DATABASE}`);
    await admin.end();
    // pg は int8 を文字列で返す既定のまま使う
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cfg, database: PG_DATABASE }),
      }),
    });
    return {
      db,
      dialect: postgresDialect(),
      label: `postgres://${cfg.user}@${cfg.host}:${cfg.port}/${PG_DATABASE}`,
      close: () => db.destroy(),
    };
  }
  if (name === "mysql") {
    const { database: _shared, ...cfg } = mysqlConfig();
    const admin = createPool(cfg).promise();
    await admin.query(`create database if not exists \`${MYSQL_DATABASE}\``);
    await admin.end();
    const pool = createPool({
      ...cfg,
      database: MYSQL_DATABASE,
      supportBigNumbers: true,
      bigNumberStrings: true,
      timezone: "Z",
    });
    pool.on("connection", (c) => c.query("SET time_zone = '+00:00'"));
    const db = new Kysely<DB>({ dialect: new MysqlDialect({ pool }) });
    return {
      db,
      dialect: mysqlDialect(),
      label: `mysql://${cfg.user}@${cfg.host}:${cfg.port}/${MYSQL_DATABASE}`,
      close: () => db.destroy(),
    };
  }
  const file = process.env.SQLITE_FILE || ":memory:";
  const raw = new Database(file);
  raw.defaultSafeIntegers(true);
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
  return { db, dialect: sqliteDialect(), label: `sqlite ${file}`, close: () => db.destroy() };
}

/**
 * KEEP_DATA=1 のとき、orders / inventory が既にあれば何もしない(DB に直接足した列やデータを残す)。
 * 無ければ通常どおり作る。
 */
export async function prepareExampleTables(name: DbName, db: Kysely<DB>) {
  if (process.env.KEEP_DATA === "1") {
    const exists = await Promise.all(
      ["orders", "inventory"].map((t) =>
        sql
          .raw(`select 1 from ${t} limit 1`)
          .execute(db)
          .then(
            () => true,
            () => false,
          ),
      ),
    );
    if (exists.every(Boolean)) return false;
  }
  await resetExampleTables(name, db);
  return true;
}

/** 例のテーブルを作り直して初期データを入れる。既存の orders / inventory は削除する(例専用のスキーマ / データベース)。 */
export async function resetExampleTables(name: DbName, db: Kysely<DB>) {
  await sql.raw("drop table if exists orders").execute(db);
  await sql.raw("drop table if exists inventory").execute(db);
  const ddl = name === "postgres" ? DDL_POSTGRES : name === "mysql" ? DDL_MYSQL : DDL;
  for (const s of ddl) await sql.raw(s).execute(db);
  await db.insertInto("inventory").values({ sku: "WIDGET", stock: INITIAL_STOCK }).execute();
}

export const INITIAL_STOCK = 3;
