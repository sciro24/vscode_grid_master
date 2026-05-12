import { describe, expect, it } from 'vitest';
import type { FilterSpec, SortSpec } from '@shared/schema.js';
import { buildViewIndex, hasViewTransform, mapVisibleRow } from './csvView.js';

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
