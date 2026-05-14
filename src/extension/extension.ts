import * as vscode from 'vscode';
import { GridEditorProvider } from './GridEditorProvider.js';
import { VIEW_TYPES } from '../shared/constants.js';

const FILE_ASSOCIATIONS: Record<string, string> = {
  '*.csv':     VIEW_TYPES.CSV,
  '*.tsv':     VIEW_TYPES.CSV,
  '*.parquet': VIEW_TYPES.PARQUET,
  '*.parq':    VIEW_TYPES.PARQUET,
  '*.arrow':   VIEW_TYPES.ARROW,
  '*.feather': VIEW_TYPES.ARROW,
  '*.jsonl':   VIEW_TYPES.JSON,
  '*.ndjson':  VIEW_TYPES.JSON,
  '*.json':    VIEW_TYPES.JSON_ARRAY,
  '*.xlsx':    VIEW_TYPES.EXCEL,
  '*.xlsb':    VIEW_TYPES.EXCEL,
  '*.xls':     VIEW_TYPES.EXCEL,
  '*.xlsm':    VIEW_TYPES.EXCEL,
  '*.avro':    VIEW_TYPES.AVRO,
  '*.db':      VIEW_TYPES.SQLITE,
  '*.sqlite':  VIEW_TYPES.SQLITE,
  '*.sqlite3': VIEW_TYPES.SQLITE,
  '*.orc':     VIEW_TYPES.ORC,
};

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    GridEditorProvider.register(context, VIEW_TYPES.CSV),
    GridEditorProvider.register(context, VIEW_TYPES.PARQUET),
    GridEditorProvider.register(context, VIEW_TYPES.ARROW),
    GridEditorProvider.register(context, VIEW_TYPES.JSON),
    GridEditorProvider.register(context, VIEW_TYPES.JSON_ARRAY),
    GridEditorProvider.register(context, VIEW_TYPES.EXCEL),
    GridEditorProvider.register(context, VIEW_TYPES.AVRO),
    GridEditorProvider.register(context, VIEW_TYPES.SQLITE),
    GridEditorProvider.register(context, VIEW_TYPES.ORC),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gridMaster.openAsText', async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (tab?.input instanceof vscode.TabInputCustom) {
        await vscode.commands.executeCommand('vscode.openWith', tab.input.uri, 'default');
      }
    }),

    vscode.commands.registerCommand('gridMaster.setAsDefaultEditor', async () => {
      await setAsDefault();
    }),

    vscode.commands.registerCommand('gridMaster.openWith', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      const ext = target.path.split('.').pop()?.toLowerCase() ?? '';
      const viewType =
        ext === 'parquet' || ext === 'parq'               ? VIEW_TYPES.PARQUET :
        ext === 'arrow'   || ext === 'feather'             ? VIEW_TYPES.ARROW :
        ext === 'json'                                     ? VIEW_TYPES.JSON_ARRAY :
        ext === 'jsonl' || ext === 'ndjson'                ? VIEW_TYPES.JSON :
        ext === 'xlsx'    || ext === 'xlsb' || ext === 'xls' || ext === 'xlsm' || ext === 'ods' ? VIEW_TYPES.EXCEL :
        ext === 'avro'                                     ? VIEW_TYPES.AVRO :
        ext === 'db'      || ext === 'sqlite' || ext === 'sqlite3' ? VIEW_TYPES.SQLITE :
        ext === 'orc'                                      ? VIEW_TYPES.ORC :
        VIEW_TYPES.CSV;
      await vscode.commands.executeCommand('vscode.openWith', target, viewType);
    }),

    // Dedicated command for opening partitioned dataset directories.
    // vscode.openWith does not work reliably on directory URIs, so we always
    // resolve to the directory and pass the matching custom-editor view type.
    vscode.commands.registerCommand('gridMaster.openDirectory', async (uri?: vscode.Uri) => {
      const target = uri;
      if (!target) return;
      const ext = target.path.split('.').pop()?.toLowerCase() ?? '';
      const viewType =
        ext === 'parquet' || ext === 'parq' ? VIEW_TYPES.PARQUET :
        ext === 'arrow'                     ? VIEW_TYPES.ARROW :
        VIEW_TYPES.PARQUET;
      await vscode.commands.executeCommand('vscode.openWith', target, viewType);
    }),

    // Palette fallback: open a partitioned-dataset folder via picker.
    // Useful when the directory name doesn't end in .parquet (rare) or when
    // the explorer context menu isn't available.
    vscode.commands.registerCommand('gridMaster.openPartitionedFolder', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Open as Grid Master dataset',
        title: 'Select a partitioned Parquet/Arrow dataset folder',
      });
      if (!picked || picked.length === 0) return;
      const folder = picked[0];
      const ext = folder.path.split('.').pop()?.toLowerCase() ?? '';
      const viewType =
        ext === 'arrow'   ? VIEW_TYPES.ARROW :
        VIEW_TYPES.PARQUET;
      await vscode.commands.executeCommand('vscode.openWith', folder, viewType);
    }),
  );

  // Detect when the user opens a part-file (e.g. part-00000-*.snappy.parquet)
  // that lives inside a *.parquet/*.parq/*.arrow directory and offer to open
  // the parent directory as a single merged dataset instead.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (!editor) return;
      await maybeOfferPartitionedOpen(editor.document.uri);
    }),
    vscode.window.tabGroups.onDidChangeTabs(async e => {
      for (const tab of e.opened) {
        const input = tab.input;
        if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
          await maybeOfferPartitionedOpen(input.uri);
        }
      }
    }),
  );

  // Show one-time prompt to set Grid Master as the default editor.
  // We use onDidChangeActiveTextEditor because custom editors don't fire
  // onDidOpenTextDocument. When a CSV is opened as text (before Grid Master
  // is the default), we catch it here.
  const PROMPT_KEY = 'gridMaster.promptedDefault';
  if (!context.globalState.get<boolean>(PROMPT_KEY, false)) {
    const listener = vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (!editor) return;
      const ext = editor.document.uri.path.split('.').pop()?.toLowerCase() ?? '';
      if (!['csv', 'tsv', 'parquet', 'parq', 'arrow', 'feather', 'jsonl', 'ndjson'].includes(ext)) return;

      listener.dispose();
      await context.globalState.update(PROMPT_KEY, true);

      const answer = await vscode.window.showInformationMessage(
        'Grid Master can open CSV, Parquet and Arrow files as a visual grid. Set it as the default editor?',
        'Yes, set as default',
        'Not now',
      );
      if (answer === 'Yes, set as default') {
        await setAsDefault();
        await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, VIEW_TYPES.CSV);
      }
    });
    context.subscriptions.push(listener);
  }
}

