import * as vscode from 'vscode';
import type { CellValue, SidecarData } from '../shared/schema.js';

export interface Edit {
  id: string;
  row: number;
  col: number;
  oldValue: CellValue;
  newValue: CellValue;
}

export interface BatchEdit {
  id: string;
  edits: Omit<Edit, 'id'>[];
}

export class DocumentModel {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DocumentModel>>();
  readonly onDidChange = this._onDidChange.event;

  // In-memory patch layer: row→col→value overrides over the file on disk
  private _patches = new Map<number, Map<number, CellValue>>();

  sidecar: SidecarData = {
    version: 1,
    columnOverrides: {},
    bookmarks: [],
    columnWidths: {},
    hiddenColumns: [],
    pinnedColumns: { left: [], right: [] },
  };

  constructor(
    public readonly uri: vscode.Uri,
    public readonly fileType: 'csv' | 'parquet' | 'arrow' | 'json' | 'excel' | 'avro' | 'sqlite' | 'orc',
  ) {}

  applyEdit(edit: Edit): void {
    this._applyPatch(edit.row, edit.col, edit.newValue);
    this._onDidChange.fire({
      document: this,
      undo: () => this._unapplyEdit(edit),
      redo: () => this._applyEdit(edit),
    });
  }

  applyBatchEdit(batch: BatchEdit): void {
    for (const e of batch.edits) {
      this._applyPatch(e.row, e.col, e.newValue);
    }
    this._onDidChange.fire({
      document: this,
      undo: () => {
        for (const e of batch.edits) {
          this._applyPatch(e.row, e.col, e.oldValue);
        }
      },
      redo: () => {
        for (const e of batch.edits) {
          this._applyPatch(e.row, e.col, e.newValue);
        }
      },
    });
  }

  getPatch(row: number, col: number): CellValue | undefined {
    return this._patches.get(row)?.get(col);
  }

  get isDirty(): boolean {
    return this._patches.size > 0;
  }

  get patches(): ReadonlyMap<number, ReadonlyMap<number, CellValue>> {
    return this._patches;
  }

  clearPatches(): void {
    this._patches.clear();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private _applyPatch(row: number, col: number, value: CellValue): void {
    if (!this._patches.has(row)) {
      this._patches.set(row, new Map());
    }
    this._patches.get(row)!.set(col, value);
  }

  private _applyEdit(edit: Edit): void {
    this._applyPatch(edit.row, edit.col, edit.newValue);
  }

  private _unapplyEdit(edit: Edit): void {
    this._applyPatch(edit.row, edit.col, edit.oldValue);
  }
}
