import type { ColumnSchema, CellValue, FilterSpec, SortSpec, ColumnStats, SidecarData } from '@shared/schema.js';
import type { InitPayload, ChunkPayload, EditAckPayload, ColumnStatsPayload } from '@shared/messages.js';
import type { DuckDbWorkerIn, DuckDbWorkerOut } from '../workers/duckdb.worker.js';
import { CHUNK_SIZE, MAX_CHUNKS_IN_MEMORY } from '@shared/constants.js';
import { uiStore } from './ui.svelte.js';
import Papa from 'papaparse';
import { postMessage } from '../bridge/vscode.js';

// LRU chunk cache: rowStart → rows
type ChunkCache = Map<number, CellValue[][]>;

export interface ColumnReport {
  colIndex: number;
  name: string;
  type: string;
  total: number;
  nulls: number;
  distinct: number;
  top: { value: string; count: number }[];
  numeric?: {
    min: number;
    max: number;
    mean: number;
    median: number;
    stddev: number;
    sum: number;
    histogram: { from: number; to: number; count: number }[];
  };
}

export type EditAction =
  | { kind: 'CELL_EDIT'; row: number; col: number; oldValue: CellValue; newValue: CellValue }
  | { kind: 'ROW_INSERT'; row: number; insertedRow: CellValue[] }
  | { kind: 'ROW_DELETE'; row: number; deletedRow: CellValue[] }
  | { kind: 'COL_INSERT'; colIndex: number; insertedCol: ColumnSchema; insertedValues: CellValue[] }
  | { kind: 'COL_DELETE'; colIndex: number; deletedCol: ColumnSchema; deletedValues: CellValue[] }
  | { kind: 'COL_RENAME'; colIndex: number; oldName: string; newName: string };

export interface DatasetReport {
  totalRows: number;
  totalCols: number;
  totalCells: number;
  nullCells: number;
  nullPct: number;
  typeCounts: Record<string, number>;
  columns: {
    index: number;
    name: string;
    type: string;
    nulls: number;
    nullPct: number;
    distinct: number;
    mean?: number;
    min?: number;
    max?: number;
  }[];
}

class GridStore {
  // File metadata
  fileType = $state<'csv' | 'parquet' | 'arrow' | 'json' | 'excel' | 'avro' | 'sqlite' | 'orc'>('csv');
  fileName = $state('');
  totalRows = $state(0);
  filteredRows = $state(0);
  totalBytes = $state(0);

  // Schema & columns
  schema = $state<ColumnSchema[]>([]);
  hiddenCols = $state<Set<number>>(new Set());
  colWidths = $state<Map<string, number>>(new Map());

  // Grid data
  private _cache: ChunkCache = new Map();
  private _accessOrder: number[] = [];

  // Reactive counter — bumped on any cache mutation so derived UI re-renders.
  // Plain Maps aren't reactive in Svelte 5, this is the cheapest fix.
  cacheVersion = $state(0);

  // CSV-only: full dataset held in memory for inline filter/sort
  private _csvAllRows: CellValue[][] = [];

  // Maps visible-row index (after filter/sort) → actual index in _csvAllRows.
  // Empty when there are no filters/sort/search active (identity mapping).
  private _viewToActual: number[] = [];

  // Auto-fitted column widths, keyed by column name. Computed once after data load.
  private _autoWidths = new Map<string, number>();

  // Viewport
  visibleStartRow = $state(0);
  visibleEndRow = $state(50);

  // Filters & sort
  filters = $state<FilterSpec[]>([]);
  sort = $state<SortSpec | null>(null);
  globalSearch = $state('');

  // Selection — these can coexist:
  //  - selectedRow + selectedCol = "cross selection", the cell at the intersection
  //    is highlighted distinctly.
  //  - selectedCell is mutually exclusive with row/col selection.
  selectedCell = $state<{ row: number; col: number } | null>(null);
  selectedRange = $state<{ r1: number; c1: number; r2: number; c2: number } | null>(null);
  selectedRow = $state<number | null>(null);
  selectedCol = $state<number | null>(null);

  // Workers (DuckDB only — CSV is parsed inline in the main thread)
  private _duckWorker: Worker | null = null;
  private _pendingRequests = new Map<string, (rows: CellValue[][]) => void>();

  // Column colors: colIndex → CSS color string
  colColors = $state<Map<number, string>>(new Map());

  // Sidecar
  sidecar = $state<SidecarData | null>(null);

  // Column stats cache
  private _statsCache = new Map<number, ColumnStats>();

  // Edit history for in-webview undo / discard.
  // Each entry is a strongly-typed action so we can correctly invert it on undo.
  private _editHistory: EditAction[] = [];
  editCount = $state(0);  // reactive proxy for _editHistory.length

  // ── Init ──────────────────────────────────────────────────────────────────

  init(payload: InitPayload): void {
    this.fileType = payload.fileType;
    this.fileName = payload.fileName;
    this.totalBytes = payload.totalBytes;
    this.schema = payload.schema;
    // The sidecar is stored now but applied later, *after* the schema is fully
    // populated (which happens when CSV / raw-rows arrive, or when the worker
    // posts READY for binary formats). _applySidecar relies on schema names
    // to map saved hidden-cols/filters/sort back to the current indices.
    if (payload.sidecar) {
      this.sidecar = payload.sidecar;
      if (payload.schema.length > 0) {
        // INIT already had schema (rare but possible) → apply right away.
        this._applySidecar(payload.sidecar);
      }
    }
  }

  // Called by the entry points that populate `schema` for real
  // (receiveCsvData, receiveRawRows, the worker READY handler) so we can
  // restore hidden columns / filters / sort / palette once the schema is known.
  private _applyPendingSidecar(): void {
    if (this.sidecar && this.schema.length > 0) {
      this._applySidecar(this.sidecar);
    }
  }

