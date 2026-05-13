/**
 * Unit tests for messageHandler logic that can't be tested via the full
 * module (which requires window/DOM). Uses inline simulations of the critical
 * paths, matching the pattern in chunkTimeout.test.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FilterSpec } from '@shared/schema.js';

// ---------------------------------------------------------------------------
// T3: CSV stream cancel at memory cap
// Simulates _capStream logic: when row limit exceeded, LARGE_FILE_STREAM_CANCEL
// is posted, rows are capped, and no further rows are accepted.
// ---------------------------------------------------------------------------

interface CapStreamState {
  streamCapped: boolean;
  rowCapWarning: 'limit' | 'memory' | null;
  postedMessages: { type: string }[];
  totalRows: number;
}

function makeStreamManager(initialRows: number, maxRows: number) {
  const state: CapStreamState = {
    streamCapped: false,
    rowCapWarning: null,
    postedMessages: [],
    totalRows: initialRows,
  };

  function capStream(reason: 'limit' | 'memory'): void {
    state.streamCapped = true;
    state.rowCapWarning = reason;
    state.postedMessages.push({ type: 'LARGE_FILE_STREAM_CANCEL' });
  }

  function receiveRows(rows: number[][]): number {
    if (state.streamCapped) return 0;
    const remaining = maxRows - state.totalRows;
    if (remaining <= 0) {
      capStream('limit');
      return 0;
    }
    const accepted = rows.length > remaining ? rows.slice(0, remaining) : rows;
    state.totalRows += accepted.length;
    if (accepted.length < rows.length) {
      capStream('limit');
    }
    return accepted.length;
  }

  function receiveRowsWithMemoryPressure(rows: number[][], memRatio: number): number {
    if (state.streamCapped) return 0;
    if (memRatio >= 0.82) {
      capStream('memory');
      return 0;
    }
    return receiveRows(rows);
  }

  return { state, capStream, receiveRows, receiveRowsWithMemoryPressure };
}

describe('T3: CSV stream cancel at memory/row cap', () => {
  it('row limit hit → LARGE_FILE_STREAM_CANCEL posted, streamCapped=true', () => {
    const mgr = makeStreamManager(999_999, 1_000_000);
    const rows = Array.from({ length: 5 }, (_, i) => [i]);

    const accepted = mgr.receiveRows(rows);

    expect(accepted).toBe(1);
    expect(mgr.state.streamCapped).toBe(true);
    expect(mgr.state.rowCapWarning).toBe('limit');
    expect(mgr.state.postedMessages).toContainEqual({ type: 'LARGE_FILE_STREAM_CANCEL' });
  });

  it('already capped → subsequent rows rejected without re-posting cancel', () => {
    const mgr = makeStreamManager(0, 10);
    mgr.capStream('limit');

    const accepted = mgr.receiveRows([[1], [2], [3]]);

    expect(accepted).toBe(0);
    expect(mgr.state.postedMessages).toHaveLength(1); // only the first cancel
  });

  it('memory pressure ≥ 0.82 → LARGE_FILE_STREAM_CANCEL posted with reason=memory', () => {
    const mgr = makeStreamManager(5_000, 1_000_000);
    const rows = [[1], [2]];

    mgr.receiveRowsWithMemoryPressure(rows, 0.85);

    expect(mgr.state.streamCapped).toBe(true);
    expect(mgr.state.rowCapWarning).toBe('memory');
    expect(mgr.state.postedMessages).toContainEqual({ type: 'LARGE_FILE_STREAM_CANCEL' });
  });

  it('memory pressure < 0.82 → rows accepted normally', () => {
    const mgr = makeStreamManager(0, 1_000_000);
    const rows = [[1], [2], [3]];

    const accepted = mgr.receiveRowsWithMemoryPressure(rows, 0.5);

    expect(accepted).toBe(3);
    expect(mgr.state.streamCapped).toBe(false);
    expect(mgr.state.postedMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T4: Sidecar schema change — unknown column names are silently skipped
// Simulates the _applySidecar lookup: nameToIdx.get(name) === undefined → skip.
// ---------------------------------------------------------------------------

interface SidecarResult {
  filters: FilterSpec[];
  sort: { colIndex: number; direction: 'asc' | 'desc' } | null;
  hiddenCols: Set<number>;
  columnOrder: number[] | null;
  frozenCols: Set<number>;
}

function applySidecarLogic(
  schema: Array<{ name: string; index: number }>,
  sidecar: {
    filters?: Array<{ column: string; op: FilterSpec['op']; value: string | number | null }>;
    sort?: { column: string; direction: 'asc' | 'desc' } | null;
    hiddenColumns?: string[];
    columnOrder?: number[];
    frozenCols?: number[];
  },
): SidecarResult {
  const nameToIdx = new Map<string, number>();
  for (const c of schema) nameToIdx.set(c.name, c.index);

  const filters: FilterSpec[] = [];
  for (const f of sidecar.filters ?? []) {
    const idx = nameToIdx.get(f.column);
    if (idx === undefined) continue;
    filters.push({ colIndex: idx, op: f.op, value: f.value });
  }

  let sort: SidecarResult['sort'] = null;
  if (sidecar.sort) {
    const idx = nameToIdx.get(sidecar.sort.column);
    if (idx !== undefined) sort = { colIndex: idx, direction: sidecar.sort.direction };
  }

  const hiddenCols = new Set<number>();
  for (const name of sidecar.hiddenColumns ?? []) {
    const idx = nameToIdx.get(name);
    if (idx !== undefined) hiddenCols.add(idx);
  }

  const columnOrder = sidecar.columnOrder?.length ? sidecar.columnOrder : null;
  const frozenCols = new Set<number>(sidecar.frozenCols ?? []);

  return { filters, sort, hiddenCols, columnOrder, frozenCols };
}

describe('T4: Sidecar schema change — unknown columns skipped gracefully', () => {
  const schema = [
    { name: 'id', index: 0 },
    { name: 'name', index: 1 },
  ];

  it('filter referencing removed column is dropped, known column kept', () => {
    const result = applySidecarLogic(schema, {
      filters: [
        { column: 'id', op: 'eq', value: 42 },
        { column: 'deleted_col', op: 'contains', value: 'foo' },
      ],
    });
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].colIndex).toBe(0);
  });

  it('sort referencing removed column → sort is null', () => {
    const result = applySidecarLogic(schema, {
      sort: { column: 'deleted_col', direction: 'asc' },
    });
    expect(result.sort).toBeNull();
  });

  it('sort referencing existing column → applied correctly', () => {
    const result = applySidecarLogic(schema, {
      sort: { column: 'name', direction: 'desc' },
    });
    expect(result.sort).toEqual({ colIndex: 1, direction: 'desc' });
  });

  it('hidden column referencing removed name → not added to hiddenCols', () => {
    const result = applySidecarLogic(schema, {
      hiddenColumns: ['name', 'ghost_col'],
    });
    expect(result.hiddenCols).toEqual(new Set([1]));
    expect(result.hiddenCols.has(99)).toBe(false);
  });

  it('empty sidecar → all defaults', () => {
    const result = applySidecarLogic(schema, {});
    expect(result.filters).toHaveLength(0);
    expect(result.sort).toBeNull();
    expect(result.hiddenCols.size).toBe(0);
    expect(result.columnOrder).toBeNull();
    expect(result.frozenCols.size).toBe(0);
  });

  it('completely unknown schema (all cols renamed) → no filters, no sort, no hidden', () => {
    const result = applySidecarLogic(schema, {
      filters: [{ column: 'old_a', op: 'eq', value: 1 }, { column: 'old_b', op: 'eq', value: 2 }],
      sort: { column: 'old_a', direction: 'asc' },
      hiddenColumns: ['old_a', 'old_b'],
    });
    expect(result.filters).toHaveLength(0);
    expect(result.sort).toBeNull();
    expect(result.hiddenCols.size).toBe(0);
  });
});
