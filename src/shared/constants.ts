export const CHUNK_SIZE = 500;
export const MAX_CHUNKS_IN_MEMORY = 50;
export const PREFETCH_THRESHOLD = 0.75; // prefetch when 75% through current chunk
export const SMALL_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;   // 5MB
export const LARGE_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024;  // 50MB
export const TYPE_INFERENCE_SAMPLE_ROWS = 1000;

export const SUPPORTED_FILE_TYPES = ['csv', 'tsv', 'txt', 'parquet', 'parq', 'arrow', 'feather', 'json', 'jsonl', 'ndjson', 'xlsx', 'xlsb', 'xls', 'xlsm', 'avro', 'db', 'sqlite', 'sqlite3', 'orc'] as const;
export type SupportedFileType = typeof SUPPORTED_FILE_TYPES[number];

export const VIEW_TYPES = {
  CSV: 'gridMaster.csvEditor',
  PARQUET: 'gridMaster.parquetEditor',
  ARROW: 'gridMaster.arrowEditor',
  JSON: 'gridMaster.jsonEditor',
  EXCEL: 'gridMaster.excelEditor',
  AVRO: 'gridMaster.avroEditor',
  SQLITE: 'gridMaster.sqliteEditor',
  ORC: 'gridMaster.orcEditor',
} as const;
