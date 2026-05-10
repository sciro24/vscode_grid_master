export type InferredType = 'string' | 'number' | 'boolean' | 'date' | 'null';

export interface ColumnSchema {
  name: string;
  index: number;
  inferredType: InferredType;
  nullable: boolean;
  userOverrideType?: InferredType; // from .gridmaster.json sidecar
}

export interface DataChunk {
  rows: CellValue[][];
  startRow: number;
  endRow: number;
}

export type CellValue = string | number | boolean | null;

export interface FilterSpec {
  colIndex: number;
  op: FilterOp;
  value: string | number;
}

export type FilterOp = 'eq' | 'neq' | 'contains' | 'not_contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'regex' | 'is_null' | 'is_not_null';

export interface SortSpec {
  colIndex: number;
  direction: 'asc' | 'desc';
}

export interface ColumnStats {
  colIndex: number;
  nullCount: number;
  uniqueCount: number;
  min?: CellValue;
  max?: CellValue;
  mean?: number;
  topValues: Array<{ value: CellValue; count: number }>;
}

export interface SidecarData {
  version: 1;
  columnOverrides: Record<string, InferredType>; // col name → type
  bookmarks: Bookmark[];
  columnWidths: Record<string, number>;         // col name → px
  hiddenColumns: string[];                      // col names that are hidden
  pinnedColumns: { left: string[]; right: string[] };
  /** Saved filters keyed by column name (so they survive reorder/rename via name match). */
  filters?: Array<{ column: string; op: FilterOp; value: string | number | null }>;
  /** True if the column-colour palette is currently active. */
  colorsActive?: boolean;
  /** Sort by column name + direction; null/undefined → no saved sort. */
  sort?: { column: string; direction: 'asc' | 'desc' } | null;
}

export interface Bookmark {
  row: number;
  label: string;
  color?: string;
}
