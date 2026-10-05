import mysql from "mysql2/promise";
import pg from "pg";
import { mysqlConfig, pgConfig } from "./support/env";

// DB に接続できない場合は skip せず、失敗させる(DB の未起動に気づけるようにする)
export default async function setup() {
  const errors: string[] = [];
  try {
    const client = new pg.Client(pgConfig());
    await client.connect();
    await client.end();
  } catch (e) {
    errors.push(`PostgreSQL is not reachable (run \`vp run db:up\`): ${(e as Error).message}`);
  }
  try {
    const conn = await mysql.createConnection(mysqlConfig());
    await conn.end();
  } catch (e) {
    errors.push(`MySQL is not reachable (run \`vp run db:up\`): ${(e as Error).message}`);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}
