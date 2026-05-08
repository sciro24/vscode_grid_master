// Data worker — reads Parquet, Arrow and JSON files using parquet-wasm +
// apache-arrow. No external network calls, no DuckDB extension issues.

import * as arrow from 'apache-arrow';
import init, { readParquet } from 'parquet-wasm/esm/parquet_wasm.js';
import * as XLSX from 'xlsx';
import type { CellValue, ColumnSchema, FilterSpec, SortSpec, InferredType } from '@shared/schema.js';
import { CHUNK_SIZE } from '@shared/constants.js';

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

  // Materialise all rows into CellValue[][] for fast in-worker sort/filter
  _allRows = [];
  const colNames = _schema.map(c => c.name);
  for (let r = 0; r < table.numRows; r++) {
    const row: CellValue[] = colNames.map(name => {
      const v = table.getChild(name)?.get(r);
      return coerceArrowValue(v);
    });
    _allRows.push(row);
  }

  post({ type: 'READY', payload: { schema: _schema, totalRows: _allRows.length } });
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

  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    let table: arrow.Table;
    if (fileType === 'parquet') {
      const wasmTable = readParquet(new Uint8Array(buf));
      table = arrow.tableFromIPC(wasmTable.intoIPCStream());
    } else {
      table = arrow.tableFromIPC(new Uint8Array(buf));
    }

    // Use the schema from the first part; subsequent parts must match
    if (i === 0) {
      _schema = table.schema.fields.map((f, index) => ({
        name: f.name,
        index,
        inferredType: arrowTypeToInferred(f.type),
        nullable: f.nullable,
      }));
    }

    const colNames = _schema.map(c => c.name);
    for (let r = 0; r < table.numRows; r++) {
      const row: CellValue[] = colNames.map(name => {
        const v = table.getChild(name)?.get(r);
        return coerceArrowValue(v);
      });
      _allRows.push(row);
    }

    console.log('[GM worker] part', i + 1, '/', buffers.length, 'loaded,', table.numRows, 'rows, total so far:', _allRows.length);
  }

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

  let rows = _allRows;

  if (filters && filters.length > 0) {
    rows = rows.filter(row => filters.every(f => applyFilter(row, f)));
  }

  const q = globalSearch?.trim().toLowerCase();
  if (q) {
    rows = rows.filter(row => row.some(cell => String(cell ?? '').toLowerCase().includes(q)));
  }

  if (sort) {
    const { colIndex, direction } = sort;
    rows = [...rows].sort((a, b) => compareValues(a[colIndex], b[colIndex], direction));
  }

  const filteredTotal = rows.length;
  const sliced = rows.slice(startRow, Math.min(endRow, rows.length));

  post({ type: 'CHUNK', payload: { requestId, rows: sliced, startRow, endRow: startRow + sliced.length, filteredTotal } });
}

// ── Filter / sort helpers ─────────────────────────────────────────────────────

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
    case 'regex':        try { return new RegExp(String(val), 'i').test(String(cell ?? '')); } catch { return false; }
    case 'is_null':      return cell === null;
    case 'is_not_null':  return cell !== null;
    default:             return true;
  }
}

function compareValues(a: CellValue, b: CellValue, dir: 'asc' | 'desc'): number {
  const aNum = Number(a), bNum = Number(b);
  let cmp: number;
  if (!isNaN(aNum) && !isNaN(bNum)) {
    cmp = aNum - bNum;
  } else {
    cmp = String(a ?? '').localeCompare(String(b ?? ''));
  }
  return dir === 'asc' ? cmp : -cmp;
}

function post(msg: DuckDbWorkerOut): void {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
}
