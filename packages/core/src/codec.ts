/** dialect-* が共有する、値の変換の部品(DB ドライバには依存しない) */

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** 安全な整数の範囲の number にする。範囲外・非整数は ValueError */
export function toSafeInteger(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    throw new ValueError("integer out of safe range");
  }
  if (typeof value === "bigint") {
    if (value <= MAX && value >= -MAX) return Number(value);
    throw new ValueError("integer out of safe range");
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const b = BigInt(value);
    if (b <= MAX && b >= -MAX) return Number(b);
    throw new ValueError("integer out of safe range");
  }
  throw new ValueError("expected integer");
}

export function isSafeIntegerLike(value: unknown): boolean {
  try {
    toSafeInteger(value);
    return typeof value !== "string";
  } catch {
    return false;
  }
}

export function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new ValueError("expected number");
}

export function toText(value: unknown): string {
  if (typeof value === "string") return value;
  throw new ValueError("expected string");
}

export function toUuid(value: unknown): string {
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ValueError("expected uuid");
}

export function toBoolean01(value: unknown): boolean {
  if (value === 1 || value === 1n || value === true) return true;
  if (value === 0 || value === 0n || value === false) return false;
  throw new ValueError("expected 0 or 1");
}

// ---- datetime ---------------------------------------------------------------

/** オフセット付き RFC 3339。小数秒はミリ秒(最大 3 桁)まで */
export const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/i;

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** API の入力を Date にする。形式・暦が不正なら null */
export function parseApiDatetime(s: string): Date | null {
  const m = RFC3339_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || sec > 59)
    return null;
  const off = m[8]!;
  if (off !== "Z" && off !== "z") {
    const oh = Number(off.slice(1, 3));
    const om = Number(off.slice(4, 6));
    if (oh > 23 || om > 59) return null;
  }
  const date = new Date(s);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** UTC・末尾 Z・ミリ秒精度 */
export function formatDatetime(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new ValueError("invalid datetime");
  return d.toISOString();
}

/** SQLite が TEXT で保存する形式 */
export const STORED_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseStoredIso(s: string): Date {
  if (!STORED_ISO_RE.test(s)) throw new ValueError("invalid stored datetime");
  const d = new Date(s);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== s)
    throw new ValueError("invalid stored datetime");
  return d;
}

/** unknown 型の読み取り表現(JSON 化できる形へ)。docs/decisions.md に記録 */
export function decodeUnknown(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value) || typeof value === "object") return value;
  throw new ValueError("unsupported value");
}

export function isValidJsonText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
