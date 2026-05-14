import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import Papa from 'papaparse';
import { DocumentModel } from './DocumentModel.js';
import { FileReaderService } from './FileReaderService.js';
import { detectFileType } from './utils/fileTypeDetector.js';
import type { HostMessage, WebviewMessage } from '../shared/messages.js';
import type { CellValue, ColumnSchema, InferredType } from '../shared/schema.js';

export class GridEditorProvider implements vscode.CustomEditorProvider<DocumentModel> {
  private static readonly _fileReader = new FileReaderService();

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<DocumentModel>
  >();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  static register(context: vscode.ExtensionContext, viewType: string): vscode.Disposable {
    const provider = new GridEditorProvider(context);
    context.subscriptions.push(provider._onDidChangeCustomDocument);
    return vscode.window.registerCustomEditorProvider(
      viewType,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    );
  }

  constructor(private readonly _context: vscode.ExtensionContext) {}

  // ── Undo/redo capability state (per panel) ───────────────────────────────
  private _undoState = new WeakMap<vscode.Webview, { canUndo: boolean; canRedo: boolean }>();

  // ── Export state (per-panel, keyed by panel webview) ─────────────────────
  private _exportStreams = new WeakMap<vscode.Webview, {
    stream: fs.WriteStream;
    fsPath: string;
    cancelled: boolean;
    format: 'csv' | 'tsv' | 'json';
    jsonStarted: boolean;
  }>();

  // ── CustomEditorProvider ──────────────────────────────────────────────────

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<DocumentModel> {
    const detectedType = detectFileType(uri);
    const fileType: DocumentModel['fileType'] =
      detectedType === 'parquet' || detectedType === 'parq'   ? 'parquet' :
      detectedType === 'arrow'   || detectedType === 'feather' ? 'arrow' :
      detectedType === 'json'    || detectedType === 'jsonl' || detectedType === 'ndjson' ? 'json' :
      detectedType === 'xlsx'    || detectedType === 'xlsb' || detectedType === 'xls' || detectedType === 'xlsm' ? 'excel' :
      detectedType === 'avro'    ? 'avro' :
      detectedType === 'db'      || detectedType === 'sqlite' || detectedType === 'sqlite3' ? 'sqlite' :
      detectedType === 'orc'     ? 'orc' :
      'csv';

    const doc = new DocumentModel(uri, fileType);
    const sidecar = await GridEditorProvider._fileReader.readSidecar(uri);
    if (sidecar) {
      doc.sidecar = sidecar;
    }
    return doc;
  }

