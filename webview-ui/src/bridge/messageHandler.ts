import Papa from 'papaparse';
import type { HostMessage } from '@shared/messages.js';
import type { CellValue, ColumnSchema, InferredType } from '@shared/schema.js';
import { CHUNK_SIZE, TYPE_INFERENCE_SAMPLE_ROWS } from '@shared/constants.js';
import { gridStore } from '../stores/grid.svelte.js';
import { uiStore } from '../stores/ui.svelte.js';
import { postMessage } from './vscode.js';

type RawCsvMessage    = { type: '__RAW_CSV__';    payload: { text: string; totalBytes: number } };
type RawCsvBatchMessage = { type: '__RAW_CSV_BATCH__'; payload: {
  schema?: ColumnSchema[];
  delimiter?: string;
  rows: CellValue[][];
  done: boolean;
  kind: 'init' | 'rows' | 'done';
  totalRows?: number;
  bytesRead?: number;
  parseWarnings?: Array<{ row: number; line?: number; message: string }>;
} };
type DuckBundles = {
  parquetWasmB64?: string;
};

type RawBinaryMessage = { type: '__RAW_BINARY__'; payload: { base64?: string; base64Parts?: string[]; singleFileSplit?: boolean; fileType: 'parquet' | 'arrow' | 'json' | 'excel' | 'avro'; jsonFormat?: 'json' | 'ndjson'; duckBundles: DuckBundles } };
type RawRowsMessage   = { type: '__RAW_ROWS__';   payload: { schema: ColumnSchema[]; rows: CellValue[][] } };
type AnyMessage = HostMessage | RawCsvMessage | RawCsvBatchMessage | RawBinaryMessage | RawRowsMessage;

export function setupMessageHandler(): () => void {
  const handler = (event: MessageEvent) => {
    const msg = event.data as AnyMessage;
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'INIT':
        gridStore.init(msg.payload);
        break;

      case 'CHUNK':
        gridStore.receiveChunk(msg.payload);
        break;

      case 'SCHEMA_UPDATE':
        gridStore.updateSchema(msg.payload.schema);
        break;

      case 'LOADING':
        uiStore.setLoading(msg.payload.active, msg.payload.message, msg.payload.progress);
        break;

      case 'ERROR':
        uiStore.setError(msg.payload.message);
        break;

      case 'SAVE_ACK':
        uiStore.setSaved(msg.payload.success);
        if (msg.payload.success) {
          gridStore.markHistorySaved();
          gridStore.clearEditHistory();
        } else if (msg.payload.error) {
          uiStore.setError(`Save failed: ${msg.payload.error}`);
        }
        break;

      case 'EDIT_ACK':
        gridStore.handleEditAck(msg.payload);
        break;

      case 'COLUMN_STATS':
        gridStore.receiveColumnStats(msg.payload);
        break;

      case '__LARGE_FILE_WARNING__':
        uiStore.setLargeFileWarning({ fileSizeMb: msg.payload.fileSizeMb });
        break;

      case '__RAW_CSV__':
        parseCsvInline(msg.payload.text, msg.payload.totalBytes);
        break;

      case '__RAW_CSV_BATCH__':
        handleCsvBatch(msg.payload);
        break;

      case '__RAW_BINARY__': {
        const { fileType, duckBundles, jsonFormat, base64, base64Parts, singleFileSplit } = msg.payload;
        if (base64Parts && base64Parts.length > 0) {
          console.log('[GM] __RAW_BINARY__', fileType, 'parts=', base64Parts.length, 'split=', !!singleFileSplit);
          if (singleFileSplit) {
            // One logical file was split into base64 chunks to avoid the V8
            // 512 MB string limit on the host side. Decode each chunk and
            // concatenate into a single ArrayBuffer before handing to the worker.
            const combined = concatBase64Chunks(base64Parts);
            gridStore.loadRawBinary(combined, fileType as 'parquet' | 'arrow' | 'json', duckBundles, jsonFormat);
          } else {
            const buffers = base64Parts.map(b64ToArrayBuffer);
            gridStore.loadRawBinaryParts(buffers, fileType as 'parquet' | 'arrow', duckBundles);
          }
        } else if (base64) {
          console.log('[GM] __RAW_BINARY__', fileType, 'base64 len', base64.length);
          gridStore.loadRawBinary(b64ToArrayBuffer(base64), fileType, duckBundles, jsonFormat);
        }
        break;
      }

      case '__RAW_ROWS__':
        gridStore.receiveRawRows(msg.payload.schema, msg.payload.rows);
        break;

      case 'WEBVIEW_UNDO':
        gridStore.undo();
        _postUndoState();
        break;

      case 'WEBVIEW_REDO':
        gridStore.redo();
        _postUndoState();
        break;

      case 'EXPORT_START':
        startStreamingExport(msg.payload.fsPath, msg.payload.format);
        break;

      case 'EXPORT_PROGRESS':
        uiStore.setExportProgress(msg.payload.pct);
        break;

      case 'EXPORT_DONE':
        uiStore.setExportProgress(null);
        if (msg.payload.success) {
          uiStore.setExportDone(msg.payload.path ?? '');
        } else {
          uiStore.setError(`Export failed: ${msg.payload.error ?? 'unknown error'}`);
        }
        break;

    }
  };

  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

