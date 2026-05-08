// DuckDB-WASM Web Worker
// DuckDB is bundled into this worker by Vite. The runtime asset URLs (wasm +
// inner worker) are provided by the host as same-origin webview URIs so the
// CSP doesn't have to allow jsdelivr.

import * as duckdb from '@duckdb/duckdb-wasm';

import type { CellValue, ColumnSchema, FilterSpec, SortSpec, InferredType } from '@shared/schema.js';
import { CHUNK_SIZE } from '@shared/constants.js';

export type DuckDbBundleSet = {
  mvp: { mainModule: string; mainWorker: string };
  eh:  { mainModule: string; mainWorker: string };
  coi?: { mainModule: string; mainWorker: string; pthreadWorker: string };
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

// ── Runtime-only DuckDB types (not imported at module level) ──────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DuckDBConn = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DuckDB = any;

let _db: DuckDB | null = null;
let _conn: DuckDBConn | null = null;
let _colNames: string[] = [];

// ── Message dispatch ──────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<DuckDbWorkerIn>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'LOAD':   await handleLoad(msg.payload.buffer, msg.payload.fileType, msg.payload.bundles, msg.payload.jsonFormat); break;
      case 'GET_CHUNK': await handleGetChunk(msg.payload); break;
      case 'QUERY':  await handleQuery(msg.payload); break;
    }
  } catch (err) {
    post({ type: 'ERROR', payload: { message: String(err) } });
  }
};

// ── Load ──────────────────────────────────────────────────────────────────────

async function handleLoad(buffer: ArrayBuffer, fileType: 'parquet' | 'arrow' | 'json', bundles: DuckDbBundleSet, jsonFormat: 'json' | 'ndjson' = 'json'): Promise<void> {
  const bundle = await duckdb.selectBundle(bundles);

  // The selected mainWorker URL is a webview URI (vscode-cdn.net), which is
  // cross-origin to the worker — so we wrap it in a same-origin blob via
  // importScripts to keep the browser happy.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'application/javascript' }),
  );
  const innerWorker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);

  _db = new duckdb.AsyncDuckDB(logger, innerWorker);
  await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  _conn = await _db.connect();

  const extByType: Record<string, string> = { parquet: 'parquet', arrow: 'arrow', json: jsonFormat === 'ndjson' ? 'ndjson' : 'json' };
  const ext = extByType[fileType];
  const fileName = `file.${ext}`;
  await _db.registerFileBuffer(fileName, new Uint8Array(buffer));

  let viewSql: string;
  if (fileType === 'parquet') {
    viewSql = `CREATE VIEW data AS SELECT * FROM read_parquet('${fileName}')`;
  } else if (fileType === 'arrow') {
    viewSql = `CREATE VIEW data AS SELECT * FROM read_arrow('${fileName}')`;
  } else {
    // JSON: use ndjson format hint when applicable. read_json_auto handles both
    // arrays-of-objects and ndjson with `format='auto'`.
    const fmt = jsonFormat === 'ndjson' ? 'newline_delimited' : 'auto';
    viewSql = `CREATE VIEW data AS SELECT * FROM read_json_auto('${fileName}', format='${fmt}')`;
  }
  await _conn.query(viewSql);

  const schemaRes = await _conn.query(`DESCRIBE data`);
  const countRes  = await _conn.query(`SELECT COUNT(*) as n FROM data`);

  const schemaRows = schemaRes.toArray() as Record<string, unknown>[];
  _colNames = schemaRows.map(r => String(r['column_name']));

  const schema: ColumnSchema[] = schemaRows.map((r, index) => ({
    name:         String(r['column_name']),
    index,
    inferredType: duckTypeToInferred(String(r['column_type'])),
    nullable:     String(r['null']) === 'YES',
  }));

  const totalRows = Number((countRes.toArray()[0] as Record<string, unknown>)['n']);
  post({ type: 'READY', payload: { schema, totalRows } });
}

// ── Get Chunk ─────────────────────────────────────────────────────────────────