  async resolveCustomEditor(
    document: DocumentModel,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'dist'),
      ],
    };

    const disposables: vscode.Disposable[] = [];

    // Register listener BEFORE setting html to avoid race condition:
    // webview may fire READY before onDidReceiveMessage is wired if html is set first.
    disposables.push(
      webviewPanel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
        await this._handleWebviewMessage(msg, document, webviewPanel);
      }),
    );

    // Now set html — listener is already active
    webviewPanel.webview.html = this._getHtml(webviewPanel.webview);

    webviewPanel.onDidDispose(() => {
      disposables.forEach(d => d.dispose());
    });
  }

  async saveCustomDocument(
    document: DocumentModel,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    await this._saveDocument(document, cancellation);
  }

  async saveCustomDocumentAs(
    document: DocumentModel,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    await this._saveDocument(document, cancellation, destination);
  }

  async revertCustomDocument(document: DocumentModel, _cancellation: vscode.CancellationToken): Promise<void> {
    document.clearPatches();
  }

  async backupCustomDocument(
    document: DocumentModel,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const data = await GridEditorProvider._fileReader.readAll(document.uri);
    await GridEditorProvider._fileReader.writeFile(context.destination, data);
    return {
      id: context.destination.toString(),
      delete: () => vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined),
    };
  }

  // ── Message Handling ──────────────────────────────────────────────────────

  private async _handleWebviewMessage(
    msg: WebviewMessage,
    document: DocumentModel,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const send = (m: HostMessage) => panel.webview.postMessage(m);

    switch (msg.type) {
      case 'READY':
        await this._sendInit(document, panel);
        break;

      case 'REQUEST_CHUNK':
        // For CSV the webview worker handles chunks internally.
        // For Parquet/Arrow this would query DuckDB in the host — deferred.
        void msg.payload;
        break;

      case 'EDIT': {
        const { editId, row, col, oldValue, newValue } = msg.payload;
        try {
          document.applyEdit({ id: editId, row, col, oldValue, newValue });
          send({ type: 'EDIT_ACK', payload: { editId, success: true } });
        } catch (e) {
          send({ type: 'EDIT_ACK', payload: { editId, success: false, error: String(e) } });
        }
        break;
      }

      case 'BATCH_EDIT': {
        const { editId, edits } = msg.payload;
        try {
          document.applyBatchEdit({ id: editId, edits });
          send({ type: 'EDIT_ACK', payload: { editId, success: true } });
        } catch (e) {
          send({ type: 'EDIT_ACK', payload: { editId, success: false, error: String(e) } });
        }
        break;
      }

      case 'SAVE': {
        const cts = new vscode.CancellationTokenSource();
        try {
          await this._saveDocument(document, cts.token);
          send({ type: 'SAVE_ACK', payload: { success: true } });
        } finally {
          cts.dispose();
        }
        break;
      }

      case 'SAVE_DATA': {
        // The webview owns the canonical _csvAllRows + schema after structural
        // edits, so it serializes and we just write the bytes.
        try {
          const bytes = new TextEncoder().encode(msg.payload.content);
          await GridEditorProvider._fileReader.writeFile(document.uri, bytes);
          document.clearPatches();
          send({ type: 'SAVE_ACK', payload: { success: true } });
        } catch (e) {
          send({ type: 'SAVE_ACK', payload: { success: false, error: String(e) } });
        }
        break;
      }

      case 'CAN_UNDO_STATE':
        this._undoState.set(panel.webview, msg.payload);
        break;

      case 'UNDO': {
        const undoState = this._undoState.get(panel.webview);
        if (undoState?.canUndo) {
          // Webview has history — let it handle undo.
          send({ type: 'WEBVIEW_UNDO' });
        } else {
          await vscode.commands.executeCommand('undo');
        }
        break;
      }

      case 'REDO': {
        const redoState = this._undoState.get(panel.webview);
        if (redoState?.canRedo) {
          send({ type: 'WEBVIEW_REDO' });
        } else {
          await vscode.commands.executeCommand('redo');
        }
        break;
      }

      case 'SAVE_SIDECAR':
        await GridEditorProvider._fileReader.writeSidecar(document.uri, msg.payload.sidecar);
        document.sidecar = msg.payload.sidecar;
        break;

      case 'EXPORT':
        await this._handleExport(msg.payload, panel);
        break;

      case 'EXPORT_DATA_BATCH':
        await this._handleExportBatch(msg.payload, panel);
        break;

      case 'EXPORT_CANCEL':
        this._cancelExport(panel);
        break;
    }
  }

  // ── Init: send file data to webview ──────────────────────────────────────

  private async _sendInit(document: DocumentModel, panel: vscode.WebviewPanel): Promise<void> {
    const send = (m: HostMessage) => panel.webview.postMessage(m);

    try {
      send({ type: 'LOADING', payload: { active: true, message: 'Reading file...' } });

      const stat = await GridEditorProvider._fileReader.stat(document.uri);
      const totalBytes = stat.size;
      const fileName = path.basename(document.uri.fsPath);

      const duckWorkerUrl = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'dist', 'duckdb.worker.js'),
      ).toString();

      const duckAsset = (file: string): string =>
        panel.webview.asWebviewUri(
          vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'dist', file),
        ).toString();

      // Read parquet-wasm runtime bytes once and pass to the worker as base64.
      const readDistB64 = async (file: string): Promise<string> => {
        try {
          const uri = vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'dist', file);
          const bytes = await vscode.workspace.fs.readFile(uri);
          return Buffer.from(bytes).toString('base64');
        } catch {
          return '';
        }
      };
      const parquetWasmB64 = await readDistB64('parquet_wasm_bg.wasm');

      const duckBundles = {
        parquetWasmB64,
        duckdbWasmUrl: duckAsset('duckdb-mvp.wasm'),
        duckdbWorkerUrl: duckAsset('duckdb-browser-mvp.worker.js'),
      };

      if (document.fileType === 'orc') {
        await this._sendOrcData(document, panel, fileName, totalBytes, parquetWasmB64, duckWorkerUrl, { duckdbWasmUrl: duckBundles.duckdbWasmUrl!, duckdbWorkerUrl: duckBundles.duckdbWorkerUrl! });
        send({ type: 'LOADING', payload: { active: false } });
        return;
      }

      if (document.fileType === 'sqlite') {
        await this._sendSqliteData(document, panel, fileName, totalBytes, parquetWasmB64, duckWorkerUrl, { duckdbWasmUrl: duckBundles.duckdbWasmUrl!, duckdbWorkerUrl: duckBundles.duckdbWorkerUrl! });
        send({ type: 'LOADING', payload: { active: false } });
        return;
      }

      if (document.fileType === 'avro') {
        await this._sendAvroData(document, panel, fileName, totalBytes, parquetWasmB64, duckWorkerUrl, { duckdbWasmUrl: duckBundles.duckdbWasmUrl!, duckdbWorkerUrl: duckBundles.duckdbWorkerUrl! });
        send({ type: 'LOADING', payload: { active: false } });
        return;
      }

      if (document.fileType === 'csv') {
        // Files large enough that a single UTF-8 decoded string would exceed
        // V8's ~512 MB string limit (0x1fffffe8) need to be parsed host-side
        // via a Node read stream instead of shipped as one giant text payload.
        const LARGE_CSV_THRESHOLD = 256 * 1024 * 1024; // ~256 MB on-disk
        if (totalBytes > LARGE_CSV_THRESHOLD) {
          const mb = Math.round(totalBytes / (1024 * 1024));
          // Show in-webview warning; wait for user to confirm or cancel.
          panel.webview.postMessage({ type: '__LARGE_FILE_WARNING__', payload: { fileSizeMb: mb } });
          const choice = await new Promise<'full' | 'preview' | 'cancel'>((resolve) => {
            let resolved = false;
            const finish = (value: 'full' | 'preview' | 'cancel') => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeout);
              sub.dispose();
              disposeSub.dispose();
              resolve(value);
            };
            const sub = panel.webview.onDidReceiveMessage((m) => {
              if (m.type === 'LARGE_FILE_OPEN_CONFIRM') finish('full');
              else if (m.type === 'LARGE_FILE_OPEN_PREVIEW') finish('preview');
              else if (m.type === 'LARGE_FILE_OPEN_CANCEL') finish('cancel');
            });
            const disposeSub = panel.onDidDispose(() => finish('cancel'));
            const timeout = setTimeout(() => finish('cancel'), 60_000);
          });
          if (choice === 'cancel') { panel.dispose(); return; }
          const previewOnly = choice === 'preview';
          const PREVIEW_ROW_LIMIT = 100_000;
          send({
            type: 'INIT',
            payload: {
              fileType: 'csv',
              fileName,
              totalRows: -1,
              totalBytes,
              schema: [],
              firstChunk: { rows: [], startRow: 0, endRow: 0 },
              sidecar: document.sidecar,
            },
          });
          send({ type: 'LOADING', payload: { active: true, message: previewOnly ? 'Loading preview…' : 'Parsing large CSV…' } });
          await this._streamParseLargeCsv(document.uri, panel, send, previewOnly ? PREVIEW_ROW_LIMIT : undefined);
          send({ type: 'LOADING', payload: { active: false } });
        } else {
          const raw = await GridEditorProvider._fileReader.readAll(document.uri);
          const text = new TextDecoder('utf-8').decode(raw);

          send({
            type: 'INIT',
            payload: {
              fileType: 'csv',
              fileName,
              totalRows: -1,
              totalBytes,
              schema: [],
              firstChunk: { rows: [], startRow: 0, endRow: 0 },
              sidecar: document.sidecar,
            },
          });

          panel.webview.postMessage({ type: '__RAW_CSV__', payload: { text, totalBytes } });
          // LOADING:false is sent by the webview after it finishes parsing CSV inline.
        }
      } else if (document.fileType === 'json') {
        const bytes = await GridEditorProvider._fileReader.readAll(document.uri);
        const ext = path.extname(document.uri.fsPath).toLowerCase();
        const isNdjson = ext === '.jsonl' || ext === '.ndjson';

        send({
          type: 'INIT',
          payload: {
            fileType: 'json',
            fileName,
            totalRows: -1,
            totalBytes,
            schema: [],
            firstChunk: { rows: [], startRow: 0, endRow: 0 },
            sidecar: document.sidecar,
            duckWorkerUrl,
          },
        });

        const jsonParts = GridEditorProvider._encodeBase64Chunked(bytes);
        if (jsonParts.length === 1) {
          panel.webview.postMessage({
            type: '__RAW_BINARY__',
            payload: { base64: jsonParts[0], fileType: 'json', jsonFormat: isNdjson ? 'ndjson' : 'json', duckBundles },
          });
        } else {
          panel.webview.postMessage({
            type: '__RAW_BINARY__',
            payload: { base64Parts: jsonParts, singleFileSplit: true, fileType: 'json', jsonFormat: isNdjson ? 'ndjson' : 'json', duckBundles },
          });
        }
        send({ type: 'LOADING', payload: { active: false } });
      } else {
        // excel is a single-buffer binary format handled in the webview worker
        const isSingleBinary = document.fileType === 'excel';

        if (isSingleBinary) {
          const bytes = await GridEditorProvider._fileReader.readAll(document.uri);
          send({
            type: 'INIT',
            payload: {
              fileType: document.fileType,
              fileName,
              totalRows: -1,
              totalBytes,
              schema: [],
              firstChunk: { rows: [], startRow: 0, endRow: 0 },
              sidecar: document.sidecar,
              duckWorkerUrl,
            },
          });
          const xlsxParts = GridEditorProvider._encodeBase64Chunked(bytes);
          if (xlsxParts.length === 1) {
            panel.webview.postMessage({
              type: '__RAW_BINARY__',
              payload: { base64: xlsxParts[0], fileType: document.fileType, duckBundles },
            });
          } else {
            panel.webview.postMessage({
              type: '__RAW_BINARY__',
              payload: { base64Parts: xlsxParts, singleFileSplit: true, fileType: document.fileType, duckBundles },
            });
          }
          send({ type: 'LOADING', payload: { active: false } });
        } else {
          // parquet / arrow — check for partitioned directory (Spark-style).
          // Use the stat already obtained at the top of _sendInit.
          const isPartitionedDir = stat.type === vscode.FileType.Directory;

          let partFiles: Uint8Array[] = [];

          if (isPartitionedDir) {
            send({ type: 'LOADING', payload: { active: true, message: 'Reading partitioned dataset...' } });
            const entries = await vscode.workspace.fs.readDirectory(document.uri);

            // Accept any non-hidden file containing ".parquet" in its name
            // (covers .snappy.parquet, .zstd.parquet, plain .parquet, etc.)
            const partNames = entries
              .filter(([name, type]) =>
                type === vscode.FileType.File &&
                !name.startsWith('.') &&
                name.toLowerCase().includes('.parquet'),
              )
              .map(([name]) => name)
              .sort();

            if (partNames.length === 0) {
              send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: 'No Parquet part files found in this directory.' } });
              return;
            }

            for (const name of partNames) {
              const partUri = vscode.Uri.joinPath(document.uri, name);
              const bytes = await GridEditorProvider._fileReader.readAll(partUri);
              partFiles.push(bytes);
            }
          } else {
            const bytes = await GridEditorProvider._fileReader.readAll(document.uri);
            partFiles = [bytes];
          }

          send({
            type: 'INIT',
            payload: {
              fileType: document.fileType,
              fileName,
              totalRows: -1,
              totalBytes,
              schema: [],
              firstChunk: { rows: [], startRow: 0, endRow: 0 },
              sidecar: document.sidecar,
              duckWorkerUrl,
            },
          });

          if (partFiles.length === 1) {
            const chunks = GridEditorProvider._encodeBase64Chunked(partFiles[0]);
            if (chunks.length === 1) {
              panel.webview.postMessage({
                type: '__RAW_BINARY__',
                payload: { base64: chunks[0], fileType: document.fileType, duckBundles },
              });
            } else {
              panel.webview.postMessage({
                type: '__RAW_BINARY__',
                payload: { base64Parts: chunks, singleFileSplit: true, fileType: document.fileType, duckBundles },
              });
            }
          } else {
            // Partitioned dataset: each part is its own file. Encode each
            // part directly — if any single part exceeds ~512 MB it would
            // throw, but Spark-style part-files are typically far smaller.
            const parts = partFiles.map(b => Buffer.from(b).toString('base64'));
            panel.webview.postMessage({
              type: '__RAW_BINARY__',
              payload: { base64Parts: parts, fileType: document.fileType, duckBundles },
            });
          }
          send({ type: 'LOADING', payload: { active: false } });
        }
      }
    } catch (e) {
      send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: String(e) } });
    }
  }

  private async _saveDocument(
    document: DocumentModel,
    cancellation: vscode.CancellationToken,
    destination?: vscode.Uri,
  ): Promise<void> {
    if (!document.isDirty && !destination) return;
    if (cancellation.isCancellationRequested) return;
    if (document.fileType !== 'csv') {
      vscode.window.showWarningMessage('Saving edits is only supported for CSV files. Your changes will not be written to disk.');
      document.clearPatches();
      return;
    }
    document.clearPatches();
  }

  // Stream-parse a CSV/TSV file that is too large to UTF-8 decode in one shot
  // (V8 string limit ~512 MB). Uses a Node read stream + Papa.parse with a
  // step callback so we never hold the full file as a single string. Rows are
  // accumulated as CellValue[][] (each cell is its own small string), schema
  // is inferred from the first sample, and everything is shipped to the
  // webview in a single structured-clone postMessage (no string-size limit
  // applies to arrays of small strings).
  private async _streamParseLargeCsv(
    uri: vscode.Uri,
    panel: vscode.WebviewPanel,
    send: (m: HostMessage) => void,
    rowLimit?: number,
  ): Promise<void> {
    // Stream-parse the file row-by-row, batching parsed rows into small
    // structured-clone postMessages. VS Code's IPC layer between extension
    // host and webview can serialize message payloads as JSON internally,
    // which would re-introduce the V8 string limit if we sent millions of
    // rows in one shot. Batching keeps each serialized message comfortably
    // small (~50 MB JSON at 100k rows × moderate column count).
    const TYPE_SAMPLE_ROWS = 1000;
    const BATCH_ROWS = 100_000;
    const MAX_WARNINGS = 50;
    const sampleRows: CellValue[][] = [];
    let headers: string[] | null = null;
    let detectedDelimiter = ',';
    let parseError: string | null = null;
    let parseWarnings: Array<{ row: number; line?: number; message: string }> = [];
    let pendingBatch: CellValue[][] = [];
    let schemaSent = false;
    let totalRowsSent = 0;
    let rowsAccepted = 0;
    let lastCursor = 0;

    const flushBatch = (final: boolean): void => {
      if (!schemaSent && (sampleRows.length >= TYPE_SAMPLE_ROWS || final) && headers) {
        const schema = inferSchema(headers, sampleRows);
        panel.webview.postMessage({
          type: '__RAW_CSV_BATCH__',
          payload: { schema, delimiter: detectedDelimiter, rows: [], done: false, kind: 'init' },
        });
        // Sample rows themselves go out as the first data batch.
        if (sampleRows.length > 0) {
          panel.webview.postMessage({
            type: '__RAW_CSV_BATCH__',
            payload: { rows: sampleRows, done: false, kind: 'rows', bytesRead: lastCursor },
          });
          totalRowsSent += sampleRows.length;
        }
        schemaSent = true;
      }
      if (!schemaSent) return; // still buffering sample
      if (pendingBatch.length > 0) {
        panel.webview.postMessage({
          type: '__RAW_CSV_BATCH__',
          payload: { rows: pendingBatch, done: false, kind: 'rows', bytesRead: lastCursor },
        });
        totalRowsSent += pendingBatch.length;
        pendingBatch = [];
      }
      if (final) {
        panel.webview.postMessage({
          type: '__RAW_CSV_BATCH__',
          payload: {
            rows: [],
            done: true,
            kind: 'done',
            totalRows: totalRowsSent,
            previewOnly: rowLimit !== undefined,
            parseWarnings: parseWarnings.length > 0 ? parseWarnings : undefined,
          },
        });
      }
    };

    await new Promise<void>((resolve) => {
      let cancelled = false;
      const cancelSub = panel.webview.onDidReceiveMessage((m) => {
        if (m.type === 'LARGE_FILE_STREAM_CANCEL') cancelled = true;
      });

      const stream = fs.createReadStream(uri.fsPath, { encoding: 'utf8' });
      Papa.parse<string[]>(stream as unknown as NodeJS.ReadableStream, {
        delimiter: '',
        skipEmptyLines: true,
        header: false,
        step: (results, parser) => {
          if (cancelled) { parser.abort(); return; }
          if (results.meta?.delimiter) detectedDelimiter = results.meta.delimiter;
          if (typeof results.meta?.cursor === 'number') lastCursor = results.meta.cursor;
          if (results.errors && results.errors.length > 0 && parseWarnings.length < MAX_WARNINGS) {
            for (const e of results.errors) {
              if (parseWarnings.length >= MAX_WARNINGS) break;
              parseWarnings.push({
                row: totalRowsSent + rowsAccepted,
                line: typeof e.row === 'number' ? e.row : undefined,
                message: e.message,
              });
            }
          }
          const row = results.data as unknown as string[];
          if (!Array.isArray(row)) return;
          if (!headers) {
            headers = row;
            return;
          }
          const coerced = row.map(coerceCell);
          if (sampleRows.length < TYPE_SAMPLE_ROWS && !schemaSent) {
            sampleRows.push(coerced);
            rowsAccepted += 1;
            if (sampleRows.length >= TYPE_SAMPLE_ROWS) flushBatch(false);
            if (rowLimit !== undefined && rowsAccepted >= rowLimit) {
              flushBatch(false);
              cancelled = true;
              parser.abort();
            }
            return;
          }
          pendingBatch.push(coerced);
          rowsAccepted += 1;
          if (pendingBatch.length >= BATCH_ROWS) flushBatch(false);
          if (rowLimit !== undefined && rowsAccepted >= rowLimit) {
            flushBatch(false);
            cancelled = true;
            parser.abort();
          }
        },
        complete: () => { cancelSub.dispose(); resolve(); },
        error: (err: Error) => { cancelSub.dispose(); parseError = String(err); resolve(); },
      });
    });

    if (parseError && totalRowsSent === 0 && sampleRows.length === 0) {
      send({ type: 'ERROR', payload: { code: 'PARSE_ERROR', message: parseError } });
      return;
    }
    if (!headers) {
      send({ type: 'ERROR', payload: { code: 'PARSE_ERROR', message: 'CSV file is empty' } });
      return;
    }
    flushBatch(true);
  }

  // ── SQLite: read host-side, send rows as JSON ─────────────────────────────

  private async _sendSqliteData(
    document: DocumentModel,
    panel: vscode.WebviewPanel,
    fileName: string,
    totalBytes: number,
    parquetWasmB64: string,
    duckWorkerUrl: string,
    duckdbBundleExtra?: { duckdbWasmUrl: string; duckdbWorkerUrl: string },
  ): Promise<void> {
    const send = (m: HostMessage) => panel.webview.postMessage(m);

    // sql.js is a WASM-based SQLite that runs in Node — no native bindings needed.
    // The WASM file is copied to dist/ at build time so it's available in the
    // installed extension (node_modules is excluded from the .vsix).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const initSqlJs = require('sql.js') as typeof import('sql.js');
    const wasmUri = vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'sql-wasm.wasm');
    const wasmPath = wasmUri.fsPath;
    const SQL = await initSqlJs({ locateFile: () => wasmPath });

    const fileBytes = await GridEditorProvider._fileReader.readAll(document.uri);
    const db = new SQL.Database(fileBytes);

    // List all tables and views
    const tableRes = db.exec(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`);
    const tables: string[] = tableRes[0]?.values.map(r => String(r[0])) ?? [];

    if (tables.length === 0) {
      send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: 'SQLite file contains no tables.' } });
      db.close();
      return;
    }

    // If multiple tables, show a quick-pick. For now use the first table.
    // Future: could send each table as a separate sheet.
    let tableName = tables[0];
    if (tables.length > 1) {
      const picked = await vscode.window.showQuickPick(tables, {
        placeHolder: 'Select table to open',
        title: `${fileName} — ${tables.length} tables found`,
      });
      if (!picked) { db.close(); return; }
      tableName = picked;
    }

    const res = db.exec(`SELECT * FROM "${tableName.replace(/"/g, '""')}"`);
    db.close();

    if (!res[0]) {
      send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: `Table "${tableName}" is empty.` } });
      return;
    }

    const colNames: string[] = res[0].columns;
    const rawRows: unknown[][] = res[0].values;

    // Infer schema from first 1000 rows
    const schema: ColumnSchema[] = colNames.map((name, index) => {
      let inferredType: InferredType = 'string';
      for (let i = 0; i < Math.min(rawRows.length, 1000); i++) {
        const v = rawRows[i][index];
        if (v === null || v === undefined) continue;
        if (typeof v === 'number') { inferredType = 'number'; break; }
        if (typeof v === 'boolean') { inferredType = 'boolean'; break; }
        if (typeof v === 'string') {
          if (/^\d{4}-\d{2}-\d{2}/.test(v)) { inferredType = 'date'; break; }
          inferredType = 'string'; break;
        }
      }
      return { name, index, inferredType, nullable: true };
    });

    const rows: CellValue[][] = rawRows.map(r =>
      r.map(v => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
        return String(v);
      })
    );

    const duckBundles = { parquetWasmB64, ...duckdbBundleExtra };

    send({
      type: 'INIT',
      payload: {
        fileType: 'sqlite',
        fileName: `${fileName} — ${tableName}`,
        totalRows: rows.length,
        totalBytes,
        schema,
        firstChunk: { rows: [], startRow: 0, endRow: 0 },
        sidecar: document.sidecar,
        duckWorkerUrl,
      },
    });

    panel.webview.postMessage({
      type: '__RAW_ROWS__',
      payload: { schema, rows, duckBundles },
    });
  }

  // ── ORC: decode host-side via Python + pyorc, send rows as JSON ──────────

  private async _sendOrcData(
    document: DocumentModel,
    panel: vscode.WebviewPanel,
    fileName: string,
    totalBytes: number,
    parquetWasmB64: string,
    duckWorkerUrl: string,
    duckdbBundleExtra?: { duckdbWasmUrl: string; duckdbWorkerUrl: string },
  ): Promise<void> {
    const send = (m: HostMessage) => panel.webview.postMessage(m);
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const filePath = document.uri.fsPath;

    // Pass the file path as argv[1] rather than interpolating it into the script
    // string — avoids command injection via crafted file paths with newlines or
    // quote characters. The script receives the path as a plain argument.
    const pyScript = [
      'import sys, json, pyorc',
      'reader = pyorc.Reader(open(sys.argv[1], "rb"))',
      'schema = reader.schema',
      'fields = list(schema.fields.keys())',
      'print(json.dumps(fields))',
      'for row in reader:',
      '    obj = dict(zip(fields, row))',
      '    for k, v in obj.items():',
      '        if not isinstance(v, (int, float, bool, str, type(None))):',
      '            obj[k] = str(v)',
      '    sys.stdout.write(json.dumps(obj) + "\\n")',
    ].join('\n');

    let stdout: string;
    try {
      const result = await execFileAsync('python3', ['-c', pyScript, filePath], { maxBuffer: 200 * 1024 * 1024 });
      stdout = result.stdout;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = msg.includes('pyorc') || msg.includes('ModuleNotFound')
        ? ' — install pyorc with: pip3 install pyorc'
        : msg.includes('python3') || msg.includes('ENOENT')
        ? ' — python3 is required to read ORC files'
        : '';
      send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: `ORC read failed${hint}: ${msg}` } });
      return;
    }

    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: 'ORC file is empty or could not be parsed.' } });
      return;
    }

    let colNames: string[];
    let rawRows: Record<string, unknown>[];
    try {
      const parsed = JSON.parse(lines[0]) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(v => typeof v === 'string')) {
        throw new Error('ORC header is not a string array');
      }
      colNames = parsed as string[];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: `ORC header parse failed: ${msg}` } });
      return;
    }
    try {
      rawRows = lines.slice(1).map((l, i) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`ORC row ${i + 1} parse failed: ${msg}`);
        }
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: msg } });
      return;
    }

    const schema: ColumnSchema[] = colNames.map((name, index) => {
      let inferredType: InferredType = 'string';
      for (let i = 0; i < Math.min(rawRows.length, 1000); i++) {
        const v = rawRows[i][name];
        if (v === null || v === undefined) continue;
        if (typeof v === 'number') { inferredType = 'number'; break; }
        if (typeof v === 'boolean') { inferredType = 'boolean'; break; }
        if (typeof v === 'string') {
          if (/^\d{4}-\d{2}-\d{2}/.test(v)) { inferredType = 'date'; break; }
          inferredType = 'string'; break;
        }
      }
      return { name, index, inferredType, nullable: true };
    });

    const rows: CellValue[][] = rawRows.map(r =>
      colNames.map(name => {
        const v = r[name];
        if (v === null || v === undefined) return null;
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
        return String(v);
      })
    );

    const duckBundles = { parquetWasmB64, ...duckdbBundleExtra };

    send({
      type: 'INIT',
      payload: {
        fileType: 'orc',
        fileName,
        totalRows: rows.length,
        totalBytes,
        schema,
        firstChunk: { rows: [], startRow: 0, endRow: 0 },
        sidecar: document.sidecar,
        duckWorkerUrl,
      },
    });

    panel.webview.postMessage({
      type: '__RAW_ROWS__',
      payload: { schema, rows, duckBundles },
    });
  }

  // ── Avro: read host-side via avsc, send rows as JSON ─────────────────────

  private async _sendAvroData(
    document: DocumentModel,
    panel: vscode.WebviewPanel,
    fileName: string,
    totalBytes: number,
    parquetWasmB64: string,
    duckWorkerUrl: string,
    duckdbBundleExtra?: { duckdbWasmUrl: string; duckdbWorkerUrl: string },
  ): Promise<void> {
    const send = (m: HostMessage) => panel.webview.postMessage(m);

    // avsc requires a file path, so write bytes to a temp file and clean up after.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const avsc = require('avsc') as typeof import('avsc');
    const os = await import('os');
    const fs = await import('fs');
    const tmp = path.join(os.tmpdir(), `gm_avro_${Date.now()}.avro`);

    try {
      const fileBytes = await GridEditorProvider._fileReader.readAll(document.uri);
      fs.writeFileSync(tmp, Buffer.from(fileBytes));

      const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const rows: Record<string, unknown>[] = [];
        const decoder = avsc.createFileDecoder(tmp);
        decoder.on('data', (r: Record<string, unknown>) => rows.push(r));
        decoder.on('end', () => resolve(rows));
        decoder.on('error', reject);
      });

      if (records.length === 0) {
        send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: 'Avro file contains no records.' } });
        return;
      }

      const colNames = Object.keys(records[0]);
      const schema: ColumnSchema[] = colNames.map((name, index) => {
        let inferredType: InferredType = 'string';
        for (let i = 0; i < Math.min(records.length, 1000); i++) {
          const v = records[i][name];
          if (v === null || v === undefined) continue;
          if (typeof v === 'number') { inferredType = 'number'; break; }
          if (typeof v === 'boolean') { inferredType = 'boolean'; break; }
          if (typeof v === 'string') {
            if (/^\d{4}-\d{2}-\d{2}/.test(v)) { inferredType = 'date'; break; }
            inferredType = 'string'; break;
          }
        }
        return { name, index, inferredType, nullable: true };
      });

      const rows: CellValue[][] = records.map(r =>
        colNames.map(name => {
          const v = r[name];
          if (v === null || v === undefined) return null;
          if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
          return String(v);
        })
      );

      const duckBundles = { parquetWasmB64, ...duckdbBundleExtra };

      send({
        type: 'INIT',
        payload: {
          fileType: 'avro',
          fileName,
          totalRows: rows.length,
          totalBytes,
          schema,
          firstChunk: { rows: [], startRow: 0, endRow: 0 },
          sidecar: document.sidecar,
          duckWorkerUrl,
        },
      });

      panel.webview.postMessage({
        type: '__RAW_ROWS__',
        payload: { schema, rows, duckBundles },
      });
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  private async _handleExport(
    payload: import('../shared/messages.js').ExportPayload,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const fmt = payload.format === 'tsv' ? 'tsv' : payload.format === 'json' ? 'json' : 'csv';
    const uri = await vscode.window.showSaveDialog({
      filters: { 'Data files': [fmt] },
      defaultUri: vscode.Uri.file(`export.${fmt}`),
    });
    if (!uri) return;

    // Create write stream before telling webview to start — avoids race.
    const writeStream = fs.createWriteStream(uri.fsPath, { encoding: 'utf8' });
    this._exportStreams.set(panel.webview, {
      stream: writeStream,
      fsPath: uri.fsPath,
      cancelled: false,
      format: fmt as 'csv' | 'tsv' | 'json',
      jsonStarted: false,
    });

    panel.webview.postMessage({
      type: 'EXPORT_START',
      payload: { fsPath: uri.fsPath, format: fmt as 'csv' | 'tsv' | 'json' },
    });
  }

  private async _handleExportBatch(
    payload: import('../shared/messages.js').ExportDataBatchPayload,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const state = this._exportStreams.get(panel.webview);
    if (!state || state.cancelled) return;

    const { stream, format } = state;
    const { rows, headers, batchIndex, totalBatches, done } = payload;

    await new Promise<void>((resolve, reject) => {
      let chunk = '';
      if (format === 'json') {
        if (!state.jsonStarted) {
          chunk += '[';
          state.jsonStarted = true;
        }
        const jsonRows = rows.map(row => {
          const obj: Record<string, import('../shared/schema.js').CellValue> = {};
          (headers ?? []).forEach((h, i) => { obj[h] = row[i] ?? null; });
          return JSON.stringify(obj);
        });
        chunk += jsonRows.join(',\n');
        if (done) chunk += ']';
      } else {
        // CSV/TSV — first batch includes headers
        if (batchIndex === 0 && headers) {
          const del = format === 'tsv' ? '\t' : ',';
          chunk += headers.map(h => _csvEscape(h, del)).join(del) + '\n';
        }
        const del = format === 'tsv' ? '\t' : ',';
        chunk += rows.map(row =>
          row.map(v => {
            if (v === null || v === undefined) return '';
            return _csvEscape(typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v), del);
          }).join(del)
        ).join('\n');
        if (rows.length > 0) chunk += '\n';
      }

      stream.write(chunk, (err) => err ? reject(err) : resolve());
    });

    const pct = Math.round(((batchIndex + 1) / totalBatches) * 100);
    panel.webview.postMessage({ type: 'EXPORT_PROGRESS', payload: { pct } });

    if (done) {
      await new Promise<void>((resolve) => stream.end(resolve));
      this._exportStreams.delete(panel.webview);
      panel.webview.postMessage({
        type: 'EXPORT_DONE',
        payload: { success: true, path: state.fsPath },
      });
    }
  }

  private _cancelExport(panel: vscode.WebviewPanel): void {
    const state = this._exportStreams.get(panel.webview);
    if (!state) return;
    state.cancelled = true;
    state.stream.destroy();
    try { fs.unlinkSync(state.fsPath); } catch { /* ignore */ }
    this._exportStreams.delete(panel.webview);
  }

  // ── Webview HTML ──────────────────────────────────────────────────────────

  private _getHtml(webview: vscode.Webview): string {
    const nonce = this._nonce();
    // Cache-buster ensures VS Code's webview cache always re-fetches the bundle
    // when the extension reloads. Without this, an old main.js can persist
    // across uninstalls/reinstalls of the same version.
    const cb = Date.now();
    const distUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'dist', file),
      ).toString() + `?v=${cb}`;

    const duckWorkerUri = distUri('duckdb.worker.js');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' ${webview.cspSource};
             style-src 'unsafe-inline' ${webview.cspSource};
             img-src ${webview.cspSource} data:;
             font-src ${webview.cspSource};
             worker-src ${webview.cspSource} blob:;
             connect-src ${webview.cspSource} blob: data:;" />
  <title>Grid Master</title>
  <link rel="stylesheet" href="${distUri('main.css')}" />
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    window.__DUCK_WORKER_URL__ = "${duckWorkerUri}";
    window.__GM_BUILD__ = "${cb}";
    console.log("[GridMaster] HTML loaded, build=", "${cb}");
  </script>
  <script type="module" nonce="${nonce}" src="${distUri('main.js')}"></script>
