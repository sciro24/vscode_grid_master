import { describe, it, expect } from 'vitest';
import { applyFilter, compareValues, validateRegexFilter } from './filterUtils.js';

describe('filterUtils', () => {
  describe('applyFilter', () => {
    it('handles is_null and is_not_null correctly', () => {
      const rowNull = [null, 'value'];
      const rowUndefined = [undefined, 'value'];
      const rowValue = ['hello', 'value'];
      const rowEmpty = ['', 'value'];

      expect(applyFilter(rowNull, { colIndex: 0, op: 'is_null', value: '' })).toBe(true);
      expect(applyFilter(rowUndefined, { colIndex: 0, op: 'is_null', value: '' })).toBe(true);
      expect(applyFilter(rowValue, { colIndex: 0, op: 'is_null', value: '' })).toBe(false);
      expect(applyFilter(rowEmpty, { colIndex: 0, op: 'is_null', value: '' })).toBe(false);

      expect(applyFilter(rowNull, { colIndex: 0, op: 'is_not_null', value: '' })).toBe(false);
      expect(applyFilter(rowUndefined, { colIndex: 0, op: 'is_not_null', value: '' })).toBe(false);
      expect(applyFilter(rowValue, { colIndex: 0, op: 'is_not_null', value: '' })).toBe(true);
      expect(applyFilter(rowEmpty, { colIndex: 0, op: 'is_not_null', value: '' })).toBe(true);
    });

    it('handles numeric comparisons', () => {
      const row = [42, 'value'];
      expect(applyFilter(row, { colIndex: 0, op: 'gt', value: 40 })).toBe(true);
      expect(applyFilter(row, { colIndex: 0, op: 'lt', value: 40 })).toBe(false);
    });

    it('handles string contains', () => {
      const row = ['Hello World', 'value'];
      expect(applyFilter(row, { colIndex: 0, op: 'contains', value: 'world' })).toBe(true);
      expect(applyFilter(row, { colIndex: 0, op: 'not_contains', value: 'world' })).toBe(false);
    });
  });

  describe('compareValues', () => {
    it('sorts correctly with nulls', () => {
      expect(compareValues(null, 10, 'asc')).toBe(1); // nulls at the end
      expect(compareValues(10, null, 'asc')).toBe(-1);
      expect(compareValues(null, null, 'asc')).toBe(0);
      expect(compareValues(undefined, null, 'desc')).toBe(0);
    });

    it('sorts numbers correctly', () => {
      expect(compareValues(10, 2, 'asc')).toBe(8);
      expect(compareValues(10, 2, 'desc')).toBe(-8);
    });

    it('sorts strings correctly', () => {
      expect(compareValues('apple', 'banana', 'asc')).toBeLessThan(0);
      expect(compareValues('apple', 'banana', 'desc')).toBeGreaterThan(0);
    });
  });

  describe('validateRegexFilter', () => {
    it('validates safe regex', () => {
      expect(validateRegexFilter('hello.*world')).toBeNull();
    });

    it('rejects invalid regex', () => {
      expect(validateRegexFilter('hello(')).not.toBeNull();
    });
  });
});