// ── Base64 → ArrayBuffer ──────────────────────────────────────────────────────
// Uint8Array.from is faster than a manual charCodeAt loop for large payloads
// because the engine can optimise the typed-array fill internally.

// ── Streamed CSV batch accumulator ────────────────────────────────────────────
// Host sends multiple __RAW_CSV_BATCH__ messages for large files (>256 MB).
// 'init'  → schema + delimiter
// 'rows'  → up to 100k rows per message; first batch triggers grid render
// 'done'  → authoritative row count, finalize display
//
// RAF coalescing: subsequent row batches are queued and flushed at most 50k rows
// per animation frame so rapid IPC bursts don't block the main thread.
//
// Row cap: webview stores at most MAX_WEBVIEW_ROWS rows to prevent OOM crashes
// on very large files. When the cap is hit, a cancel message is sent to the host
// so streaming stops early.

const MAX_WEBVIEW_ROWS = 1_000_000;
const MEMORY_PRESSURE_RATIO = 0.82;
const MEMORY_CHECK_INTERVAL_MS = 250;
const MAX_FLUSH_PER_RAF = 50_000;

let _csvStreamSchema: ColumnSchema[] | null = null;
let _csvStreamDelimiter = ',';
let _csvStreamInitialized = false;
let _pendingAppendRows: CellValue[][] = [];
let _rafPending = false;
let _streamCapped = false;
let _lastMemoryCheck = 0;
let _lastMemoryRatio: number | null = null;
let _lastUsedHeap = 0;
let _lastHeapDelta = 0;
let _highMemStreak = 0;

function _readMemoryRatio(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!mem || !mem.usedJSHeapSize || !mem.jsHeapSizeLimit) return null;
  return mem.usedJSHeapSize / mem.jsHeapSizeLimit;
}

function _updateMemoryRatio(): void {
  const now = performance.now();
  if (now - _lastMemoryCheck < MEMORY_CHECK_INTERVAL_MS) return;
  _lastMemoryCheck = now;
  _lastMemoryRatio = _readMemoryRatio();
}

function _flushPendingAppend(): void {
  const toFlush = _pendingAppendRows.splice(0, MAX_FLUSH_PER_RAF);
  if (toFlush.length > 0) {
    gridStore.appendCsvRows(toFlush);
  }
  if (_pendingAppendRows.length > 0) {
    requestAnimationFrame(_flushPendingAppend);
  } else {
    _rafPending = false;
  }
}

function _capStream(reason: 'limit' | 'memory'): void {
  _streamCapped = true;
  _pendingAppendRows = [];
  _rafPending = false;
  gridStore.finalizeCsvRows(gridStore.totalRows);
  gridStore.setCsvStreaming(false);
  gridStore.setRowCapWarning(reason);
  uiStore.setLoading(false);
  postMessage({ type: 'LARGE_FILE_STREAM_CANCEL' });
}