// Per-session memo of folders we've already prompted about — avoids spamming
// the user when they click multiple part-files inside the same directory.
const promptedFolders = new Set<string>();

async function maybeOfferPartitionedOpen(uri: vscode.Uri): Promise<void> {
  if (uri.scheme !== 'file') return;
  const lowerPath = uri.path.toLowerCase();
  // Match part files: anything with `.parquet` somewhere (covers .snappy.parquet,
  // .zstd.parquet, .parquet) and *.arrow / *.feather.
  const isPartFile =
    lowerPath.includes('.parquet') ||
    lowerPath.endsWith('.arrow') ||
    lowerPath.endsWith('.feather');
  if (!isPartFile) return;

  const parent = vscode.Uri.joinPath(uri, '..');
  const parentLower = parent.path.toLowerCase();
  const isPartitionedDir =
    parentLower.endsWith('.parquet') ||
    parentLower.endsWith('.parq') ||
    parentLower.endsWith('.arrow');
  if (!isPartitionedDir) return;

  if (promptedFolders.has(parent.toString())) return;
  promptedFolders.add(parent.toString());

  const folderName = parent.path.split('/').pop() ?? 'this folder';
  const choice = await vscode.window.showInformationMessage(
    `“${folderName}” looks like a partitioned dataset. Open the whole folder as one table in Grid Master?`,
    'Open folder in Grid Master',
    'Just this file',
  );
  if (choice === 'Open folder in Grid Master') {
    const ext = parent.path.split('.').pop()?.toLowerCase() ?? '';
    const viewType =
      ext === 'arrow' ? VIEW_TYPES.ARROW : VIEW_TYPES.PARQUET;
    await vscode.commands.executeCommand('vscode.openWith', parent, viewType);
  }
}

async function setAsDefault(): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const current: Record<string, string> = config.get('workbench.editorAssociations') ?? {};
  const updated = { ...current, ...FILE_ASSOCIATIONS };
  await config.update('workbench.editorAssociations', updated, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    'Grid Master is now the default editor for CSV, TSV, Parquet and Arrow files.',
  );
}

export function deactivate(): void {}
