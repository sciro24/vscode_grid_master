import * as vscode from 'vscode';
import * as path from 'path';
import type { SidecarData } from '../shared/schema.js';

export class FileReaderService {
  async readAll(uri: vscode.Uri): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(uri);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return vscode.workspace.fs.stat(uri);
  }

  async writeFile(uri: vscode.Uri, data: Uint8Array): Promise<void> {
    await vscode.workspace.fs.writeFile(uri, data);
  }

  async readSidecar(uri: vscode.Uri): Promise<SidecarData | null> {
    const sidecarUri = this._sidecarUri(uri);
    try {
      const raw = await vscode.workspace.fs.readFile(sidecarUri);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
      return parseSidecar(parsed);
    } catch {
      return null;
    }
  }

  async writeSidecar(uri: vscode.Uri, sidecar: SidecarData): Promise<void> {
    const sidecarUri = this._sidecarUri(uri);
    const data = new TextEncoder().encode(JSON.stringify(sidecar, null, 2));
    await vscode.workspace.fs.writeFile(sidecarUri, data);
  }

  private _sidecarUri(uri: vscode.Uri): vscode.Uri {
    const dir = path.dirname(uri.fsPath);
    const base = path.basename(uri.fsPath);
    return vscode.Uri.file(path.join(dir, `.${base}.gridmaster.json`));
  }
}

function parseSidecar(raw: unknown): SidecarData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== 1) return null;
  return {
    version: 1,
    columnOverrides: isStringRecord(obj['columnOverrides']) ? obj['columnOverrides'] as Record<string, import('../shared/schema.js').InferredType> : {},
    bookmarks: Array.isArray(obj['bookmarks']) ? obj['bookmarks'] as SidecarData['bookmarks'] : [],
    columnWidths: isNumberRecord(obj['columnWidths']) ? obj['columnWidths'] as Record<string, number> : {},
    hiddenColumns: Array.isArray(obj['hiddenColumns']) ? (obj['hiddenColumns'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    pinnedColumns: isPinnedColumns(obj['pinnedColumns']) ? obj['pinnedColumns'] as SidecarData['pinnedColumns'] : { left: [], right: [] },
    filters: Array.isArray(obj['filters']) ? obj['filters'] as SidecarData['filters'] : undefined,
    colorsActive: typeof obj['colorsActive'] === 'boolean' ? obj['colorsActive'] : undefined,
    sort: isSortEntry(obj['sort']) ? obj['sort'] as SidecarData['sort'] : null,
  };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNumberRecord(v: unknown): v is Record<string, number> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isPinnedColumns(v: unknown): v is { left: string[]; right: string[] } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o['left']) && Array.isArray(o['right']);
}

function isSortEntry(v: unknown): v is { column: string; direction: 'asc' | 'desc' } | null {
  if (v === null || v === undefined) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o['column'] === 'string' && (o['direction'] === 'asc' || o['direction'] === 'desc');
}
