import type { SupportedFileType } from '../../shared/constants.js';

export function detectFileType(uri: { fsPath: string }): SupportedFileType {
  const ext = uri.fsPath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'parquet':
    case 'parq':
      return 'parquet';
    case 'arrow':
    case 'feather':
      return 'arrow';
    default:
      return 'csv';
  }
}

export function inferDelimiter(sample: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  const lines = sample.split('\n').slice(0, 10);
  for (const line of lines) {
    for (const delim of Object.keys(counts)) {
      counts[delim] += (line.match(new RegExp(`\\${delim}`, 'g')) ?? []).length;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
