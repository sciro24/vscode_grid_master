// Data worker — reads Parquet, Arrow and JSON files using parquet-wasm +
// apache-arrow. No external network calls, no DuckDB extension issues.

import * as arrow from 'apache-arrow';
import init, { readParquet } from 'parquet-wasm/esm/parquet_wasm.js';
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
  | { type: 'LOAD'; payload: { buffer: ArrayBuffer; fileType: 'parquet' | 'arrow' | 'json'; jsonFormat?: 'json' | 'ndjson'; bundles: DuckDbBundleSet } }
  | { type: 'GET_CHUNK'; payload: { requestId: string; startRow: number; endRow: number; filters?: FilterSpec[]; sort?: SortSpec } }
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
      case 'LOAD':      await handleLoad(msg.payload.buffer, msg.payload.fileType, msg.payload.bundles, msg.payload.jsonFormat); break;
      case 'GET_CHUNK': handleGetChunk(msg.payload); break;
      case 'QUERY':     break; // not implemented in this backend
    }
  } catch (err) {
    console.error('[GM worker] error in', msg.type, err);
    post({ type: 'ERROR', payload: { message: String(err) } });
  }
};

// ── Load ──────────────────────────────────────────────────────────────────────

async function handleLoad(buffer: ArrayBuffer, fileType: 'parquet' | 'arrow' | 'json', bundles: DuckDbBundleSet, jsonFormat: 'json' | 'ndjson' = 'json'): Promise<void> {
  console.log('[GM worker] handleLoad', fileType, buffer.byteLength, 'bytes');

  let table: arrow.Table;

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
    table = arrow.tableFromIPC(new Uint8Array(buffer));
  } else {
    // JSON / NDJSON — parse inline
    const text = new TextDecoder().decode(buffer);
    const rawRows: Record<string, unknown>[] = jsonFormat === 'ndjson'
      ? text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : JSON.parse(text);
    table = arrow.tableFromJSON(rawRows);
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

function coerceArrowValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v as CellValue;
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
}): void {
  const { requestId, startRow, endRow, filters, sort } = payload;

  let rows = _allRows;

  if (filters && filters.length > 0) {
    rows = rows.filter(row => filters.every(f => applyFilter(row, f)));
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
