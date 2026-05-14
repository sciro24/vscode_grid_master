import type { CellValue, FilterSpec } from './schema.js';

const REGEX_MAX_LEN = 500;
const REGEX_MAX_QUANTIFIERS = 20;

/** Returns null if pattern is safe, or an error string if it should be rejected. */
export function validateRegexFilter(pattern: string): string | null {
  if (pattern.length > REGEX_MAX_LEN) {
    return `Regex too long (${pattern.length} chars, max ${REGEX_MAX_LEN})`;
  }
  const quantifierCount = (pattern.match(/[*+{]/g) ?? []).length;
  if (quantifierCount > REGEX_MAX_QUANTIFIERS) {
    return `Regex too complex (${quantifierCount} quantifiers, max ${REGEX_MAX_QUANTIFIERS})`;
  }
  try {
    new RegExp(pattern, 'i');
  } catch (e) {
    return `Invalid regex: ${(e as Error).message}`;
  }
  return null;
}

export function applyFilter(row: CellValue[], f: FilterSpec): boolean {
  const cell = row[f.colIndex];
  const val = f.value;
  switch (f.op) {
    case 'eq':           return cell === val;
    case 'neq':          return cell !== val;
    case 'contains':     return String(cell ?? '').toLowerCase().includes(String(val).toLowerCase());
    case 'not_contains': return !String(cell ?? '').toLowerCase().includes(String(val).toLowerCase());
    case 'gt':           return Number(cell) > Number(val);
    case 'lt':           return Number(cell) < Number(val);
    case 'gte':          return Number(cell) >= Number(val);
    case 'lte':          return Number(cell) <= Number(val);
    case 'regex': {
      const pattern = String(val);
      // Length guard: fall back to contains to avoid compiling huge patterns
      if (pattern.length > REGEX_MAX_LEN) {
        return String(cell ?? '').toLowerCase().includes(pattern.toLowerCase());
      }
      // Complexity guard: reject catastrophic-backtracking patterns
      const quantifierCount = (pattern.match(/[*+{]/g) ?? []).length;
      if (quantifierCount > REGEX_MAX_QUANTIFIERS) {
        return false;
      }
      try { return new RegExp(pattern, 'i').test(String(cell ?? '')); } catch { return false; }
    }
    case 'is_null':      return cell === null;
    case 'is_not_null':  return cell !== null;
    default:             return true;
  }
}

export function compareValues(a: CellValue, b: CellValue, dir: 'asc' | 'desc'): number {
  // Nulls always sort to the end regardless of direction.
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

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
