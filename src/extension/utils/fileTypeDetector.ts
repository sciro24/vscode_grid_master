import * as path from 'path';
import type { SupportedFileType } from '../../shared/constants.js';

export function detectFileType(uri: { fsPath: string }): SupportedFileType {
  const ext = path.extname(uri.fsPath).replace(/^\./, '').toLowerCase();
  switch (ext) {
    case 'parquet':
    case 'parq':
      return 'parquet';
    case 'arrow':
    case 'feather':
      return 'arrow';
    case 'json':
    case 'jsonl':
    case 'ndjson':
      return 'json';
    case 'xlsx':
    case 'xlsb':
    case 'xls':
    case 'xlsm':
    case 'ods':
      return 'xlsx';
    case 'avro':
      return 'avro';
    case 'db':
    case 'sqlite':
    case 'sqlite3':
      return 'db';
    case 'orc':
      return 'orc';
    default:
      return 'csv';
  }
}

const DELIMITER_PATTERNS: Record<string, RegExp> = {
  ',':  /,/g,
  ';':  /;/g,
  '\t': /\t/g,
  '|':  /\|/g,
};

export function inferDelimiter(sample: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  const lines = sample.split('\n').slice(0, 10);
  for (const line of lines) {
    for (const [delim, re] of Object.entries(DELIMITER_PATTERNS)) {
      counts[delim] += (line.match(re) ?? []).length;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
