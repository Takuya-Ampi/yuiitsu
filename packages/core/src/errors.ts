import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DialectAdapter } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, code = "bad_request") =>
  new ApiError(400, code, message);
export const notFound = () => new ApiError(404, "not_found", "Not found");
export const forbidden = () =>
  new ApiError(403, "forbidden", "The resulting row is outside of the allowed scope");
export const internal = () => new ApiError(500, "internal_error", "Internal server error");

/** 存在しないカラムと許可されていないカラムは区別できないよう、同じメッセージにする */
export const unknownColumn = (_name: string) =>
  badRequest("Unknown column or parameter", "unknown_column");

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * 例外を HTTP 応答へ変換する。SQL・テーブル構造・競合した値はクライアントへ出さない。
 */
export function toErrorResponse(error: unknown, dialect: DialectAdapter, c: Context): Response {
  if (error instanceof ApiError) return c.json(errorBody(error.code, error.message), error.status);
  if (error instanceof HTTPException) {
    return c.json(errorBody("http_error", error.message), error.status as ContentfulStatusCode);
  }
  const n = dialect.normalizeError(error);
  switch (n.type) {
    case "unique_violation":
    case "foreign_key_violation":
      return c.json(
        errorBody("conflict", "The request conflicts with the current state of the resource"),
        409,
      );
    case "serialization_failure":
    case "deadlock":
      return c.json(errorBody("conflict", "Concurrent update conflict. Retry the request"), 409);
    case "not_null_violation":
    case "check_violation":
    case "data_exception":
      return c.json(errorBody("invalid_value", "The request violates a data constraint"), 400);
    case "lock_timeout":
    case "connection_error":
    case "timeout":
      return c.json(errorBody("unavailable", "The service is temporarily unavailable"), 503);
    case "unknown": {
      const e = error as { name?: unknown; code?: unknown };
      console.error("[autoapi] internal error", { name: e?.name, code: e?.code });
      return c.json(errorBody("internal_error", "Internal server error"), 500);
    }
  }
}
