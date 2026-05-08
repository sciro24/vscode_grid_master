import * as vscode from 'vscode';
import * as path from 'path';
import { DocumentModel } from './DocumentModel.js';
import { FileReaderService } from './FileReaderService.js';
import { detectFileType } from './utils/fileTypeDetector.js';
import type { HostMessage, WebviewMessage } from '../shared/messages.js';

export class GridEditorProvider implements vscode.CustomEditorProvider<DocumentModel> {
  private static readonly _fileReader = new FileReaderService();

  // Required by CustomEditorProvider — delegates to DocumentModel's own emitter
  readonly onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<DocumentModel>
  >().event;

  static register(context: vscode.ExtensionContext, viewType: string): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      viewType,
      new GridEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    );
  }

  constructor(private readonly _context: vscode.ExtensionContext) {}

  // ── CustomEditorProvider ──────────────────────────────────────────────────

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<DocumentModel> {
    const detectedType = detectFileType(uri);
    // Normalise to the four types DocumentModel understands
    const fileType: 'csv' | 'parquet' | 'arrow' | 'json' =
      detectedType === 'parquet' || detectedType === 'parq' ? 'parquet' :
      detectedType === 'arrow'   || detectedType === 'feather' ? 'arrow' :
      detectedType === 'json'    || detectedType === 'jsonl' || detectedType === 'ndjson' ? 'json' :
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

      case 'SAVE':
        await this._saveDocument(document, new vscode.CancellationTokenSource().token);
        send({ type: 'SAVE_ACK', payload: { success: true } });
        break;

      case 'UNDO':
        await vscode.commands.executeCommand('undo');
        break;

      case 'REDO':
        await vscode.commands.executeCommand('redo');
        break;

      case 'SAVE_SIDECAR':
        await GridEditorProvider._fileReader.writeSidecar(document.uri, msg.payload.sidecar);
        document.sidecar = msg.payload.sidecar;
        break;

      case 'EXPORT':
        await this._handleExport(msg.payload, panel);
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
        eh: { mainWorkerB64: '', mainModuleB64: '' },
        extensions: { parquetB64: '', jsonB64: '' },
        parquetWasmB64,
      };

      if (document.fileType === 'csv') {
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
        return;
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

        const base64 = Buffer.from(bytes).toString('base64');
        panel.webview.postMessage({
          type: '__RAW_BINARY__',
          payload: { base64, fileType: 'json', jsonFormat: isNdjson ? 'ndjson' : 'json', duckBundles },
        });
        return;
      } else {
        // Check if URI is a partitioned parquet directory (e.g. Spark output).
        // A directory named *.parquet contains part-*.parquet files inside it.
        const isPartitionedDir = await (async () => {
          try {
            const stat = await vscode.workspace.fs.stat(document.uri);
            return stat.type === vscode.FileType.Directory;
          } catch {
            return false;
          }
        })();

        let partFiles: Uint8Array[] = [];

        if (isPartitionedDir) {
          send({ type: 'LOADING', payload: { active: true, message: 'Reading partitioned dataset...' } });
          const entries = await vscode.workspace.fs.readDirectory(document.uri);
          const partNames = entries
            .filter(([name, type]) =>
              type === vscode.FileType.File &&
              /^part-.*\.parquet$/i.test(name),
            )
            .map(([name]) => name)
            .sort();

          if (partNames.length === 0) {
            send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: 'No part-*.parquet files found in directory.' } });
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
          const base64 = Buffer.from(partFiles[0]).toString('base64');
          panel.webview.postMessage({
            type: '__RAW_BINARY__',
            payload: { base64, fileType: document.fileType, duckBundles },
          });
        } else {
          const parts = partFiles.map(b => Buffer.from(b).toString('base64'));
          panel.webview.postMessage({
            type: '__RAW_BINARY__',
            payload: { base64Parts: parts, fileType: document.fileType, duckBundles },
          });
        }
      }

      send({ type: 'LOADING', payload: { active: false } });
    } catch (e) {
      send({ type: 'ERROR', payload: { code: 'READ_ERROR', message: String(e) } });
    }
  }

  private async _saveDocument(
    document: DocumentModel,
    _cancellation: vscode.CancellationToken,
    destination?: vscode.Uri,
  ): Promise<void> {
    if (!document.isDirty && !destination) return;
    if (document.fileType !== 'csv') {
      // Save for binary/json formats is deferred. For now we just clear the
      // patch list so the editor doesn't loop on dirty-state.
      document.clearPatches();
      return;
    }
    // Patches are applied and serialized by the webview CSV worker.
    // Full write-back implementation is Milestone 4.
    document.clearPatches();
  }

  private async _handleExport(
    payload: import('../shared/messages.js').ExportPayload,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const ext = payload.format === 'tsv' ? 'tsv' : payload.format === 'json' ? 'json' : 'csv';
    const uri = await vscode.window.showSaveDialog({
      filters: { 'Data files': [ext] },
      defaultUri: vscode.Uri.file(`export.${ext}`),
    });
    if (!uri) return;
    panel.webview.postMessage({ type: '__EXPORT_PATH__', payload: { fsPath: uri.fsPath } });
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
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }
}
