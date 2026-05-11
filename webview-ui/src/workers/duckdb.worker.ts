// Data worker — reads Parquet, Arrow and JSON files using parquet-wasm +
// apache-arrow. No external network calls, no DuckDB extension issues.

import * as arrow from 'apache-arrow';
import init, { readParquet } from 'parquet-wasm/esm/parquet_wasm.js';
import * as XLSX from 'xlsx';
import type { CellValue, ColumnSchema, FilterSpec, SortSpec, InferredType } from '@shared/schema.js';
import { CHUNK_SIZE } from '@shared/constants.js';
import { applyFilter, compareValues } from '@shared/filterUtils.js';

let _parquetInited = false;

// DuckDbBundleSet is still referenced by the host/store for type-compat but
// the worker no longer uses DuckDB. Keep the type to avoid a bigger refactor.
export type DuckDbBundleSet = {
  eh: { mainWorkerB64: string; mainModuleB64: string };
  extensions: { parquetB64: string; jsonB64: string };
  parquetWasmB64?: string;
};

export type DuckDbWorkerIn =
  | { type: 'LOAD'; payload: { buffer: ArrayBuffer; fileType: 'parquet' | 'arrow' | 'json' | 'excel' | 'avro'; jsonFormat?: 'json' | 'ndjson'; bundles: DuckDbBundleSet } }
  | { type: 'LOAD_PARTS'; payload: { buffers: ArrayBuffer[]; fileType: 'parquet' | 'arrow'; bundles: DuckDbBundleSet } }
  | { type: 'GET_CHUNK'; payload: { requestId: string; startRow: number; endRow: number; filters?: FilterSpec[]; sort?: SortSpec; globalSearch?: string } }
  | { type: 'QUERY'; payload: { requestId: string; sql: string } };

export type DuckDbWorkerOut =
  | { type: 'READY'; payload: { schema: ColumnSchema[]; totalRows: number } }
  | { type: 'CHUNK'; payload: { requestId: string; rows: CellValue[][]; startRow: number; endRow: number; filteredTotal: number } }
  | { type: 'QUERY_RESULT'; payload: { requestId: string; rows: CellValue[][]; columns: string[] } }
  | { type: 'ERROR'; payload: { message: string } };

// ── In-memory table ───────────────────────────────────────────────────────────

let _allRows: CellValue[][] = [];
let _schema: ColumnSchema[] = [];

// For large Arrow/Parquet tables we keep the Arrow Table around and
// materialise rows lazily on GET_CHUNK to avoid blocking the worker for
// minutes building a 10M-cell array up front.
let _arrowTable: arrow.Table | null = null;
const LAZY_THRESHOLD = 100_000;

// ── Message dispatch ──────────────────────────────────────────────────────────

console.log('[GM worker] script loaded (parquet-wasm mode)');

self.onmessage = async (e: MessageEvent<DuckDbWorkerIn>) => {
  const msg = e.data;
  console.log('[GM worker] received message', msg.type);
  try {
    switch (msg.type) {
      case 'LOAD':       await handleLoad(msg.payload.buffer, msg.payload.fileType, msg.payload.bundles, msg.payload.jsonFormat); break;
      case 'LOAD_PARTS': await handleLoadParts(msg.payload.buffers, msg.payload.fileType, msg.payload.bundles); break;
      case 'GET_CHUNK':  handleGetChunk(msg.payload); break;
      case 'QUERY':      break; // not implemented in this backend
    }
  } catch (err) {
    console.error('[GM worker] error in', msg.type, err);
    post({ type: 'ERROR', payload: { message: String(err) } });
  }
};

// ── Load ──────────────────────────────────────────────────────────────────────

