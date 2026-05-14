import type { ColumnSchema, ColumnStats, DataChunk, FilterSpec, SortSpec } from './schema.js';

// ── Host → Webview ───────────────────────────────────────────────────────────

export type HostMessage =
  | { type: 'INIT';                   payload: InitPayload }
  | { type: 'CHUNK';                  payload: ChunkPayload }
  | { type: 'SCHEMA_UPDATE';          payload: SchemaUpdatePayload }
  | { type: 'EDIT_ACK';              payload: EditAckPayload }
  | { type: 'SAVE_ACK';              payload: SaveAckPayload }
  | { type: 'COLUMN_STATS';          payload: ColumnStatsPayload }
  | { type: 'EXPORT_DONE';           payload: ExportDonePayload }
  | { type: 'EXPORT_START';          payload: ExportStartPayload }
  | { type: 'EXPORT_PROGRESS';       payload: ExportProgressPayload }
  | { type: 'WEBVIEW_UNDO' }
  | { type: 'WEBVIEW_REDO' }
  | { type: 'LOADING';               payload: LoadingPayload }
  | { type: 'ERROR';                 payload: ErrorPayload }
  | { type: '__LARGE_FILE_WARNING__'; payload: LargeFileWarningPayload };

export interface InitPayload {
  fileType: 'csv' | 'parquet' | 'arrow' | 'json' | 'excel' | 'avro' | 'sqlite' | 'orc';
  fileName: string;
  totalRows: number;          // -1 = unknown (streaming)
  totalBytes: number;
  schema: ColumnSchema[];
  firstChunk: DataChunk;
  sidecar?: import('./schema.js').SidecarData;
  duckWorkerUrl?: string;     // webview-safe URL for duckdb.worker.js (Parquet/Arrow only)
}

export interface ChunkPayload {
  requestId: string;
  chunk: DataChunk;
  filteredTotal?: number;     // row count after filters (for status bar)
}

export interface SchemaUpdatePayload {
  schema: ColumnSchema[];
}

export interface EditAckPayload {
  editId: string;
  success: boolean;
  error?: string;
}

export interface SaveAckPayload {
  success: boolean;
  error?: string;
}

export interface ColumnStatsPayload {
  requestId: string;
  stats: ColumnStats;
}

export interface ExportDonePayload {
  success: boolean;
  path?: string;
  error?: string;
}

export interface ExportStartPayload {
  fsPath: string;
  format: 'csv' | 'tsv' | 'json';
}

export interface ExportProgressPayload {
  pct: number;
}


export interface LoadingPayload {
  active: boolean;
  message?: string;
  progress?: number;          // 0–100
}

export interface ErrorPayload {
  code: string;
  message: string;
  detail?: string;
}

export interface LargeFileWarningPayload {
  fileSizeMb: number;
}

// ── Webview → Host ───────────────────────────────────────────────────────────

export type WebviewMessage =
  | { type: 'READY' }
  | { type: 'CAN_UNDO_STATE';          payload: { canUndo: boolean; canRedo: boolean } }
  | { type: 'REQUEST_CHUNK';           payload: ChunkRequestPayload }
  | { type: 'EDIT';                    payload: EditPayload }
  | { type: 'BATCH_EDIT';             payload: BatchEditPayload }
  | { type: 'SAVE' }
  | { type: 'SAVE_DATA';              payload: SaveDataPayload }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'EXPORT';                 payload: ExportPayload }
  | { type: 'EXPORT_DATA';            payload: ExportDataPayload }
  | { type: 'EXPORT_DATA_BATCH';      payload: ExportDataBatchPayload }
  | { type: 'EXPORT_CANCEL' }
  | { type: 'SAVE_SIDECAR';          payload: SaveSidecarPayload }
  | { type: 'UPDATE_DELIMITER';       payload: UpdateDelimiterPayload }
  | { type: 'LARGE_FILE_OPEN_CONFIRM' }
  | { type: 'LARGE_FILE_OPEN_PREVIEW' }
  | { type: 'LARGE_FILE_OPEN_CANCEL' }
  | { type: 'LARGE_FILE_STREAM_CANCEL' };

export interface SaveDataPayload {
  /** Serialized text content the host should write to the document URI. */
  content: string;
}

export interface ChunkRequestPayload {
  requestId: string;
  startRow: number;
  endRow: number;
  filters?: FilterSpec[];
  sort?: SortSpec;
}

export interface EditPayload {
  editId: string;
  row: number;
  col: number;
  oldValue: import('./schema.js').CellValue;
  newValue: import('./schema.js').CellValue;
}

export interface BatchEditPayload {
  editId: string;
  edits: Array<{
    row: number;
    col: number;
    oldValue: import('./schema.js').CellValue;
    newValue: import('./schema.js').CellValue;
  }>;
}

export interface ExportPayload {
  format: 'csv' | 'tsv' | 'json' | 'parquet';
  selection?: { rows: number[]; cols: number[] };
  includeHeaders: boolean;
}

export interface SaveSidecarPayload {
  sidecar: import('./schema.js').SidecarData;
}

export interface UpdateDelimiterPayload {
  delimiter: string;
}

export interface ExportDataPayload {
  data: string;
}

export interface ExportDataBatchPayload {
  rows: import('./schema.js').CellValue[][];
  headers?: string[];
  batchIndex: number;
  totalBatches: number;
  done: boolean;
  format: 'csv' | 'tsv' | 'json';
  delimiter?: string;
}

export interface ParseWarning {
  row: number;
  line?: number;
  message: string;
}
