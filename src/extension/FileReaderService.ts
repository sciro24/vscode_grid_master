import * as vscode from 'vscode';
import * as path from 'path';
import { SMALL_FILE_THRESHOLD_BYTES } from '../shared/constants.js';
import type { SidecarData } from '../shared/schema.js';

export class FileReaderService {
  async readBytes(uri: vscode.Uri, start: number, length: number): Promise<Uint8Array> {
    const full = await vscode.workspace.fs.readFile(uri);
    return full.slice(start, start + length);
  }

  async readAll(uri: vscode.Uri): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(uri);
  }

  async readSample(uri: vscode.Uri, bytes = SMALL_FILE_THRESHOLD_BYTES): Promise<Uint8Array> {
    const full = await vscode.workspace.fs.readFile(uri);
    return full.slice(0, bytes);
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
      return JSON.parse(new TextDecoder().decode(raw)) as SidecarData;
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