  setDuckWorker(duckdb: Worker): void {
    this._duckWorker = duckdb;
    this._duckWorker.onmessage = (e: MessageEvent<DuckDbWorkerOut>) => this._handleDuckWorkerMsg(e.data);
  }

  private _workerReady: Promise<Worker> | null = null;

  private _getOrCreateWorker(): Promise<Worker> {
    if (this._workerReady) return this._workerReady;
    const url = (globalThis as Record<string, unknown>)['__DUCK_WORKER_URL__'] as string | undefined;
    if (!url) {
      this._workerReady = Promise.reject(new Error('DuckDB worker URL not set'));
      return this._workerReady;
    }
    this._workerReady = (async () => {
      console.log('[GM] fetching worker from', url);
      const resp = await fetch(url);
      console.log('[GM] fetch status', resp.status, resp.ok);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching worker`);
      const text = await resp.text();
      console.log('[GM] worker text length', text.length);
      const blob = new Blob([text], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      console.log('[GM] creating classic Worker from blob');
      const worker = new Worker(blobUrl);
      worker.onerror = (e) => console.error('[GM] worker onerror', e);
      this.setDuckWorker(worker);
      console.log('[GM] worker ready');
      return worker;
    })();
    return this._workerReady;
  }

  // Called by inline CSV parser in messageHandler.ts
  receiveCsvData(schema: ColumnSchema[], allRows: CellValue[][]): void {
    this.schema = schema;
    this.totalRows = allRows.length;
    this.filteredRows = allRows.length;
    this._csvAllRows = allRows;
    this._computeAutoWidths(schema, allRows);
    this._applyPendingSidecar();
    this._storeChunk(0, allRows.slice(0, CHUNK_SIZE));
    // Ensure the chunk reflects any sidecar-restored filter/sort.
    if (this.filters.length > 0 || this.sort) this._invalidateCache();
  }

  // Sample first N rows + header to estimate optimal column widths.
  // Uses character-count heuristic (fast, no DOM measurement needed).
  private _computeAutoWidths(schema: ColumnSchema[], rows: CellValue[][]): void {
    const SAMPLE = Math.min(rows.length, 200);
    const CHAR_PX = 7.2;          // approx char width at 12px monospace
    const PADDING = 24;           // 8px each side + a little slack
    const TYPE_LABEL_PAD = 14;    // header has type sub-label
    const MIN_W = 60;
    const MAX_W = 400;

    for (const col of schema) {
      let maxLen = col.name.length + 2;
      for (let i = 0; i < SAMPLE; i++) {
        const v = rows[i]?.[col.index];
        if (v === null || v === undefined) continue;
        const s = String(v);
        if (s.length > maxLen) maxLen = s.length;
      }
      const w = Math.max(MIN_W, Math.min(MAX_W, Math.ceil(maxLen * CHAR_PX) + PADDING + TYPE_LABEL_PAD));
      this._autoWidths.set(col.name, w);
    }
  }

  getAutoWidth(colName: string): number | undefined {
    return this._autoWidths.get(colName);
  }

  loadRawBinary(
    buffer: ArrayBuffer,
    fileType: 'parquet' | 'arrow' | 'json',
    duckBundles: import('../workers/duckdb.worker.js').DuckDbBundleSet,
    jsonFormat?: 'json' | 'ndjson',
  ): void {
    this.fileType = fileType;
    console.log('[GM] loadRawBinary', fileType, 'bundles=', duckBundles);
    this._getOrCreateWorker().then(worker => {
      console.log('[GM] sending LOAD to worker');
      const msg: DuckDbWorkerIn = { type: 'LOAD', payload: { buffer, fileType, jsonFormat, bundles: duckBundles } };
      worker.postMessage(msg, [buffer]);
    }).catch(e => uiStore.setError(String(e)));
  }

  loadRawBinaryParts(
    buffers: ArrayBuffer[],
    fileType: 'parquet' | 'arrow',
    duckBundles: import('../workers/duckdb.worker.js').DuckDbBundleSet,
  ): void {
    this.fileType = fileType;
    console.log('[GM] loadRawBinaryParts', fileType, buffers.length, 'parts');
    this._getOrCreateWorker().then(worker => {
      console.log('[GM] sending LOAD_PARTS to worker');
      const msg: DuckDbWorkerIn = { type: 'LOAD_PARTS', payload: { buffers, fileType, bundles: duckBundles } };
      worker.postMessage(msg, buffers);
    }).catch(e => uiStore.setError(String(e)));
  }

  // ── Data Access ───────────────────────────────────────────────────────────

  getCell(row: number, col: number): CellValue {
    const chunkStart = Math.floor(row / CHUNK_SIZE) * CHUNK_SIZE;
    const chunk = this._cache.get(chunkStart);
    if (!chunk) {
      this._requestChunk(chunkStart, chunkStart + CHUNK_SIZE);
      return null;
    }
    return chunk[row - chunkStart]?.[col] ?? null;
  }

  updateViewport(startRow: number, endRow: number): void {
    this.visibleStartRow = startRow;
    this.visibleEndRow = endRow;

    const prefetchStart = Math.max(0, Math.floor(startRow / CHUNK_SIZE) - 1) * CHUNK_SIZE;
    const prefetchEnd = (Math.floor(endRow / CHUNK_SIZE) + 2) * CHUNK_SIZE;

    for (let s = prefetchStart; s < prefetchEnd; s += CHUNK_SIZE) {
      if (!this._cache.has(s)) {
        this._requestChunk(s, s + CHUNK_SIZE);
      }
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  setCellValue(row: number, col: number, value: CellValue): void {
    const actualRow = this._actualRowIndex(row);
    const chunkStart = Math.floor(row / CHUNK_SIZE) * CHUNK_SIZE;
    const chunk = this._cache.get(chunkStart);
    let oldValue: CellValue = null;
    if (chunk) {
      const rowData = chunk[row - chunkStart];
      if (rowData) {
        oldValue = rowData[col] ?? null;
        rowData[col] = value;
      }
    }
    // Mirror into the master CSV array using the *actual* index so the change
    // survives a re-chunk after filter/sort.
    if (this.fileType === 'csv' && this._csvAllRows[actualRow]) {
      if (oldValue === null && this._csvAllRows[actualRow][col] !== undefined) {
        oldValue = this._csvAllRows[actualRow][col];
      }
      this._csvAllRows[actualRow][col] = value;
    }
    this._editHistory.push({ kind: 'CELL_EDIT', row: actualRow, col, oldValue, newValue: value });
    this.editCount = this._editHistory.length;
    this.cacheVersion++;
    uiStore.markDirty();
  }

  // Invert a single action (last-in, first-out) on _csvAllRows + schema.
  // Does not touch _editHistory or uiStore — the caller manages those.
  private _revertAction(a: EditAction): void {
    switch (a.kind) {
      case 'CELL_EDIT':
        if (this._csvAllRows[a.row]) this._csvAllRows[a.row][a.col] = a.oldValue;
        break;
      case 'ROW_INSERT':
        // Was inserted at a.row → remove it.
        if (this._csvAllRows.length > a.row) this._csvAllRows.splice(a.row, 1);
        this.totalRows = this._csvAllRows.length;
        break;
      case 'ROW_DELETE':
        // Was removed from a.row → put it back.
        this._csvAllRows.splice(a.row, 0, [...a.deletedRow]);
        this.totalRows = this._csvAllRows.length;
        break;
      case 'COL_INSERT':
        // Was inserted at a.colIndex → remove the column from every row + schema.
        for (const row of this._csvAllRows) row.splice(a.colIndex, 1);
        this.schema = this.schema
          .filter((_, i) => i !== a.colIndex)
          .map((c, i) => ({ ...c, index: i }));
        // Roll back the index shifts that duplicateColumn applied to filters/sort/colors/hidden.
        this.filters = this.filters.filter(f => f.colIndex !== a.colIndex)
          .map(f => f.colIndex > a.colIndex ? { ...f, colIndex: f.colIndex - 1 } : f);
        if (this.sort?.colIndex === a.colIndex) this.sort = null;
        else if (this.sort && this.sort.colIndex > a.colIndex) this.sort = { ...this.sort, colIndex: this.sort.colIndex - 1 };
        if (this.colColors.size > 0) {
          const next = new Map<number, string>();
          for (const [k, v] of this.colColors) {
            if (k === a.colIndex) continue;
            next.set(k > a.colIndex ? k - 1 : k, v);
          }
          this.colColors = next;
        }
        if (this.hiddenCols.size > 0) {
          const next = new Set<number>();
          for (const k of this.hiddenCols) {
            if (k === a.colIndex) continue;
            next.add(k > a.colIndex ? k - 1 : k);
          }
          this.hiddenCols = next;
        }
        break;
      case 'COL_DELETE': {
        // Re-insert the deleted column at its old position.
        for (let i = 0; i < this._csvAllRows.length; i++) {
          this._csvAllRows[i].splice(a.colIndex, 0, a.deletedValues[i] ?? null);
        }
        const restored = { ...a.deletedCol, index: a.colIndex };
        const updated = [
          ...this.schema.slice(0, a.colIndex).map(c => ({ ...c })),
          restored,
          ...this.schema.slice(a.colIndex).map(c => ({ ...c, index: c.index + 1 })),
        ];
        this.schema = updated;
        // Reverse the index shifts that deleteColumn did on filters/sort/colors/hidden.
        this.filters = this.filters.map(f => f.colIndex >= a.colIndex ? { ...f, colIndex: f.colIndex + 1 } : f);
        if (this.sort && this.sort.colIndex >= a.colIndex) this.sort = { ...this.sort, colIndex: this.sort.colIndex + 1 };
        if (this.colColors.size > 0) {
          const next = new Map<number, string>();
          for (const [k, v] of this.colColors) next.set(k >= a.colIndex ? k + 1 : k, v);
          this.colColors = next;
        }
        if (this.hiddenCols.size > 0) {
          const next = new Set<number>();
          for (const k of this.hiddenCols) next.add(k >= a.colIndex ? k + 1 : k);
          this.hiddenCols = next;
        }
        break;
      }
      case 'COL_RENAME':
        this.schema = this.schema.map((c, i) => i === a.colIndex ? { ...c, name: a.oldName } : c);
        if (this.colWidths.has(a.newName)) {
          const w = this.colWidths.get(a.newName)!;
          const next = new Map(this.colWidths);
          next.delete(a.newName);
          next.set(a.oldName, w);
          this.colWidths = next;
        }
        break;
    }
  }

  undoLastEdit(): boolean {
    const last = this._editHistory.pop();
    if (!last) return false;
    this.editCount = this._editHistory.length;
    this._revertAction(last);
    if (this._editHistory.length === 0) {
      uiStore.isDirty = false;
      uiStore.saved = true;
    }
    this._invalidateCache();
    return true;
  }

  discardAllEdits(): void {
    // Walk the history in reverse, inverting each action.
    while (this._editHistory.length > 0) {
      const a = this._editHistory.pop()!;
      this._revertAction(a);
    }
    this.editCount = 0;
    uiStore.isDirty = false;
    uiStore.saved = true;
    this._invalidateCache();
  }

  clearEditHistory(): void {
    this._editHistory = [];
    this.editCount = 0;
    uiStore.isDirty = false;
    uiStore.saved = true;
  }

  // Serialise the full dataset back to CSV/TSV text, preserving the rename/insert/
  // delete history that's already baked into _csvAllRows + this.schema.
  // Returns null when called for a non-CSV file type (the host won't write).
  serializeCsv(): string | null {
    if (this.fileType !== 'csv') return null;
    const headers = this.schema.map(c => c.name);
    // Build plain rows aligned to the current column order (handles deletes/duplicates).
    const rows = this._csvAllRows.map(row =>
      this.schema.map(c => {
        const v = row[c.index];
        if (v === null || v === undefined) return '';
        // Booleans → 'true'/'false'; numbers/strings → String() — keep raw, no locale grouping.
        return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
      })
    );
    const delimiter = (this.fileName.toLowerCase().endsWith('.tsv')) ? '\t' : ',';
    return Papa.unparse({ fields: headers, data: rows }, {
      delimiter,
      newline: '\n',
      quotes: false,        // only quote when needed (PapaParse decides per-cell)
      skipEmptyLines: false,
    });
  }

  updateSchema(schema: ColumnSchema[]): void {
    this.schema = schema;
  }

  // ── Filters & Sort ────────────────────────────────────────────────────────

  setFilter(filter: FilterSpec): void {
    const idx = this.filters.findIndex(f => f.colIndex === filter.colIndex);
    if (idx >= 0) {
      this.filters = this.filters.map((f, i) => i === idx ? filter : f);
    } else {
      this.filters = [...this.filters, filter];
    }
    this._invalidateCache();
    this.persistSidecar();
  }

  removeFilter(colIndex: number): void {
    this.filters = this.filters.filter(f => f.colIndex !== colIndex);
    this._invalidateCache();
    this.persistSidecar();
  }

  clearFilters(): void {
    this.filters = [];
    this._invalidateCache();
    this.persistSidecar();
  }

  setSort(sort: SortSpec | null): void {
    this.sort = sort;
    this._invalidateCache();
    this.persistSidecar();
  }

  setGlobalSearch(query: string): void {
    // Volatile (per-session) search — not persisted.
    this.globalSearch = query;
    this._invalidateCache();
  }

  // ── Column ops ────────────────────────────────────────────────────────────

  toggleColumnVisibility(colIndex: number): void {
    const next = new Set(this.hiddenCols);
    if (next.has(colIndex)) next.delete(colIndex);
    else next.add(colIndex);
    this.hiddenCols = next;
    this.persistSidecar();
  }

  // ── Row operations ────────────────────────────────────────────────────────

  // Insert/duplicate would put the new row at an unpredictable visual position
  // when a sort is active (the empty/duplicated row gets re-sorted), confusing the user.
  // Drop the sort first so the new row appears exactly where it was placed.
  private _suspendSortForStructuralChange(): void {
    if (this.sort) this.sort = null;
  }

  deleteRow(visibleRow: number): void {
    if (this.fileType !== 'csv') return;
    const actual = this._actualRowIndex(visibleRow);
    const removed = this._csvAllRows[actual];
    if (!removed) return;
    this._csvAllRows.splice(actual, 1);
    this.totalRows = this._csvAllRows.length;
    this._editHistory.push({ kind: 'ROW_DELETE', row: actual, deletedRow: [...removed] });
    this.editCount = this._editHistory.length;
    this._invalidateCache();
    uiStore.markDirty();
  }

  insertRowAbove(visibleRow: number): void {
    if (this.fileType !== 'csv') return;
    this._suspendSortForStructuralChange();
    const actual = this._actualRowIndex(visibleRow);
    const empty = new Array(this.schema.length).fill(null) as CellValue[];
    this._csvAllRows.splice(actual, 0, empty);
    this.totalRows = this._csvAllRows.length;
    this._editHistory.push({ kind: 'ROW_INSERT', row: actual, insertedRow: [...empty] });
    this.editCount = this._editHistory.length;
    this._invalidateCache();
    uiStore.markDirty();
  }

  insertRowBelow(visibleRow: number): void {
    if (this.fileType !== 'csv') return;
    this._suspendSortForStructuralChange();
    const actual = this._actualRowIndex(visibleRow);
    const empty = new Array(this.schema.length).fill(null) as CellValue[];
    const at = actual + 1;
    this._csvAllRows.splice(at, 0, empty);
    this.totalRows = this._csvAllRows.length;
    this._editHistory.push({ kind: 'ROW_INSERT', row: at, insertedRow: [...empty] });
    this.editCount = this._editHistory.length;
    this._invalidateCache();
    uiStore.markDirty();
  }

  duplicateRow(visibleRow: number): void {
    if (this.fileType !== 'csv') return;
    this._suspendSortForStructuralChange();
    const actual = this._actualRowIndex(visibleRow);
    const src = this._csvAllRows[actual];
    if (!src) return;
    const copy = [...src];
    const at = actual + 1;
    this._csvAllRows.splice(at, 0, copy);
    this.totalRows = this._csvAllRows.length;
    this._editHistory.push({ kind: 'ROW_INSERT', row: at, insertedRow: [...copy] });
    this.editCount = this._editHistory.length;
    this._invalidateCache();
    uiStore.markDirty();
  }

  copyRowToClipboard(visibleRow: number): void {
    // Read directly from the chunk cache (works for any file type, not just CSV).
    const chunkStart = Math.floor(visibleRow / CHUNK_SIZE) * CHUNK_SIZE;
    const chunk = this._cache.get(chunkStart);
    const rowData = chunk?.[visibleRow - chunkStart];
    if (!rowData) return;
    const header = this.schema.map(c => c.name).join('\t');
    const line = this.schema.map(c => String(rowData[c.index] ?? '')).join('\t');
    navigator.clipboard.writeText(header + '\n' + line).catch(() => {});
  }

  // ── Column operations ─────────────────────────────────────────────────────

  deleteColumn(colIndex: number): void {
    if (this.fileType !== 'csv') return;
    const deletedCol = this.schema[colIndex];
    if (!deletedCol) return;
    const deletedValues: CellValue[] = this._csvAllRows.map(row => row[colIndex] ?? null);
    for (const row of this._csvAllRows) row.splice(colIndex, 1);
    this.schema = this.schema
      .filter(c => c.index !== colIndex)
      .map((c, i) => ({ ...c, index: i }));
    // Drop any filter/sort/color/hide tied to this column (otherwise they reference a phantom index).
    this.filters = this.filters.filter(f => f.colIndex !== colIndex)
      .map(f => f.colIndex > colIndex ? { ...f, colIndex: f.colIndex - 1 } : f);
    if (this.sort?.colIndex === colIndex) this.sort = null;
    else if (this.sort && this.sort.colIndex > colIndex) this.sort = { ...this.sort, colIndex: this.sort.colIndex - 1 };
    if (this.colColors.size > 0) {
      const next = new Map<number, string>();
      for (const [k, v] of this.colColors) {
        if (k === colIndex) continue;
        next.set(k > colIndex ? k - 1 : k, v);
      }
      this.colColors = next;
    }
    if (this.hiddenCols.size > 0) {
      const next = new Set<number>();
      for (const k of this.hiddenCols) {
        if (k === colIndex) continue;
        next.add(k > colIndex ? k - 1 : k);
      }
      this.hiddenCols = next;
    }
    this._editHistory.push({ kind: 'COL_DELETE', colIndex, deletedCol: { ...deletedCol }, deletedValues });
    this.editCount = this._editHistory.length;
    this._invalidateCache();
    uiStore.markDirty();
  }

  duplicateColumn(colIndex: number): void {
    if (this.fileType !== 'csv') return;
    const srcCol = this.schema[colIndex];
    if (!srcCol) return;
    let newName = srcCol.name + '_copy';
    let suffix = 1;
    const existingNames = new Set(this.schema.map(c => c.name));
    while (existingNames.has(newName)) {
      suffix++;
      newName = srcCol.name + '_copy' + suffix;
    }
    const insertedValues: CellValue[] = [];
    for (const row of this._csvAllRows) {
      const v = row[colIndex] ?? null;
      insertedValues.push(v);
      row.splice(colIndex + 1, 0, v);
    }
    const newCol = { ...srcCol, name: newName, index: colIndex + 1 };
    const updated = [
      ...this.schema.slice(0, colIndex + 1),
      newCol,
      ...this.schema.slice(colIndex + 1).map(c => ({ ...c, index: c.index + 1 })),
    ];
    this.schema = updated;
    // Shift filters/sort/colors/hidden cols whose index is past the insertion point.
    this.filters = this.filters.map(f => f.colIndex > colIndex ? { ...f, colIndex: f.colIndex + 1 } : f);
    if (this.sort && this.sort.colIndex > colIndex) this.sort = { ...this.sort, colIndex: this.sort.colIndex + 1 };
    if (this.colColors.size > 0) {
      const next = new Map<number, string>();
      for (const [k, v] of this.colColors) next.set(k > colIndex ? k + 1 : k, v);
      this.colColors = next;
    }
    if (this.hiddenCols.size > 0) {
      const next = new Set<number>();
      for (const k of this.hiddenCols) next.add(k > colIndex ? k + 1 : k);
      this.hiddenCols = next;
    }
    this._editHistory.push({ kind: 'COL_INSERT', colIndex: colIndex + 1, insertedCol: { ...newCol }, insertedValues });
    this.editCount = this._editHistory.length;
    this._invalidateCache();
    uiStore.markDirty();
  }

  renameColumn(colIndex: number, newName: string): boolean {
    const trimmed = newName.trim();
    if (!trimmed) return false;
    const col = this.schema[colIndex];
    if (!col) return false;
    if (col.name === trimmed) return false;
    if (this.schema.some((c, i) => i !== colIndex && c.name === trimmed)) {
      uiStore.setError(`A column named "${trimmed}" already exists`);
      return false;
    }
    const oldName = col.name;
    this.schema = this.schema.map((c, i) => i === colIndex ? { ...c, name: trimmed } : c);
    // Migrate the stored width keyed by name so the new column keeps its width.
    if (this.colWidths.has(oldName)) {
      const w = this.colWidths.get(oldName)!;
      const next = new Map(this.colWidths);
      next.delete(oldName);
      next.set(trimmed, w);
      this.colWidths = next;
    }
    this._editHistory.push({ kind: 'COL_RENAME', colIndex, oldName, newName: trimmed });
    this.editCount = this._editHistory.length;
    this.cacheVersion++;
    uiStore.markDirty();
    this.persistSidecar();
    return true;
  }

  copyColumnToClipboard(colIndex: number): void {
    const header = this.schema[colIndex]?.name ?? `col${colIndex}`;
    let sourceRows: CellValue[][];
    if (this._csvAllRows.length > 0) {
      // If a filter/sort/search is active, mirror the visible order; otherwise use the raw dataset.
      if (this._viewToActual.length > 0) {
        sourceRows = this._viewToActual.map(idx => this._csvAllRows[idx]);
      } else {
        sourceRows = this._csvAllRows;
      }
    } else {
      // Fallback to whatever is in the cache (Parquet/Arrow/JSON/Excel without full materialisation).
      sourceRows = [];
      for (const chunk of this._cache.values()) sourceRows.push(...chunk);
    }
    const values = sourceRows.map(row => String(row[colIndex] ?? ''));
    navigator.clipboard.writeText([header, ...values].join('\n')).catch(() => {});
  }

  filterByValue(colIndex: number, value: CellValue): void {
    this.setFilter({ colIndex, op: 'eq', value: value === null ? null : String(value) });
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  // Picking a single cell clears row/column selection (mutually exclusive).
  selectCell(row: number, col: number): void {
    this.selectedCell = { row, col };
    this.selectedRow = null;
    this.selectedCol = null;
  }

  // Row and column selections coexist so the user can see a "cross" at the intersection.
  // Selecting a row clears any previous single-cell selection.
  selectRow(row: number): void {
    this.selectedRow = row;
    this.selectedCell = null;
  }

  selectCol(col: number): void {
    this.selectedCol = col;
    this.selectedCell = null;
  }

  clearSelection(): void {
    this.selectedCell = null;
    this.selectedRow = null;
    this.selectedCol = null;
  }

  // ── Statistics ────────────────────────────────────────────────────────────

  // Returns the in-memory dataset rows when available (CSV/SQLite/Avro/ORC),
  // null otherwise (for Parquet/Arrow/JSON/Excel which stream from the worker).
  getAllRowsInMemory(): CellValue[][] | null {
    return this._csvAllRows.length > 0 ? this._csvAllRows : null;
  }

  computeColumnStats(colIndex: number): ColumnReport | null {
    const rows = this.getAllRowsInMemory();
    if (!rows) return null;
    const col = this.schema[colIndex];
    if (!col) return null;

    const total = rows.length;
    let nulls = 0;
    const numeric: number[] = [];
    const valueCounts = new Map<string, number>();

    for (const row of rows) {
      const v = row[colIndex];
      if (v === null || v === undefined || v === '') {
        nulls++;
        continue;
      }
      const key = String(v);
      valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1);
      const n = typeof v === 'number' ? v : Number(v);
      if (!isNaN(n) && isFinite(n)) numeric.push(n);
    }

    const distinct = valueCounts.size;
    const top = [...valueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));

    let numericStats: ColumnReport['numeric'] = undefined;
    if (numeric.length > 0 && col.inferredType === 'number') {
      numeric.sort((a, b) => a - b);
      const sum = numeric.reduce((s, n) => s + n, 0);
      const mean = sum / numeric.length;
      const median = numeric.length % 2 === 0
        ? (numeric[numeric.length / 2 - 1] + numeric[numeric.length / 2]) / 2
        : numeric[Math.floor(numeric.length / 2)];
      const variance = numeric.reduce((s, n) => s + (n - mean) ** 2, 0) / numeric.length;
      const stddev = Math.sqrt(variance);
      const min = numeric[0];
      const max = numeric[numeric.length - 1];

      // Histogram: 10 bins between min and max.
      const BINS = 10;
      const range = max - min || 1;
      const binSize = range / BINS;
      const histogram: { from: number; to: number; count: number }[] = [];
      for (let i = 0; i < BINS; i++) {
        histogram.push({ from: min + i * binSize, to: min + (i + 1) * binSize, count: 0 });
      }
      for (const n of numeric) {
        let bin = Math.floor((n - min) / binSize);
        if (bin >= BINS) bin = BINS - 1;
        if (bin < 0) bin = 0;
        histogram[bin].count++;
      }

      numericStats = { min, max, mean, median, stddev, sum, histogram };
    }

    return {
      colIndex,
      name: col.name,
      type: col.inferredType,
      total,
      nulls,
      distinct,
      top,
      numeric: numericStats,
    };
  }

  computeDatasetStats(): DatasetReport | null {
    const rows = this.getAllRowsInMemory();
    if (!rows) return null;

    const total = rows.length;
    const cols = this.schema.length;
    const totalCells = total * cols;
    let nullCells = 0;

    const perColumn = this.schema.map(col => {
      let nulls = 0;
      const seen = new Set<string>();
      let numericCount = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const row of rows) {
        const v = row[col.index];
        if (v === null || v === undefined || v === '') {
          nulls++;
          continue;
        }
        seen.add(String(v));
        const n = typeof v === 'number' ? v : Number(v);
        if (!isNaN(n) && isFinite(n)) {
          numericCount++;
          sum += n;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      }
      nullCells += nulls;
      const isNumeric = col.inferredType === 'number' && numericCount > 0;
      return {
        index: col.index,
        name: col.name,
        type: col.inferredType,
        nulls,
        nullPct: total === 0 ? 0 : (nulls / total) * 100,
        distinct: seen.size,
        mean: isNumeric ? sum / numericCount : undefined,
        min: isNumeric ? min : undefined,
        max: isNumeric ? max : undefined,
      };
    });

    return {
      totalRows: total,
      totalCols: cols,
      totalCells,
      nullCells,
      nullPct: totalCells === 0 ? 0 : (nullCells / totalCells) * 100,
      typeCounts: this.schema.reduce((acc, c) => {
        acc[c.inferredType] = (acc[c.inferredType] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      columns: perColumn,
    };
  }

  setColumnWidth(colName: string, width: number): void {
    this.colWidths = new Map(this.colWidths).set(colName, width);
    this.persistSidecar();
  }

  setColColors(colors: Map<number, string>): void {
    this.colColors = colors;
    this.persistSidecar();
  }

  toggleColColors(): void {
    if (this.colColors.size > 0) {
      this.colColors = new Map();
      this.persistSidecar();
      return;
    }
    // Muted pastel palette — good contrast on both light and dark VS Code themes.
    // Colors use low saturation + high lightness (light) or low lightness (dark);
    // we pick a single set of semi-transparent tints that work on both.
    const PALETTE = [
      'rgba(100, 149, 237, 0.12)', // cornflower blue
      'rgba(144, 238, 144, 0.12)', // light green
      'rgba(255, 182, 193, 0.14)', // light pink
      'rgba(255, 218, 120, 0.13)', // light gold
      'rgba(175, 238, 238, 0.14)', // pale turquoise
      'rgba(221, 160, 221, 0.14)', // plum
      'rgba(255, 160, 122, 0.13)', // light salmon
      'rgba(152, 251, 152, 0.12)', // pale green
      'rgba(135, 206, 250, 0.13)', // light sky blue
      'rgba(240, 230, 140, 0.13)', // khaki
    ];
    const next = new Map<number, string>();
    for (const col of this.schema) {
      next.set(col.index, PALETTE[col.index % PALETTE.length]);
    }
    this.colColors = next;
    this.persistSidecar();
  }

  get visibleSchema(): ColumnSchema[] {
    return this.schema.filter(c => !this.hiddenCols.has(c.index));
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  receiveChunk(payload: ChunkPayload): void {
    const { requestId, chunk, filteredTotal } = payload;
    this._storeChunk(chunk.startRow, chunk.rows);
    if (filteredTotal !== undefined) this.filteredRows = filteredTotal;

    const resolve = this._pendingRequests.get(requestId);
    if (resolve) {
      resolve(chunk.rows);
      this._pendingRequests.delete(requestId);
    }
  }

  handleEditAck(payload: EditAckPayload): void {
    if (!payload.success) {
      uiStore.setError(`Edit failed: ${payload.error ?? 'unknown error'}`);
    }
  }

  receiveColumnStats(payload: ColumnStatsPayload): void {
    this._statsCache.set(payload.stats.colIndex, payload.stats);
  }

  handleExportPath(_fsPath: string): void {}

  // ── Private ───────────────────────────────────────────────────────────────

  receiveRawRows(schema: ColumnSchema[], rows: CellValue[][]): void {
    this.schema = schema;
    this.totalRows = rows.length;
    this.filteredRows = rows.length;
    this._csvAllRows = rows;
    this._computeAutoWidths(schema, rows);
    this._applyPendingSidecar();
    this._storeChunk(0, rows.slice(0, CHUNK_SIZE));
    if (this.filters.length > 0 || this.sort) this._invalidateCache();
    uiStore.setLoading(false);
  }

  private _requestChunk(startRow: number, endRow: number): void {
    if (this.fileType === 'csv' || this.fileType === 'sqlite' || this.fileType === 'avro' || this.fileType === 'orc') {
      this._serveCsvChunk(startRow, endRow);
      return;
    }

    // Worker may still be initialising — queue via the ready promise.
    this._getOrCreateWorker().then(worker => {
      const requestId = `chunk-${startRow}-${Date.now()}`;
      const effectiveEndRow = Math.min(endRow, this.totalRows > 0 ? this.totalRows : endRow);
      // Svelte 5 $state values are Proxy objects — structured-clone (used by
      // postMessage) cannot handle them. Serialize to plain JS via JSON round-trip.
      const filters = this.filters.length > 0
        ? JSON.parse(JSON.stringify(this.filters)) as FilterSpec[]
        : undefined;
      const sort = this.sort ? JSON.parse(JSON.stringify(this.sort)) as SortSpec : undefined;
      const msg: DuckDbWorkerIn = {
        type: 'GET_CHUNK',
        payload: {
          requestId,
          startRow,
          endRow: effectiveEndRow,
          filters,
          sort,
          globalSearch: this.globalSearch || undefined,
        },
      };
      worker.postMessage(msg);
    }).catch(e => uiStore.setError(String(e)));
  }

  private _serveCsvChunk(startRow: number, endRow: number): void {
    const hasFilter = this.filters.length > 0;
    const q = this.globalSearch.trim().toLowerCase();
    const hasSearch = q.length > 0;
    const hasSort = !!this.sort;

    if (!hasFilter && !hasSearch && !hasSort) {
      // Identity mapping — clear the override so _actualRowIndex returns row as-is.
      this._viewToActual = [];
      this.filteredRows = this._csvAllRows.length;
      const sliced = this._csvAllRows.slice(startRow, Math.min(endRow, this._csvAllRows.length));
      this._storeChunk(startRow, sliced);
      return;
    }

    // Build pairs of (row, actualIndex) so we don't lose the original index after
    // filter/sort. Critical for row mutations (delete/duplicate/insert) under a filtered view.
    let pairs: { row: CellValue[]; idx: number }[] = this._csvAllRows.map((row, idx) => ({ row, idx }));

    if (hasFilter) {
      pairs = pairs.filter(p => this.filters.every(f => applyFilter(p.row, f)));
    }
    if (hasSearch) {
      pairs = pairs.filter(p => p.row.some(cell => String(cell ?? '').toLowerCase().includes(q)));
    }
    if (hasSort) {
      const { colIndex, direction } = this.sort!;
      pairs = [...pairs].sort((a, b) => compareValues(a.row[colIndex], b.row[colIndex], direction));
    }

    this._viewToActual = pairs.map(p => p.idx);
    this.filteredRows = pairs.length;
    const slicedPairs = pairs.slice(startRow, Math.min(endRow, pairs.length));
    this._storeChunk(startRow, slicedPairs.map(p => p.row));
  }

  // Translate a visible row index (the one DataGrid renders) into the actual
  // index inside _csvAllRows. With no filter/sort/search this is identity.
  private _actualRowIndex(visibleRow: number): number {
    if (this._viewToActual.length === 0) return visibleRow;
    return this._viewToActual[visibleRow] ?? visibleRow;
  }

  private _storeChunk(startRow: number, rows: CellValue[][]): void {
    this._cache.set(startRow, rows);
    this._accessOrder = [...this._accessOrder.filter(k => k !== startRow), startRow];

    while (this._accessOrder.length > MAX_CHUNKS_IN_MEMORY) {
      const evict = this._accessOrder.shift()!;
      this._cache.delete(evict);
    }
    this.cacheVersion++;
  }

  private _invalidateCache(): void {
    this._cache.clear();
    this._accessOrder = [];
    this.cacheVersion++;
    this._requestChunk(this.visibleStartRow, this.visibleEndRow + CHUNK_SIZE);
  }

  private _handleDuckWorkerMsg(msg: DuckDbWorkerOut): void {
    switch (msg.type) {
      case 'READY':
        this.schema = msg.payload.schema;
        this.totalRows = msg.payload.totalRows;
        this.filteredRows = msg.payload.totalRows;
        this._applyPendingSidecar();
        this._requestChunk(0, CHUNK_SIZE);
        uiStore.setLoading(false);
        break;

      case 'CHUNK': {
        const { requestId, rows, startRow, filteredTotal } = msg.payload;
        this._storeChunk(startRow, rows);
        this.filteredRows = filteredTotal;
        const resolve = this._pendingRequests.get(requestId);
        if (resolve) {
          resolve(rows);
          this._pendingRequests.delete(requestId);
        }
        break;
      }

      case 'ERROR':
        uiStore.setError(msg.payload.message);
        break;
    }
  }

  private _applySidecar(sidecar: SidecarData): void {
    this._applyingSidecar = true;
    try {
      // Column widths — keyed by name, applied directly.
      for (const [name, width] of Object.entries(sidecar.columnWidths ?? {})) {
        this.colWidths.set(name, width);
      }

      // Build a name → index lookup once for the rest of the restore work.
      const nameToIdx = new Map<string, number>();
      for (const c of this.schema) nameToIdx.set(c.name, c.index);

      // Hidden columns (saved as names, restored by name match).
      if (sidecar.hiddenColumns?.length) {
        const hidden = new Set<number>();
        for (const name of sidecar.hiddenColumns) {
          const idx = nameToIdx.get(name);
          if (idx !== undefined) hidden.add(idx);
        }
        this.hiddenCols = hidden;
      }

      // Saved filters: only keep those whose column still exists.
      if (sidecar.filters?.length) {
        const restored: FilterSpec[] = [];
        for (const f of sidecar.filters) {
          const idx = nameToIdx.get(f.column);
          if (idx === undefined) continue;
          restored.push({ colIndex: idx, op: f.op, value: f.value as FilterSpec['value'] });
        }
        if (restored.length) this.filters = restored;
      }

      // Saved sort.
      if (sidecar.sort) {
        const idx = nameToIdx.get(sidecar.sort.column);
        if (idx !== undefined) {
          this.sort = { colIndex: idx, direction: sidecar.sort.direction };
        }
      }

      // Column colours active flag — re-apply the palette using the same logic
      // as the user-toggle path so the colour mapping is identical.
      if (sidecar.colorsActive) {
        this.toggleColColors();
      }
    } finally {
      this._applyingSidecar = false;
    }
  }

  // Build a SidecarData snapshot from the current store state.
  // Persistence is opt-in via `_persistSidecar()` — callers decide when to write.
  private _buildSidecar(): SidecarData {
    const idxToName = new Map<number, string>();
    for (const c of this.schema) idxToName.set(c.index, c.name);

    const columnWidths: Record<string, number> = {};
    for (const [name, w] of this.colWidths) columnWidths[name] = w;

    const hiddenColumns: string[] = [];
    for (const idx of this.hiddenCols) {
      const name = idxToName.get(idx);
      if (name) hiddenColumns.push(name);
    }

    const filters = this.filters
      .map(f => {
        const name = idxToName.get(f.colIndex);
        if (!name) return null;
        return { column: name, op: f.op, value: f.value };
      })
      .filter((x): x is { column: string; op: FilterSpec['op']; value: FilterSpec['value'] } => x !== null);

    const sortName = this.sort ? idxToName.get(this.sort.colIndex) : undefined;

    return {
      version: 1,
      columnOverrides: this.sidecar?.columnOverrides ?? {},
      bookmarks: this.sidecar?.bookmarks ?? [],
      columnWidths,
      hiddenColumns,
      pinnedColumns: this.sidecar?.pinnedColumns ?? { left: [], right: [] },
      filters,
      colorsActive: this.colColors.size > 0,
      sort: sortName ? { column: sortName, direction: this.sort!.direction } : null,
    };
  }

  // Debounced persistence: callers invoke this after every UI mutation that
  // affects the sidecar; we coalesce a burst into a single host roundtrip.
  // The host writes .gridmaster.json next to the data file.
  private _sidecarSaveTimer: number | null = null;
  private _applyingSidecar = false;

  persistSidecar(): void {
    // Skip while restoring from disk — we'd just rewrite what we just read.
    if (this._applyingSidecar) return;
    if (this._sidecarSaveTimer !== null) {
      clearTimeout(this._sidecarSaveTimer);
    }
    this._sidecarSaveTimer = setTimeout(() => {
      this._sidecarSaveTimer = null;
      const sidecar = this._buildSidecar();
      this.sidecar = sidecar;
      postMessage({ type: 'SAVE_SIDECAR', payload: { sidecar } });
    }, 300) as unknown as number;
  }
}

// ── Filter/sort helpers (mirrors csv.worker.ts logic) ─────────────────────────

function applyFilter(row: CellValue[], f: FilterSpec): boolean {
  const cell = row[f.colIndex];
  const val = f.value;
  switch (f.op) {
    case 'eq':           return cell == val;
    case 'neq':          return cell != val;
    case 'contains':     return String(cell ?? '').toLowerCase().includes(String(val).toLowerCase());
    case 'not_contains': return !String(cell ?? '').toLowerCase().includes(String(val).toLowerCase());
    case 'gt':           return Number(cell) > Number(val);
    case 'lt':           return Number(cell) < Number(val);
    case 'gte':          return Number(cell) >= Number(val);
    case 'lte':          return Number(cell) <= Number(val);
    case 'regex':        return new RegExp(String(val), 'i').test(String(cell ?? ''));
    case 'is_null':      return cell === null;
    case 'is_not_null':  return cell !== null;
    default:             return true;
  }
}

function compareValues(a: CellValue, b: CellValue, dir: 'asc' | 'desc'): number {
  const aNum = Number(a);
  const bNum = Number(b);
  let cmp: number;
  if (!isNaN(aNum) && !isNaN(bNum)) {
    cmp = aNum - bNum;
  } else {
    cmp = String(a ?? '').localeCompare(String(b ?? ''));
  }
  return dir === 'asc' ? cmp : -cmp;
}

export const gridStore = new GridStore();