// Set to true while a large-file stream is in progress so App.svelte
// keeps the LoadingOverlay visible even after the first batch arrives.
let _streamingInProgress = false;
export function isStreamingInProgress(): boolean { return _streamingInProgress; }

function handleCsvBatch(p: {
  schema?: ColumnSchema[];
  delimiter?: string;
  rows: CellValue[][];
  done: boolean;
  kind: 'init' | 'rows' | 'done';
  totalRows?: number;
  bytesRead?: number;
  previewOnly?: boolean;
  parseWarnings?: Array<{ row: number; line?: number; message: string }>;
}): void {
  if (p.kind === 'init') {
    _csvStreamSchema = p.schema ?? [];
    _csvStreamDelimiter = p.delimiter ?? ',';
    _csvStreamInitialized = false;
    _pendingAppendRows = [];
    _rafPending = false;
    _streamCapped = false;
    _streamingInProgress = true;
    _lastMemoryCheck = 0;
    _lastMemoryRatio = null;
    _lastUsedHeap = 0;
    _lastHeapDelta = 0;
    _highMemStreak = 0;
    gridStore.setCsvStreaming(true);
    return;
  }
  if (_streamCapped) return;
  if (p.kind === 'rows') {
    if (p.rows.length === 0) return;
    _updateMemoryRatio();
    if (_lastMemoryRatio !== null && _lastMemoryRatio >= MEMORY_PRESSURE_RATIO) {
      _capStream('memory');
      return;
    }
    const current = gridStore.totalRows + _pendingAppendRows.length;
    let limitedRows = p.rows;
    if (_lastMemoryRatio === null) {
      const remaining = MAX_WEBVIEW_ROWS - current;
      if (remaining <= 0) {
        _capStream('limit');
        return;
      }
      limitedRows = p.rows.length > remaining ? p.rows.slice(0, remaining) : p.rows;
    }
    if (!_csvStreamInitialized) {
      // First batch: store rows but don't expose to grid yet (grid hidden during load).
      // receiveCsvData initialises schema + puts rows in _csvAllRows.
      gridStore.receiveCsvData(_csvStreamSchema ?? [], limitedRows, _csvStreamDelimiter);
      _csvStreamInitialized = true;
    } else {
      for (const r of limitedRows) _pendingAppendRows.push(r);
      if (!_rafPending) {
        _rafPending = true;
        requestAnimationFrame(_flushPendingAppend);
      }
    }
    if (limitedRows.length < p.rows.length) {
      _capStream('limit');
      return;
    }
    if (p.bytesRead !== undefined && gridStore.totalBytes > 0) {
      const pct = Math.min(99, Math.round((p.bytesRead / gridStore.totalBytes) * 100));
      uiStore.setStreamProgress(pct);
    }
    return;
  }
  // kind === 'done' — all IPC batches received; wait for any in-flight RAF drain,
  // then finalize. We schedule finalization via RAF so the main thread isn't
  // blocked by a synchronous flush of potentially millions of pending rows.
  const totalRows = p.totalRows ?? gridStore.totalRows;
  const previewOnly = !!p.previewOnly;
  const parseWarnings = p.parseWarnings ?? null;

  const _finalize = (): void => {
    if (_rafPending || _pendingAppendRows.length > 0) {
      // RAF drain still in progress — re-schedule finalization
      requestAnimationFrame(_finalize);
      return;
    }
    gridStore.finalizeCsvRows(totalRows);
    gridStore.setCsvStreaming(false);
    if (previewOnly) gridStore.setRowCapWarning('preview');
    if (parseWarnings && parseWarnings.length > 0) uiStore.setParseWarnings(parseWarnings);
    _streamingInProgress = false;
    uiStore.setStreamProgress(100);
    // Small delay so the "100%" flash is visible before overlay hides
    setTimeout(() => uiStore.setLoading(false), 300);
  };
  requestAnimationFrame(_finalize);
}

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return bytes.buffer;
}

