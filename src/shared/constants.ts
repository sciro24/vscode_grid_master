export const CHUNK_SIZE = 500;
export const MAX_CHUNKS_IN_MEMORY = 50;
export const TYPE_INFERENCE_SAMPLE_ROWS = 1000;

export const SUPPORTED_FILE_TYPES = ['csv', 'tsv', 'txt', 'parquet', 'parq', 'arrow', 'feather', 'json', 'jsonl', 'ndjson', 'xlsx', 'xlsb', 'xls', 'xlsm', 'ods', 'avro', 'db', 'sqlite', 'sqlite3', 'orc'] as const;
export type SupportedFileType = typeof SUPPORTED_FILE_TYPES[number];

export const VIEW_TYPES = {
  CSV: 'gridMaster.csvEditor',
  PARQUET: 'gridMaster.parquetEditor',
  ARROW: 'gridMaster.arrowEditor',
  JSON: 'gridMaster.jsonEditor',
  JSON_ARRAY: 'gridMaster.jsonArrayEditor',
  EXCEL: 'gridMaster.excelEditor',
  AVRO: 'gridMaster.avroEditor',
  SQLITE: 'gridMaster.sqliteEditor',
  ORC: 'gridMaster.orcEditor',
} as const;
