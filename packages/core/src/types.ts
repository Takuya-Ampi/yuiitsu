import type { Context, Env } from "hono";
import type {
  Expression,
  Insertable,
  Kysely,
  Selectable,
  SqlBool,
  Transaction,
  Updateable,
} from "kysely";

export type NormalizedType =
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "datetime"
  | "json"
  | "uuid"
  | "unknown";

export type ColumnMeta = {
  name: string;
  type: NormalizedType;
  nativeType: string;
  nullable: boolean;
  hasDefault: boolean;
  /** 自動採番、生成カラムなど、DB が値を決めるカラム */
  isGenerated: boolean;
  /** 自動採番のカラム(INSERT 後に採番値を取得できるもの) */
  isAutoIncrement: boolean;
  /** 文字列カラムの文字コード(MySQL のみ。他は null) */
  charset: string | null;
};

export type ForeignKeyMeta = {
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
};

export type TableMeta = {
  schema: string | null;
  name: string;
  primaryKey: string[];
  columns: ColumnMeta[];
  foreignKeys: ForeignKeyMeta[];
  /** MySQL のみ(ストレージエンジン名)。仕様の SchemaMeta への拡張 */
  engine?: string | null;
};

export type SchemaMeta = {
  dialect: "postgres" | "mysql" | "sqlite";
  tables: TableMeta[];
};

export type NormalizedDatabaseError =
  | { type: "unique_violation"; cause: unknown }
  | { type: "foreign_key_violation"; cause: unknown }
  | { type: "not_null_violation"; cause: unknown }
  | { type: "check_violation"; cause: unknown }
  | { type: "data_exception"; cause: unknown }
  | { type: "serialization_failure"; cause: unknown }
  | { type: "deadlock"; cause: unknown }
  | { type: "lock_timeout"; cause: unknown }
  | { type: "connection_error"; cause: unknown }
  | { type: "timeout"; cause: unknown }
  | { type: "unknown"; cause: unknown };

export interface DialectAdapter {
  name: "postgres" | "mysql" | "sqlite";

  capabilities: {
    returning: boolean;
    lockingRead: boolean;
    jsonOperators: boolean;
    foreignKeyIntrospection: boolean;
    retryOnSerializationFailure: boolean;
  };

  introspect(db: Kysely<any>, options: { pgSchema?: string }): Promise<SchemaMeta>;

  /** 公開対象にできないテーブルなら、理由を含む Error を投げる(MySQL の InnoDB 以外など) */
  assertTableSupported(table: TableMeta): void;

  /**
   * 起動時の環境確認。致命的な問題は例外、注意事項は警告文字列で返す。
   * `exposesDatetime` は datetime カラムを公開しているか。
   */
  preflight(db: Kysely<any>, info: { exposesDatetime: boolean }): Promise<string[]>;

  /** DB の値 → API 上の JSON 値 */
  decodeValue(type: NormalizedType, value: unknown): unknown;
  /** API 上の JSON 値 → DB に渡す値 */
  encodeValue(type: NormalizedType, value: unknown): unknown;
  /** DB 側の表現の値が型に適合するか(hook 適用後の再検証) */
  validateDbValue(type: NormalizedType, value: unknown): boolean;

  writeTransaction<T>(db: Kysely<any>, fn: (trx: Transaction<any>) => Promise<T>): Promise<T>;

  /** NULL を最後にする ORDER BY 式。順に orderBy へ渡す */
  orderByNullsLast(column: string, direction: "asc" | "desc"): Expression<unknown>[];
  caseSensitiveLike(column: string, pattern: string): Expression<SqlBool>;
  caseInsensitiveLike(column: string, pattern: string): Expression<SqlBool>;
  supportsPatternMatch(column: ColumnMeta): boolean;

  normalizeError(error: unknown): NormalizedDatabaseError;
}

export type Operation = "read" | "create" | "update" | "delete";
export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is";

/** `{ column: { op: value } }` を AND で結合したもの。`is` の値は null または 'not_null' */
export type ScopeFilter = Record<string, Partial<Record<FilterOp, unknown>>>;
export type ScopeFn<E extends Env> = (
  c: Context<E>,
) => ScopeFilter | true | Promise<ScopeFilter | true>;

export type HookContext<DB, E extends Env> = {
  c: Context<E>;
  db: Kysely<DB>;
  table: string;
};

export type AfterCommitHookContext<DB, E extends Env> = HookContext<DB, E> & {
  signal: AbortSignal;
};

export type Hooks<DB, T extends keyof DB, E extends Env> = {
  beforeCreate?: (ctx: HookContext<DB, E>, data: Insertable<DB[T]>) => Promise<Insertable<DB[T]>>;
  afterCreate?: (ctx: HookContext<DB, E>, row: Selectable<DB[T]>) => Promise<void>;
  afterCommitCreate?: (ctx: AfterCommitHookContext<DB, E>, row: Selectable<DB[T]>) => Promise<void>;

  beforeUpdate?: (
    ctx: HookContext<DB, E>,
    id: unknown,
    data: Updateable<DB[T]>,
  ) => Promise<Updateable<DB[T]>>;
  afterUpdate?: (ctx: HookContext<DB, E>, row: Selectable<DB[T]>) => Promise<void>;
  afterCommitUpdate?: (ctx: AfterCommitHookContext<DB, E>, row: Selectable<DB[T]>) => Promise<void>;

  beforeDelete?: (ctx: HookContext<DB, E>, id: unknown) => Promise<void>;
  afterDelete?: (ctx: HookContext<DB, E>, row: Selectable<DB[T]>) => Promise<void>;
  afterCommitDelete?: (ctx: AfterCommitHookContext<DB, E>, row: Selectable<DB[T]>) => Promise<void>;
};

export type TableConfig<DB, T extends keyof DB & string, E extends Env> = {
  operations: Operation[];
  columns?: {
    read?: Array<keyof DB[T] & string>;
    create?: Array<keyof DB[T] & string>;
    update?: Array<keyof DB[T] & string>;
  };
  scope?: ScopeFn<E>;
  hooks?: Hooks<DB, T, E>;
};

export type TablesConfig<DB, E extends Env> = {
  [T in keyof DB & string]?: TableConfig<DB, T, E>;
};

export type DefaultDB = Record<string, Record<string, unknown>>;

export type AfterCommitErrorInfo<E extends Env> = {
  table: string;
  operation: "create" | "update" | "delete";
  reason: "error" | "timeout";
  c: Context<E>;
};

export type AutoApiOptions<DB = DefaultDB, E extends Env = Env> = {
  db: Kysely<any>;
  dialect: DialectAdapter;
  pgSchema?: string;
  schema?: SchemaMeta;
  tables: TablesConfig<DB, E>;
  limits?: { defaultLimit?: number; maxLimit?: number; maxInValues?: number };
  hooks?: {
    afterCommitTimeoutMs?: number;
    onAfterCommitError?: (error: unknown, info: AfterCommitErrorInfo<E>) => void | Promise<void>;
  };
  openapi?: {
    security?: Array<Record<string, string[]>>;
    tags?: string[] | ((table: string) => string[]);
  };
  /** 起動時の警告の出力先。既定は console.warn */
  onWarning?: (message: string) => void;
};