// Decode N base64 chunks and concatenate the raw bytes into a single
// ArrayBuffer. Used when a single large file was split host-side to avoid
// the V8 ~512 MB string limit on base64 encoding.
function concatBase64Chunks(parts: string[]): ArrayBuffer {
  const decoded: Uint8Array[] = parts.map(p => Uint8Array.from(atob(p), c => c.charCodeAt(0)));
  let total = 0;
  for (const u of decoded) total += u.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const u of decoded) { out.set(u, off); off += u.length; }
  return out.buffer;
}

// ── Inline CSV parsing (synchronous, main thread, no Worker) ──────────────────

function parseCsvInline(text: string, _totalBytes: number): void {
  try {
    const result = Papa.parse<string[]>(text, {
      delimiter: '',
      skipEmptyLines: true,
      header: false,
    });

    if (result.errors.length > 0 && result.data.length === 0) {
      uiStore.setError(result.errors[0].message);
      return;
    }

    const raw = result.data as string[][];
    if (raw.length === 0) {
      uiStore.setError('File is empty');
      return;
    }

    const headers = raw[0];
    const allRows: CellValue[][] = raw.slice(1).map(row => row.map(coerceCell));
    const schema = inferSchema(headers, allRows.slice(0, TYPE_INFERENCE_SAMPLE_ROWS));
    const delimiter = result.meta.delimiter ?? ',';

    gridStore.receiveCsvData(schema, allRows, delimiter);
    uiStore.setLoading(false);
  } catch (err) {
    uiStore.setError(String(err));
  }
}

function coerceCell(raw: string): CellValue {
  if (raw === '' || raw === 'null' || raw === 'NULL' || raw === 'NA' || raw === 'N/A') return null;
  const n = Number(raw);
  if (!isNaN(n) && raw.trim() !== '') return n;
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return raw;
}

function inferType(samples: CellValue[]): InferredType {
  const nonNull = samples.filter(v => v !== null);
  if (nonNull.length === 0) return 'null';
  if (nonNull.every(v => typeof v === 'number')) return 'number';
  if (nonNull.every(v => typeof v === 'boolean')) return 'boolean';
  if (nonNull.every(v => typeof v === 'string' && isDateLike(v as string))) return 'date';
  return 'string';
}

function isDateLike(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(s);
}

function inferSchema(headers: string[], sampleRows: CellValue[][]): ColumnSchema[] {
  return headers.map((name, index) => {
    const samples = sampleRows.map(row => row[index] ?? null);
    const nullCount = samples.filter(v => v === null).length;
    return { name, index, inferredType: inferType(samples), nullable: nullCount > 0 };
  });
}

// ── Undo state sync ───────────────────────────────────────────────────────────

export function _postUndoState(): void {
  postMessage({
    type: 'CAN_UNDO_STATE',
    payload: { canUndo: gridStore.canUndo, canRedo: gridStore.canRedo },
  });
}

// ── Streaming export orchestration ───────────────────────────────────────────

let _exportCancelled = false;

export function cancelExport(): void {
  _exportCancelled = true;
  postMessage({ type: 'EXPORT_CANCEL' });
  uiStore.setExportProgress(null);
}

function startStreamingExport(fsPath: string, format: 'csv' | 'tsv' | 'json'): void {
  _exportCancelled = false;
  uiStore.setExportActive(true);

  // Use scheduler to yield control between batches so UI stays responsive.
  const gen = gridStore.exportRowBatches(100_000);
  void (async () => {
    for (const batch of gen) {
      if (_exportCancelled) return;
      postMessage({
        type: 'EXPORT_DATA_BATCH',
        payload: {
          rows: batch.rows,
          headers: batch.headers,
          batchIndex: batch.batchIndex,
          totalBatches: batch.totalBatches,
          done: batch.done,
          format,
        },
      });
      // Yield to microtask queue between batches so UI updates are painted.
      await new Promise<void>(r => setTimeout(r, 0));
    }
  })();
}
