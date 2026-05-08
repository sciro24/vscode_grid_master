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
};

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    GridEditorProvider.register(context, VIEW_TYPES.CSV),
    GridEditorProvider.register(context, VIEW_TYPES.PARQUET),
    GridEditorProvider.register(context, VIEW_TYPES.ARROW),
    GridEditorProvider.register(context, VIEW_TYPES.JSON),
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
        ext === 'parquet' || ext === 'parq' ? VIEW_TYPES.PARQUET :
        ext === 'arrow'   || ext === 'feather' ? VIEW_TYPES.ARROW :
        ext === 'json'    || ext === 'jsonl' || ext === 'ndjson' ? VIEW_TYPES.JSON :
        VIEW_TYPES.CSV;
      await vscode.commands.executeCommand('vscode.openWith', target, viewType);
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