async function handleLoad(buffer: ArrayBuffer, fileType: 'parquet' | 'arrow' | 'json' | 'excel' | 'avro', bundles: DuckDbBundleSet, jsonFormat: 'json' | 'ndjson' = 'json'): Promise<void> {
  console.log('[GM worker] handleLoad', fileType, buffer.byteLength, 'bytes');

  let table: arrow.Table | null = null;

  if (fileType === 'parquet') {
    if (!_parquetInited) {
      console.log('[GM worker] initialising parquet-wasm');
      // Vite has inlined the wasm as a data: URL in init(). Calling with no
      // args triggers fetch(dataUri) which is same-origin / allowed.
      // If that fails (e.g. CSP blocks data: in connect-src), fall back to
      // the base64 bytes shipped by the host.
      try {
        await init();
      } catch (e) {
        console.warn('[GM worker] init() failed, falling back to b64:', e);
        const b64 = bundles.parquetWasmB64;
        if (!b64) throw new Error('parquet-wasm bytes not provided');
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await init({ module_or_path: bytes });
      }
      _parquetInited = true;
      console.log('[GM worker] parquet-wasm initialised');
    }
    const wasmTable = readParquet(new Uint8Array(buffer));
    table = arrow.tableFromIPC(wasmTable.intoIPCStream());
  } else if (fileType === 'arrow') {
    try {
      table = arrow.tableFromIPC(new Uint8Array(buffer));
    } catch (e) {
      const msg = String(e);
      if (msg.includes('codec not found') || msg.includes('compress')) {
        throw new Error(
          'This Arrow file uses compression (LZ4/ZSTD) which is not supported in the browser. ' +
          'Re-export it without compression: feather.write_feather(table, path, compression="uncompressed")'
        );
      }
      throw e;
    }
  } else if (fileType === 'excel') {
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', dense: true });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    // header:1 → array-of-arrays; defval ensures missing cells are null
    const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true }) as unknown[][];
    if (aoa.length === 0) {
      post({ type: 'READY', payload: { schema: [], totalRows: 0 } });
      return;
    }
    const headers = (aoa[0] as unknown[]).map((h, i) => (h != null ? String(h) : `col_${i}`));
    const dataRows = aoa.slice(1);
    _schema = headers.map((name, colIdx) => ({
      name,
      index: colIdx,
      inferredType: inferColumnTypeFromArray(dataRows as unknown[][], colIdx),
      nullable: true,
    }));
    _allRows = dataRows.map(row =>
      headers.map((_, ci) => coerceJsonValue((row as unknown[])[ci]))
    );
    post({ type: 'READY', payload: { schema: _schema, totalRows: _allRows.length } });
    return;
  } else {
    // JSON / NDJSON — parse directly; skip arrow.tableFromJSON which uses
    // `new Function` internally and is blocked by the webview CSP.
    const text = new TextDecoder().decode(buffer);
    const rawRows: Record<string, unknown>[] = jsonFormat === 'ndjson'
      ? text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : JSON.parse(text);

    const colNames = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
    _schema = colNames.map((name, index) => ({
      name,
      index,
      inferredType: inferJsonColumnType(rawRows, name),
      nullable: true,
    }));
    _allRows = rawRows.map(row => colNames.map(name => coerceJsonValue(row[name])));
    post({ type: 'READY', payload: { schema: _schema, totalRows: _allRows.length } });
    return;
  }

  console.log('[GM worker] table loaded, rows:', table.numRows, 'cols:', table.numCols);

  // Build schema from Arrow schema
  _schema = table.schema.fields.map((f, index) => ({
    name: f.name,
    index,
    inferredType: arrowTypeToInferred(f.type),
    nullable: f.nullable,
  }));

  const total = table.numRows;
  if (total > LAZY_THRESHOLD) {
    // Lazy mode: keep the Arrow table and materialise rows on demand.
    // Sorting / filtering still works because GET_CHUNK builds the full
    // row array the first time it's needed (or when filters/sort change).
    _arrowTable = table;
    _allRows = [];
    console.log('[GM worker] using lazy mode for', total, 'rows');
    post({ type: 'READY', payload: { schema: _schema, totalRows: total } });
    return;
  }

  // Eager: materialise all rows for fast in-worker sort/filter
  _arrowTable = null;
  _allRows = materialiseArrowTable(table, _schema);
  console.log('[GM worker] materialised', _allRows.length, 'rows');
  post({ type: 'READY', payload: { schema: _schema, totalRows: _allRows.length } });
}