</body>
</html>`;
  }

  private _nonce(): string {
    return require('crypto').randomBytes(16).toString('base64url') as string;
  }

  // V8 limits any single string to ~512 MB (0x1fffffe8 chars). A 1 GB file
  // base64-encoded in one shot exceeds that, so split the source bytes into
  // 48 MB raw slices (~64 MB base64 each). The webview concatenates the
  // decoded chunks back into one ArrayBuffer before handing it to the worker.
  private static readonly _BASE64_CHUNK_BYTES = 48 * 1024 * 1024;

  private static _encodeBase64Chunked(bytes: Uint8Array): string[] {
    const step = GridEditorProvider._BASE64_CHUNK_BYTES;
    if (bytes.byteLength <= step) {
      return [Buffer.from(bytes).toString('base64')];
    }
    const parts: string[] = [];
    for (let off = 0; off < bytes.byteLength; off += step) {
      const end = Math.min(off + step, bytes.byteLength);
      const slice = bytes.subarray(off, end);
      parts.push(Buffer.from(slice).toString('base64'));
    }
    return parts;
  }
}

// ── CSV cell coercion + schema inference (host-side mirror of webview logic) ─

function coerceCell(raw: string): CellValue {
  if (raw === '' || raw === 'null' || raw === 'NULL' || raw === 'NA' || raw === 'N/A') return null;
  const n = Number(raw);
  if (!isNaN(n) && raw.trim() !== '') return n;
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return raw;
}

function isDateLike(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(s);
}

function inferTypeFromSamples(samples: CellValue[]): InferredType {
  const nonNull = samples.filter(v => v !== null);
  if (nonNull.length === 0) return 'null';
  if (nonNull.every(v => typeof v === 'number')) return 'number';
  if (nonNull.every(v => typeof v === 'boolean')) return 'boolean';
  if (nonNull.every(v => typeof v === 'string' && isDateLike(v as string))) return 'date';
  return 'string';
}

function inferSchema(headers: string[], sampleRows: CellValue[][]): ColumnSchema[] {
  return headers.map((name, index) => {
    const samples = sampleRows.map(row => row[index] ?? null);
    const nullCount = samples.filter(v => v === null).length;
    return { name, index, inferredType: inferTypeFromSamples(samples), nullable: nullCount > 0 };
  });
}

function _csvEscape(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
