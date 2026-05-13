import { describe, expect, it } from 'vitest';
import type { FilterSpec, SortSpec } from '@shared/schema.js';
import { buildViewIndex, hasViewTransform, mapVisibleRow } from './csvView.js';
import { applyFilter } from '@shared/filterUtils.js';

describe('csvView', () => {
  const rows = [
    [1, 'alpha'],
    [2, 'beta'],
    [1, 'bravo'],
  ];

  it('detects when a view transform is needed', () => {
    expect(hasViewTransform([], null, '')).toBe(false);
    expect(hasViewTransform([], null, ' ')).toBe(false);
    expect(hasViewTransform([{ colIndex: 0, op: 'eq', value: 1 }], null, '')).toBe(true);
  });

  it('builds a view index with filters and search', () => {
    const filters: FilterSpec[] = [{ colIndex: 0, op: 'eq', value: 1 }];
    const view = buildViewIndex(rows, filters, null, 'br');
    expect(view).toEqual([2]);
  });

  it('sorts the view index when sort is provided', () => {
    const sort: SortSpec = { colIndex: 1, direction: 'desc' };
    const view = buildViewIndex(rows, [], sort, '');
    expect(view).toEqual([2, 1, 0]);
  });

  it('maps visible rows safely to actual rows', () => {
    expect(mapVisibleRow(0, [], 3)).toBe(0);
    expect(mapVisibleRow(2, [], 3)).toBe(2);
    expect(mapVisibleRow(3, [], 3)).toBe(-1);
    expect(mapVisibleRow(1, [5, 2], 10)).toBe(2);
    expect(mapVisibleRow(2, [5, 2], 10)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// T5: Compressed scroll boundaries
// mapVisibleRow is the public API for compressed virtual scroll. Verifies that
// the last real row is reachable and no off-by-one causes -1 at the boundary.
// ---------------------------------------------------------------------------
describe('T5: compressed scroll boundaries', () => {
  it('identity mapping — first and last rows accessible, one-past returns -1', () => {
    const rowCount = 1_000_000;
    expect(mapVisibleRow(0, [], rowCount)).toBe(0);
    expect(mapVisibleRow(rowCount - 1, [], rowCount)).toBe(rowCount - 1);
    expect(mapVisibleRow(rowCount, [], rowCount)).toBe(-1);
  });

  it('viewToActual mapping — last visible row maps to correct actual row', () => {
    const viewToActual = [0, 5, 999, 1_000_000 - 1];
    const rowCount = 1_000_000;
    expect(mapVisibleRow(0, viewToActual, rowCount)).toBe(0);
    expect(mapVisibleRow(3, viewToActual, rowCount)).toBe(rowCount - 1);
    expect(mapVisibleRow(4, viewToActual, rowCount)).toBe(-1);
  });

  it('negative index → -1', () => {
    expect(mapVisibleRow(-1, [], 100)).toBe(-1);
  });

  it('empty view with 0 rows → -1 for any index', () => {
    expect(mapVisibleRow(0, [], 0)).toBe(-1);
  });

  it('filtered view — last filtered row accessible, one-past returns -1', () => {
    // 10 actual rows, only even indices in view
    const viewToActual = [0, 2, 4, 6, 8];
    expect(mapVisibleRow(4, viewToActual, 10)).toBe(8);
    expect(mapVisibleRow(5, viewToActual, 10)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// T6: Regex filter with >500 char pattern falls back to contains, no throw
// ---------------------------------------------------------------------------
describe('T6: regex filter length guard', () => {
  it('>500 char pattern → falls back to contains, does not throw', () => {
    const longPattern = 'a'.repeat(501);
    const f: FilterSpec = { colIndex: 0, op: 'regex', value: longPattern };

    // Row contains the pattern as a substring — contains fallback should match
    const matchingRow = [longPattern];
    const nonMatchingRow = ['hello world'];

    expect(() => applyFilter(matchingRow, f)).not.toThrow();
    expect(applyFilter(matchingRow, f)).toBe(true);
    expect(applyFilter(nonMatchingRow, f)).toBe(false);
  });

  it('>20 quantifiers pattern → returns false immediately (guard rejects before compile)', () => {
    // Pattern with 22 quantifiers — guard triggers at >20, returns false without compiling
    const evilPattern = '(a+)+'.repeat(11); // 22 × '+' chars
    const f: FilterSpec = { colIndex: 0, op: 'regex', value: evilPattern };
    const row = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaab'];

    expect(() => applyFilter(row, f)).not.toThrow();
    expect(applyFilter(row, f)).toBe(false);
  });

  it('valid regex under limits → matches correctly', () => {
    const f: FilterSpec = { colIndex: 0, op: 'regex', value: '^hello' };
    expect(applyFilter(['hello world'], f)).toBe(true);
    expect(applyFilter(['world hello'], f)).toBe(false);
  });

  it('invalid regex syntax → returns false, does not throw', () => {
    const f: FilterSpec = { colIndex: 0, op: 'regex', value: '[invalid' };
    expect(() => applyFilter(['test'], f)).not.toThrow();
    expect(applyFilter(['test'], f)).toBe(false);
  });
});