// Build CellValue[][] from an Arrow Table using columnar iteration so each
// column lookup happens once instead of once per row × column.
function materialiseArrowTable(table: arrow.Table, schema: ColumnSchema[]): CellValue[][] {
  const numRows = table.numRows;
  const numCols = schema.length;
  const rows: CellValue[][] = new Array(numRows);
  for (let r = 0; r < numRows; r++) rows[r] = new Array(numCols);

  for (let c = 0; c < numCols; c++) {
    const child = table.getChild(schema[c].name);
    if (!child) continue;
    for (let r = 0; r < numRows; r++) {
      rows[r][c] = coerceArrowValue(child.get(r));
    }
  }
  return rows;
}

// Materialise just a slice [startRow, endRow) — used for lazy mode to avoid
// building the entire CellValue[][] up front.
function materialiseSlice(table: arrow.Table, schema: ColumnSchema[], startRow: number, endRow: number): CellValue[][] {
  const end = Math.min(endRow, table.numRows);
  const len = Math.max(0, end - startRow);
  if (len === 0) return [];
  const rows: CellValue[][] = new Array(len);
  for (let i = 0; i < len; i++) rows[i] = new Array(schema.length);
  for (let c = 0; c < schema.length; c++) {
    const child = table.getChild(schema[c].name);
    if (!child) continue;
    for (let i = 0; i < len; i++) {
      rows[i][c] = coerceArrowValue(child.get(startRow + i));
    }
  }
  return rows;
}

async function handleLoadParts(buffers: ArrayBuffer[], fileType: 'parquet' | 'arrow', bundles: DuckDbBundleSet): Promise<void> {
  console.log('[GM worker] handleLoadParts', fileType, buffers.length, 'parts');

  // Ensure parquet-wasm is initialised once before processing any part
  if (fileType === 'parquet' && !_parquetInited) {
    console.log('[GM worker] initialising parquet-wasm');
    try {
      await init();
    } catch (e) {
      console.warn('[GM worker] init() failed, falling back to b64:', e);
      const b64 = bundles.parquetWasmB64;
      if (!b64) throw new Error('parquet-wasm bytes not provided');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await init({ module_or_path: bytes });
    }
    _parquetInited = true;
    console.log('[GM worker] parquet-wasm initialised');
  }

  _schema = [];
  _allRows = [];
  _arrowTable = null;

  // Concat all parts into a single Arrow Table — schemas must match across parts.
  const tables: arrow.Table[] = [];
  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    let table: arrow.Table;
    if (fileType === 'parquet') {
      const wasmTable = readParquet(new Uint8Array(buf));
      table = arrow.tableFromIPC(wasmTable.intoIPCStream());
    } else {
      table = arrow.tableFromIPC(new Uint8Array(buf));
    }
    tables.push(table);
    console.log('[GM worker] part', i + 1, '/', buffers.length, 'loaded,', table.numRows, 'rows');
  }

  const merged = tables.length === 1 ? tables[0] : tables[0].concat(...tables.slice(1));
  _schema = merged.schema.fields.map((f, index) => ({
    name: f.name,
    index,
    inferredType: arrowTypeToInferred(f.type),
    nullable: f.nullable,
  }));

  const total = merged.numRows;
  if (total > LAZY_THRESHOLD) {
    _arrowTable = merged;
    _allRows = [];
    console.log('[GM worker] using lazy mode for', total, 'rows (parts)');
    post({ type: 'READY', payload: { schema: _schema, totalRows: total } });
    return;
  }

  _allRows = materialiseArrowTable(merged, _schema);
  console.log('[GM worker] materialised', _allRows.length, 'rows (parts)');
  post({ type: 'READY', payload: { schema: _schema, totalRows: _allRows.length } });
}

function coerceArrowValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  // Arrow typed-array elements (Uint32, Int64 proxies, Utf8, etc.) — coerce to
  // a plain primitive so structured-clone can transfer them across the worker boundary.
  if (typeof (v as { valueOf?: unknown }).valueOf === 'function') {
    const prim = (v as { valueOf(): unknown }).valueOf();
    if (typeof prim === 'number' || typeof prim === 'boolean' || typeof prim === 'string') return prim;
    if (typeof prim === 'bigint') return Number(prim);
  }
  return JSON.stringify(v);
}

function coerceJsonValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

function inferColumnTypeFromArray(rows: unknown[][], colIdx: number): InferredType {
  for (const row of rows) {
    const v = row[colIdx];
    if (v === null || v === undefined) continue;
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') {
      if (!isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
      return 'string';
    }
    return 'string';
  }
  return 'string';
}

function inferJsonColumnType(rows: Record<string, unknown>[], name: string): InferredType {
  for (const row of rows) {
    const v = row[name];
    if (v === null || v === undefined) continue;
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') {
      if (!isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
      return 'string';
    }
    return 'string';
  }
  return 'string';
}

function arrowTypeToInferred(type: arrow.DataType): InferredType {
  if (arrow.DataType.isInt(type) || arrow.DataType.isFloat(type) || arrow.DataType.isDecimal(type)) return 'number';
  if (arrow.DataType.isBool(type)) return 'boolean';
  if (arrow.DataType.isDate(type) || arrow.DataType.isTimestamp(type) || arrow.DataType.isTime(type)) return 'date';
  return 'string';
}

// ── Get Chunk ─────────────────────────────────────────────────────────────────

function handleGetChunk(payload: {
  requestId: string;
  startRow: number;
  endRow: number;
  filters?: FilterSpec[];
  sort?: SortSpec;
  globalSearch?: string;
}): void {
  const { requestId, startRow, endRow, filters, sort, globalSearch } = payload;
  const hasFilters = !!(filters && filters.length > 0);
  const q = globalSearch?.trim().toLowerCase();
  const hasSearch = !!(q && q.length > 0);
  const hasSort = !!sort;

  // Fast path: lazy-mode Arrow table, no filter/sort/search → slice directly.
  if (_arrowTable && !hasFilters && !hasSort && !hasSearch && _allRows.length === 0) {
    const sliced = materialiseSlice(_arrowTable, _schema, startRow, endRow);
    const filteredTotal = _arrowTable.numRows;
    post({ type: 'CHUNK', payload: { requestId, rows: sliced, startRow, endRow: startRow + sliced.length, filteredTotal } });
    return;
  }

  // If we need to filter/sort/search a lazy table, materialise once and cache.
  if (_arrowTable && _allRows.length === 0) {
    console.log('[GM worker] materialising lazy table for filter/sort/search');
    _allRows = materialiseArrowTable(_arrowTable, _schema);
  }

  let rows = _allRows;

  if (hasFilters) {
    rows = rows.filter(row => filters!.every(f => applyFilter(row, f)));
  }

  if (hasSearch) {
    rows = rows.filter(row => row.some(cell => String(cell ?? '').toLowerCase().includes(q!)));
  }

  if (hasSort) {
    const { colIndex, direction } = sort!;
    rows = [...rows].sort((a, b) => compareValues(a[colIndex], b[colIndex], direction));
  }

  const filteredTotal = rows.length;
  const sliced = rows.slice(startRow, Math.min(endRow, rows.length));

  post({ type: 'CHUNK', payload: { requestId, rows: sliced, startRow, endRow: startRow + sliced.length, filteredTotal } });
}

function post(msg: DuckDbWorkerOut): void {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
}
