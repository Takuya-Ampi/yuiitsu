import type { ColumnMeta, Operation, TableMeta } from "./types";

type ColumnsConfig = {
  read?: readonly string[];
  create?: readonly string[];
  update?: readonly string[];
};

/**
 * 操作ごとに使えるカラム名を決める。runtime の確認と zod スキーマ(OpenAPI)の生成の
 * 両方が、この関数を使う(フィルタ・ソート・select も read と同じ)。
 */
export function resolveColumns(
  table: TableMeta,
  config: ColumnsConfig | undefined,
  operation: "read" | "create" | "update",
): string[] {
  const explicit = config?.[operation];
  if (explicit) return [...explicit];
  const pk = new Set(table.primaryKey);
  switch (operation) {
    case "read":
      return table.columns.map((c) => c.name);
    case "create":
      return table.columns
        .filter((c) => !c.isGenerated && !c.isAutoIncrement && c.type !== "unknown")
        .map((c) => c.name);
    case "update":
      return table.columns
        .filter(
          (c) => !pk.has(c.name) && !c.isGenerated && !c.isAutoIncrement && c.type !== "unknown",
        )
        .map((c) => c.name);
  }
}

export const OPERATIONS: readonly Operation[] = ["read", "create", "update", "delete"];

export function columnByName(table: TableMeta, name: string): ColumnMeta | undefined {
  return table.columns.find((c) => c.name === name);
}