async function handleGetChunk(payload: {
  requestId: string;
  startRow: number;
  endRow: number;
  filters?: FilterSpec[];
  sort?: SortSpec;
}): Promise<void> {
  if (!_conn) throw new Error('DuckDB not initialized');

  const { requestId, startRow, endRow, filters, sort } = payload;
  const limit = endRow - startRow;

  const whereParts = filters?.map(f => filterToSql(f, _colNames)).filter(Boolean) ?? [];
  const whereStr   = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
  const orderStr   = sort
    ? `ORDER BY "${escapeSql(_colNames[sort.colIndex] ?? String(sort.colIndex))}" ${sort.direction.toUpperCase()}`
    : '';

  const [dataRes, countRes] = await Promise.all([
    _conn.query(`SELECT * FROM data ${whereStr} ${orderStr} LIMIT ${limit} OFFSET ${startRow}`),
    _conn.query(`SELECT COUNT(*) as n FROM data ${whereStr}`),
  ]);

  const rows: CellValue[][] = (dataRes.toArray() as Record<string, unknown>[]).map(row =>
    _colNames.map(col => {
      const v = row[col];
      if (v === null || v === undefined) return null;
      if (typeof v === 'bigint') return Number(v);
      return v as CellValue;
    }),
  );

  const filteredTotal = Number((countRes.toArray()[0] as Record<string, unknown>)['n']);
  post({ type: 'CHUNK', payload: { requestId, rows, startRow, endRow: startRow + rows.length, filteredTotal } });
}

// ── Query ─────────────────────────────────────────────────────────────────────

async function handleQuery(payload: { requestId: string; sql: string }): Promise<void> {
  if (!_conn) throw new Error('DuckDB not initialized');

  const result = await _conn.query(payload.sql);
  const colNames: string[] = result.schema.fields.map((f: { name: string }) => f.name);
  const rows: CellValue[][] = (result.toArray() as Record<string, unknown>[]).map(row =>
    colNames.map(col => {
      const v = row[col];
      if (v === null || v === undefined) return null;
      if (typeof v === 'bigint') return Number(v);
      return v as CellValue;
    }),
  );

  post({ type: 'QUERY_RESULT', payload: { requestId: payload.requestId, rows, columns: colNames } });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function duckTypeToInferred(duckType: string): InferredType {
  const t = duckType.toUpperCase();
  if (/INT|FLOAT|DOUBLE|DECIMAL|NUMERIC|HUGEINT|UBIGINT/.test(t)) return 'number';
  if (/BOOL/.test(t)) return 'boolean';
  if (/DATE|TIME|TIMESTAMP/.test(t)) return 'date';
  return 'string';
}

function filterToSql(f: FilterSpec, colNames: string[]): string {
  const colName = colNames[f.colIndex] ?? `col${f.colIndex}`;
  const col = `"${escapeSql(colName)}"`;
  const val = typeof f.value === 'string'
    ? `'${escapeSqlStr(f.value)}'`
    : String(f.value);

  switch (f.op) {
    case 'eq':           return `${col} = ${val}`;
    case 'neq':          return `${col} != ${val}`;
    case 'contains':     return `${col}::VARCHAR ILIKE '%${escapeSqlStr(String(f.value))}%'`;
    case 'not_contains': return `${col}::VARCHAR NOT ILIKE '%${escapeSqlStr(String(f.value))}%'`;
    case 'gt':           return `${col} > ${val}`;
    case 'lt':           return `${col} < ${val}`;
    case 'gte':          return `${col} >= ${val}`;
    case 'lte':          return `${col} <= ${val}`;
    case 'regex':        return `regexp_matches(${col}::VARCHAR, '${escapeSqlStr(String(f.value))}')`;
    case 'is_null':      return `${col} IS NULL`;
    case 'is_not_null':  return `${col} IS NOT NULL`;
    default:             return '';
  }
}

function escapeSql(s: string): string    { return s.replace(/"/g, '""'); }
function escapeSqlStr(s: string): string { return s.replace(/'/g, "''"); }

function post(msg: DuckDbWorkerOut): void {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
}
