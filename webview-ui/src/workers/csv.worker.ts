import Papa from 'papaparse';
import type { CellValue, ColumnSchema, FilterSpec, SortSpec, InferredType } from '@shared/schema.js';
import { CHUNK_SIZE, TYPE_INFERENCE_SAMPLE_ROWS } from '@shared/constants.js';

export type CsvWorkerIn =
  | { type: 'PARSE'; payload: { text: string; delimiter?: string } }
  | { type: 'GET_CHUNK'; payload: { requestId: string; startRow: number; endRow: number; filters?: FilterSpec[]; sort?: SortSpec } }
  | { type: 'SERIALIZE'; payload: { delimiter: string } };

export type CsvWorkerOut =
  | { type: 'SCHEMA'; payload: { schema: ColumnSchema[]; totalRows: number } }
  | { type: 'CHUNK'; payload: { requestId: string; rows: CellValue[][]; startRow: number; endRow: number; filteredTotal: number } }
  | { type: 'SERIALIZED'; payload: { csv: string } }
  | { type: 'PROGRESS'; payload: { loaded: number; total: number } }
  | { type: 'ERROR'; payload: { message: string } };

// ── Worker state ──────────────────────────────────────────────────────────────

let _allRows: CellValue[][] = [];
let _headers: string[] = [];

// ── Message dispatch ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<CsvWorkerIn>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'PARSE':
      handleParse(msg.payload.text, msg.payload.delimiter);
      break;
    case 'GET_CHUNK':
      handleGetChunk(msg.payload);
      break;
    case 'SERIALIZE':
      handleSerialize(msg.payload.delimiter);
      break;
  }
};

// ── Parse ─────────────────────────────────────────────────────────────────────

function handleParse(text: string, delimiter?: string): void {
  _allRows = [];
  _headers = [];

  const result = Papa.parse<string[]>(text, {
    delimiter: delimiter ?? '',     // '' = auto-detect
    skipEmptyLines: true,
    header: false,
  });

  if (result.errors.length > 0 && result.data.length === 0) {
    post({ type: 'ERROR', payload: { message: result.errors[0].message } });
    return;
  }

  const raw = result.data as string[][];
  if (raw.length === 0) {
    post({ type: 'ERROR', payload: { message: 'File is empty' } });
    return;
  }

  _headers = raw[0];
  _allRows = raw.slice(1).map(row => row.map(cell => coerceCell(cell)));

  const schema = inferSchema(_headers, _allRows.slice(0, TYPE_INFERENCE_SAMPLE_ROWS));

  post({
    type: 'SCHEMA',
    payload: { schema, totalRows: _allRows.length },
  });

  // Send first chunk immediately
  post({
    type: 'CHUNK',
    payload: {
      requestId: '__init__',
      rows: _allRows.slice(0, CHUNK_SIZE),
      startRow: 0,
      endRow: Math.min(CHUNK_SIZE, _allRows.length),
      filteredTotal: _allRows.length,
    },
  });
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
    rows = [...rows].sort((a, b) => compareValues(a[sort.colIndex], b[sort.colIndex], sort.direction));
  }

  const filteredTotal = rows.length;
  const sliced = rows.slice(startRow, endRow);

  post({
    type: 'CHUNK',
    payload: {
      requestId,
      rows: sliced,
      startRow,
      endRow: startRow + sliced.length,
      filteredTotal,
    },
  });
}

// ── Serialize ─────────────────────────────────────────────────────────────────

function handleSerialize(delimiter: string): void {
  const lines: string[] = [];
  lines.push(_headers.map(h => escapeCell(h, delimiter)).join(delimiter));
  for (const row of _allRows) {
    lines.push(row.map(cell => escapeCell(String(cell ?? ''), delimiter)).join(delimiter));
  }
  post({ type: 'SERIALIZED', payload: { csv: lines.join('\n') } });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    return {
      name,
      index,
      inferredType: inferType(samples),
      nullable: nullCount > 0,
    };
  });
}

function applyFilter(row: CellValue[], f: FilterSpec): boolean {
  const cell = row[f.colIndex];
  const val = f.value;
  switch (f.op) {
    case 'eq':          return cell == val;
    case 'neq':         return cell != val;
    case 'contains':    return String(cell ?? '').toLowerCase().includes(String(val).toLowerCase());
    case 'not_contains':return !String(cell ?? '').toLowerCase().includes(String(val).toLowerCase());
    case 'gt':          return Number(cell) > Number(val);
    case 'lt':          return Number(cell) < Number(val);
    case 'gte':         return Number(cell) >= Number(val);
    case 'lte':         return Number(cell) <= Number(val);
    case 'regex':       return new RegExp(String(val), 'i').test(String(cell ?? ''));
    case 'is_null':     return cell === null;
    case 'is_not_null': return cell !== null;
    default:            return true;
  }
}

function compareValues(a: CellValue, b: CellValue, dir: 'asc' | 'desc'): number {
  const aStr = String(a ?? '');
  const bStr = String(b ?? '');
  const aNum = Number(a);
  const bNum = Number(b);
  let cmp: number;
  if (!isNaN(aNum) && !isNaN(bNum)) {
    cmp = aNum - bNum;
  } else {
    cmp = aStr.localeCompare(bStr);
  }
  return dir === 'asc' ? cmp : -cmp;
}

function escapeCell(val: string, delimiter: string): string {
  if (val.includes(delimiter) || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function post(msg: CsvWorkerOut): void {
  (self as unknown as Worker).postMessage(msg);
}
