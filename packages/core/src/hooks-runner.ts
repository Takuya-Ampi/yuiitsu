import type { Context, Env } from "hono";
import type { Kysely } from "kysely";
import type { AfterCommitErrorInfo } from "./types";

export type AfterCommitOptions<E extends Env> = {
  timeoutMs: number;
  onError?: (error: unknown, info: AfterCommitErrorInfo<E>) => void | Promise<void>;
};

/**
 * afterCommit* を await して実行する。失敗・タイムアウトはレスポンスに影響させず
 * onAfterCommitError へ渡す(行の値は渡さない)。
 */
export async function runAfterCommit<E extends Env>(args: {
  hook: ((ctx: any, row: any) => Promise<void>) | undefined;
  c: Context<E>;
  db: Kysely<any>;
  table: string;
  operation: "create" | "update" | "delete";
  row: unknown;
  options: AfterCommitOptions<E>;
}): Promise<void> {
  const { hook, c, db, table, operation, row, options } = args;
  if (!hook) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = async (error: unknown, reason: "error" | "timeout") => {
    const info: AfterCommitErrorInfo<E> = { table, operation, reason, c };
    try {
      if (options.onError) await options.onError(error, info);
      else console.error("[autoapi] afterCommit hook failed", { table, operation, reason, error });
    } catch {
      // onAfterCommitError 自体の例外は握りつぶす
    }
  };
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, options.timeoutMs);
  });
  const running = Promise.resolve()
    .then(() => hook({ c, db, table, signal: controller.signal }, row))
    .then(() => "ok" as const);
  // タイムアウト後に reject されても未処理にしない
  running.catch(() => {});
  try {
    const result = await Promise.race([running, timeout]);
    if (result === "timeout") await report(new Error("afterCommit hook timed out"), "timeout");
  } catch (error) {
    await report(error, "error");
  } finally {
    clearTimeout(timer);
  }
}
