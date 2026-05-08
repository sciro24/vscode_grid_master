import type { ColumnSchema, CellValue, FilterSpec, SortSpec, ColumnStats, SidecarData } from '@shared/schema.js';
import type { InitPayload, ChunkPayload, EditAckPayload, ColumnStatsPayload } from '@shared/messages.js';
import type { DuckDbWorkerIn, DuckDbWorkerOut } from '../workers/duckdb.worker.js';
import { CHUNK_SIZE, MAX_CHUNKS_IN_MEMORY } from '@shared/constants.js';
import { uiStore } from './ui.svelte.js';

// LRU chunk cache: rowStart → rows
type ChunkCache = Map<number, CellValue[][]>;

class GridStore {
  // File metadata
  fileType = $state<'csv' | 'parquet' | 'arrow' | 'json'>('csv');
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

  // Auto-fitted column widths, keyed by column name. Computed once after data load.
  private _autoWidths = new Map<string, number>();

  // Viewport
  visibleStartRow = $state(0);
  visibleEndRow = $state(50);

  // Filters & sort
  filters = $state<FilterSpec[]>([]);
  sort = $state<SortSpec | null>(null);
  globalSearch = $state('');

  // Selection
  selectedCell = $state<{ row: number; col: number } | null>(null);
  selectedRange = $state<{ r1: number; c1: number; r2: number; c2: number } | null>(null);

  // Workers (DuckDB only — CSV is parsed inline in the main thread)
  private _duckWorker: Worker | null = null;
  private _pendingRequests = new Map<string, (rows: CellValue[][]) => void>();

  // Column colors: colIndex → CSS color string
  colColors = $state<Map<number, string>>(new Map());

  // Sidecar
  sidecar = $state<SidecarData | null>(null);

  // Column stats cache
  private _statsCache = new Map<number, ColumnStats>();

  // Edit history for in-webview undo / discard
  private _editHistory: Array<{ row: number; col: number; oldValue: CellValue; newValue: CellValue }> = [];
  editCount = $state(0);  // reactive proxy for _editHistory.length

  // ── Init ──────────────────────────────────────────────────────────────────

  init(payload: InitPayload): void {
    this.fileType = payload.fileType;
    this.fileName = payload.fileName;
    this.totalBytes = payload.totalBytes;
    this.schema = payload.schema;
    if (payload.sidecar) {
      this.sidecar = payload.sidecar;
      this._applySidecar(payload.sidecar);
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
    this._storeChunk(0, allRows.slice(0, CHUNK_SIZE));
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
    // Mirror into the master CSV array so undo/discard and re-chunk see it.
    if (this.fileType === 'csv' && this._csvAllRows[row]) {
      if (oldValue === null && this._csvAllRows[row][col] !== undefined) {
        oldValue = this._csvAllRows[row][col];
      }
      this._csvAllRows[row][col] = value;
    }
    this._editHistory.push({ row, col, oldValue, newValue: value });
    this.editCount = this._editHistory.length;
    this.cacheVersion++;
    uiStore.markDirty();
  }

  undoLastEdit(): boolean {
    const last = this._editHistory.pop();
    if (!last) return false;
    this.editCount = this._editHistory.length;

    const chunkStart = Math.floor(last.row / CHUNK_SIZE) * CHUNK_SIZE;
    const chunk = this._cache.get(chunkStart);
    if (chunk) {
      const rowData = chunk[last.row - chunkStart];
      if (rowData) rowData[last.col] = last.oldValue;
    }
    if (this.fileType === 'csv' && this._csvAllRows[last.row]) {
      this._csvAllRows[last.row][last.col] = last.oldValue;
    }
    if (this._editHistory.length === 0) {
      uiStore.isDirty = false;
      uiStore.saved = true;
    }
    this.cacheVersion++;
    return true;
  }

  discardAllEdits(): void {
    // Walk the history in reverse, restoring each cell to its original value.
    while (this._editHistory.length > 0) {
      const e = this._editHistory.pop()!;
      const chunkStart = Math.floor(e.row / CHUNK_SIZE) * CHUNK_SIZE;
      const chunk = this._cache.get(chunkStart);
      if (chunk) {
        const rowData = chunk[e.row - chunkStart];
        if (rowData) rowData[e.col] = e.oldValue;
      }
      if (this.fileType === 'csv' && this._csvAllRows[e.row]) {
        this._csvAllRows[e.row][e.col] = e.oldValue;
      }
    }
    this.editCount = 0;
    uiStore.isDirty = false;
    uiStore.saved = true;
    this.cacheVersion++;
  }

  clearEditHistory(): void {
    this._editHistory = [];
    this.editCount = 0;
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
  }

  removeFilter(colIndex: number): void {
    this.filters = this.filters.filter(f => f.colIndex !== colIndex);
    this._invalidateCache();
  }

  clearFilters(): void {
    this.filters = [];
    this._invalidateCache();
  }

  setSort(sort: SortSpec | null): void {
    this.sort = sort;
    this._invalidateCache();
  }

  setGlobalSearch(query: string): void {
    this.globalSearch = query;
    this._invalidateCache();
  }

  // ── Column ops ────────────────────────────────────────────────────────────

  toggleColumnVisibility(colIndex: number): void {
    const next = new Set(this.hiddenCols);
    if (next.has(colIndex)) next.delete(colIndex);
    else next.add(colIndex);
    this.hiddenCols = next;
  }

  setColumnWidth(colName: string, width: number): void {
    this.colWidths = new Map(this.colWidths).set(colName, width);
  }

  setColColors(colors: Map<number, string>): void {
    this.colColors = colors;
  }

  toggleColColors(): void {
    if (this.colColors.size > 0) {
      this.colColors = new Map();
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

  private _requestChunk(startRow: number, endRow: number): void {
    if (this.fileType === 'csv') {
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
    let rows = this._csvAllRows;

    if (this.filters.length > 0) {
      rows = rows.filter(row => this.filters.every(f => applyFilter(row, f)));
    }

    const q = this.globalSearch.trim().toLowerCase();
    if (q.length > 0) {
      rows = rows.filter(row => row.some(cell => String(cell ?? '').toLowerCase().includes(q)));
    }

    if (this.sort) {
      const { colIndex, direction } = this.sort;
      rows = [...rows].sort((a, b) => compareValues(a[colIndex], b[colIndex], direction));
    }

    this.filteredRows = rows.length;
    const sliced = rows.slice(startRow, Math.min(endRow, rows.length));
    this._storeChunk(startRow, sliced);
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
    for (const [name, width] of Object.entries(sidecar.columnWidths)) {
      this.colWidths.set(name, width);
    }
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
