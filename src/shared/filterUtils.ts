import type { CellValue, FilterSpec } from './schema.js';

export function applyFilter(row: CellValue[], f: FilterSpec): boolean {
  const cell = row[f.colIndex];
  const val = f.value;
  switch (f.op) {
    case 'eq':           return cell == val;
    case 'neq':          return cell != val;
    case 'contains':     return String(cell ?? '').toLowerCase().includes(String(val).toLowerCase());
    case 'not_contains': return !String(cell ?? '').toLowerCase().includes(String(val).toLowerCase());
    case 'gt':           return Number(cell) > Number(val);
    case 'lt':           return Number(cell) < Number(val);
    case 'gte':          return Number(cell) >= Number(val);
    case 'lte':          return Number(cell) <= Number(val);
    case 'regex':        try { return new RegExp(String(val), 'i').test(String(cell ?? '')); } catch { return false; }
    case 'is_null':      return cell === null;
    case 'is_not_null':  return cell !== null;
    default:             return true;
  }
}

export function compareValues(a: CellValue, b: CellValue, dir: 'asc' | 'desc'): number {
  const aNum = Number(a);
  const bNum = Number(b);
  let cmp: number;
  if (!isNaN(aNum) && !isNaN(bNum)) {
    cmp = aNum - bNum;
  } else {
    cmp = String(a ?? '').localeCompare(String(b ?? ''));
  }
  return dir === 'asc' ? cmp : -cmp;
}
