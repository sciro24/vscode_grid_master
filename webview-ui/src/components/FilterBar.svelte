<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import type { FilterSpec, FilterOp } from '@shared/schema.js';

  const OP_LABELS: Record<FilterOp, string> = {
    contains: 'contains',
    not_contains: "doesn't contain",
    eq: '=',
    neq: '≠',
    gt: '>',
    lt: '<',
    gte: '≥',
    lte: '≤',
    regex: 'regex',
    is_null: 'is empty',
    is_not_null: 'is not empty',
  };

  const TEXT_OPS: FilterOp[] = ['contains', 'not_contains', 'eq', 'neq', 'regex', 'is_null', 'is_not_null'];
  const NUM_OPS: FilterOp[] = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null'];

  function getOpsForCol(colIndex: number): FilterOp[] {
    const col = gridStore.schema[colIndex];
    return col?.inferredType === 'number' ? NUM_OPS : TEXT_OPS;
  }

  function needsValue(op: FilterOp): boolean {
    return op !== 'is_null' && op !== 'is_not_null';
  }

  function updateFilterOp(f: FilterSpec, op: FilterOp) {
    gridStore.setFilter({ ...f, op });
  }

  function updateFilterValue(f: FilterSpec, value: string) {
    gridStore.setFilter({ ...f, value });
  }

  const filters = $derived(gridStore.filters);
  const schema = $derived(gridStore.schema);
</script>

<div class="filter-bar">
  <span class="filter-label">Filters:</span>
  {#each filters as f (f.colIndex)}
    {@const col = schema[f.colIndex]}
    <div class="filter-chip">
      <span class="chip-col">{col?.name ?? `col${f.colIndex}`}</span>
      <select
        class="chip-op"
        value={f.op}
        onchange={(e) => updateFilterOp(f, (e.target as HTMLSelectElement).value as FilterOp)}
      >
        {#each getOpsForCol(f.colIndex) as op}
          <option value={op}>{OP_LABELS[op]}</option>
        {/each}
      </select>
      {#if needsValue(f.op)}
        <input
          class="chip-val"
          type="text"
          value={String(f.value ?? '')}
          oninput={(e) => updateFilterValue(f, (e.target as HTMLInputElement).value)}
        />
      {/if}
      <button class="chip-remove" onclick={() => gridStore.removeFilter(f.colIndex)}>×</button>
    </div>
  {/each}

  {#if filters.length > 1}
    <button class="clear-all-btn" onclick={() => gridStore.clearFilters()}>Clear all</button>
  {/if}
</div>

<style>
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    background: var(--gm-toolbar-bg);
    border-bottom: 1px solid var(--gm-border);
    flex-wrap: wrap;
    flex-shrink: 0;
    min-height: 34px;
  }

  .filter-label {
    font-size: 11px;
    color: var(--gm-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .filter-chip {
    display: flex;
    align-items: center;
    background: var(--gm-chip-bg);
    border: 1px solid var(--gm-border);
    border-radius: 12px;
    overflow: hidden;
    height: 24px;
    font-size: 12px;
  }

  .chip-col {
    padding: 0 8px;
    color: var(--gm-accent);
    font-weight: 500;
    border-right: 1px solid var(--gm-border);
  }

  .chip-op {
    background: transparent;
    border: none;
    color: var(--gm-fg);
    font-size: 12px;
    padding: 0 6px;
    cursor: pointer;
    outline: none;
    border-right: 1px solid var(--gm-border);
    height: 100%;
  }

  .chip-val {
    background: transparent;
    border: none;
    color: var(--gm-fg);
    font-size: 12px;
    padding: 0 6px;
    width: 100px;
    outline: none;
    border-right: 1px solid var(--gm-border);
  }

  .chip-remove {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--gm-fg-muted);
    padding: 0 8px;
    font-size: 15px;
    line-height: 1;
    height: 100%;
    display: flex;
    align-items: center;
  }

  .chip-remove:hover {
    color: var(--gm-fg);
    background: var(--gm-hover-bg);
  }

  .clear-all-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--gm-fg-muted);
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .clear-all-btn:hover {
    background: var(--gm-hover-bg);
    color: var(--gm-fg);
  }
</style>
