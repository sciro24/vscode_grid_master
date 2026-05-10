import Papa from 'papaparse';
import type { HostMessage } from '@shared/messages.js';
import type { CellValue, ColumnSchema, InferredType } from '@shared/schema.js';
import { CHUNK_SIZE, TYPE_INFERENCE_SAMPLE_ROWS } from '@shared/constants.js';
import { gridStore } from '../stores/grid.svelte.js';
import { uiStore } from '../stores/ui.svelte.js';

type RawCsvMessage    = { type: '__RAW_CSV__';    payload: { text: string; totalBytes: number } };
type DuckBundles = {
  eh: { mainWorkerB64: string; mainModuleB64: string };
  extensions: { parquetB64: string; jsonB64: string };
  parquetWasmB64?: string;
};

type RawBinaryMessage = { type: '__RAW_BINARY__'; payload: { base64?: string; base64Parts?: string[]; fileType: 'parquet' | 'arrow' | 'json' | 'excel' | 'avro'; jsonFormat?: 'json' | 'ndjson'; duckBundles: DuckBundles } };
type RawRowsMessage   = { type: '__RAW_ROWS__';   payload: { schema: ColumnSchema[]; rows: CellValue[][]; duckBundles: DuckBundles } };
type ExportPathMessage = { type: '__EXPORT_PATH__'; payload: { fsPath: string } };
type AnyMessage = HostMessage | RawCsvMessage | RawBinaryMessage | RawRowsMessage | ExportPathMessage;

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
        if (!msg.payload.success && msg.payload.error) {
          uiStore.setError(`Save failed: ${msg.payload.error}`);
        }
        break;

      case 'EDIT_ACK':
        gridStore.handleEditAck(msg.payload);
        break;

      case 'COLUMN_STATS':
        gridStore.receiveColumnStats(msg.payload);
        break;

      case '__RAW_CSV__':
        parseCsvInline(msg.payload.text, msg.payload.totalBytes);
        break;

      case '__RAW_BINARY__': {
        const { fileType, duckBundles, jsonFormat, base64, base64Parts } = msg.payload;
        if (base64Parts && base64Parts.length > 0) {
          console.log('[GM] __RAW_BINARY__', fileType, 'parts=', base64Parts.length);
          const buffers = base64Parts.map(b64 => {
            const binary = atob(b64);
            const buf = new ArrayBuffer(binary.length);
            const view = new Uint8Array(buf);
            for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
            return buf;
          });
          gridStore.loadRawBinaryParts(buffers, fileType, duckBundles);
        } else if (base64) {
          console.log('[GM] __RAW_BINARY__', fileType, 'base64 len', base64.length);
          const binary = atob(base64);
          const buf = new ArrayBuffer(binary.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
          gridStore.loadRawBinary(buf, fileType, duckBundles, jsonFormat);
        }
        break;
      }

      case '__RAW_ROWS__':
        gridStore.receiveRawRows(msg.payload.schema, msg.payload.rows);
        break;

      case '__EXPORT_PATH__':
        gridStore.handleExportPath(msg.payload.fsPath);
        break;
    }
  };

  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
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

    gridStore.receiveCsvData(schema, allRows);
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
