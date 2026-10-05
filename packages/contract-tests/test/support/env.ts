export const pgConfig = () => ({
  host: process.env.PG_HOST ?? "127.0.0.1",
  port: Number(process.env.PG_PORT ?? 15432),
  user: process.env.PG_USER ?? "autoapi",
  password: process.env.PG_PASSWORD ?? "autoapi_dev",
  database: process.env.PG_DATABASE ?? "autoapi_test",
});

export const mysqlConfig = () => ({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 13306),
  user: process.env.MYSQL_USER ?? "autoapi",
  password: process.env.MYSQL_PASSWORD ?? "autoapi_dev",
  database: process.env.MYSQL_DATABASE ?? "autoapi_test",
});

export const workerId = () => process.env.VITEST_POOL_ID ?? "0";
