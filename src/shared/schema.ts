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


export type EditOp =
  | { kind: 'CELL_EDIT'; row: number; col: number; oldValue: CellValue; newValue: CellValue }
  | { kind: 'ROW_INSERT'; row: number; insertedRow: CellValue[] }
  | { kind: 'ROW_DELETE'; row: number; deletedRow: CellValue[] }
  | { kind: 'COL_INSERT'; colIndex: number; insertedCol: ColumnSchema; insertedValues: CellValue[] }
  | { kind: 'COL_DELETE'; colIndex: number; deletedCol: ColumnSchema; deletedValues: CellValue[] }
  | { kind: 'COL_RENAME'; colIndex: number; oldName: string; newName: string };

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
  /** Visual column order as array of schema indices. Absent = natural order. */
  columnOrder?: number[];
  /** Schema indices of individually frozen columns. Absent = none frozen. */
  frozenCols?: number[];
  /** Last selected sheet name for Excel files. Absent = first sheet. */
  selectedSheet?: string;
  /** Committed edit history for undo/redo across sessions. Each entry is one commit (array of ops). */
  editHistory?: EditOp[][];
  /** Pointer into editHistory: next undo target = editHistory[historyIndex - 1]. */
  historyIndex?: number;
}

export interface Bookmark {
  row: number;
  label: string;
  color?: string;
}
