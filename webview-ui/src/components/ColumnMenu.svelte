<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import type { InferredType } from '@shared/schema.js';

  interface Props {
    colIndex: number;
    anchor: { x: number; y: number };
    onClose: () => void;
  }

  let { colIndex, anchor, onClose }: Props = $props();

  const col = $derived(gridStore.schema[colIndex]);

  function sortAsc() { gridStore.setSort({ colIndex, direction: 'asc' }); onClose(); }
  function sortDesc() { gridStore.setSort({ colIndex, direction: 'desc' }); onClose(); }
  function clearSort() { gridStore.setSort(null); onClose(); }

  function filterByCol() {
    gridStore.setFilter({ colIndex, op: 'contains', value: '' });
    onClose();
  }

  function hideCol() { gridStore.toggleColumnVisibility(colIndex); onClose(); }

  function setType(type: InferredType) {
    const updated = gridStore.schema.map(c =>
      c.index === colIndex ? { ...c, userOverrideType: type } : c
    );
    gridStore.updateSchema(updated);
    onClose();
  }

  const isSorted = $derived(gridStore.sort?.colIndex === colIndex);
  const sortDir = $derived(gridStore.sort?.direction);

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as Element;
    if (!target.closest('.column-menu')) onClose();
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div
  class="column-menu"
  style="left: {anchor.x}px; top: {anchor.y}px;"
  role="menu"
  tabindex="-1"
>
  <div class="menu-header">{col?.name ?? `Column ${colIndex}`}</div>

  <div class="menu-section">
    <button class="menu-item" onclick={sortAsc} class:active={isSorted && sortDir === 'asc'}>
      <span class="menu-icon">↑</span> Sort A → Z
    </button>
    <button class="menu-item" onclick={sortDesc} class:active={isSorted && sortDir === 'desc'}>
      <span class="menu-icon">↓</span> Sort Z → A
    </button>
    {#if isSorted}
      <button class="menu-item" onclick={clearSort}>
        <span class="menu-icon">✕</span> Clear sort
      </button>
    {/if}
  </div>

  <div class="menu-divider"></div>

  <div class="menu-section">
    <button class="menu-item" onclick={filterByCol}>
      <span class="menu-icon">⊟</span> Filter by this column
    </button>
  </div>

  <div class="menu-divider"></div>

  <div class="menu-section">
    <div class="menu-label">Treat as type</div>
    {#each (['string', 'number', 'boolean', 'date'] as InferredType[]) as type}
      <button
        class="menu-item"
        onclick={() => setType(type)}
        class:active={col?.userOverrideType === type || (!col?.userOverrideType && col?.inferredType === type)}
      >
        <span class="type-badge type-{type}">{type}</span>
      </button>
    {/each}
  </div>

  <div class="menu-divider"></div>

  <div class="menu-section">
    <button class="menu-item danger" onclick={hideCol}>
      <span class="menu-icon">○</span> Hide column
    </button>
  </div>
</div>

<style>
  .column-menu {
    position: fixed;
    z-index: 1000;
    background: var(--gm-menu-bg);
    border: 1px solid var(--gm-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    min-width: 190px;
    overflow: hidden;
    font-size: 12px;
  }

  .menu-header {
    padding: 8px 12px 6px;
    font-weight: 600;
    color: var(--gm-fg-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--gm-border);
  }

  .menu-section {
    padding: 4px 0;
  }

  .menu-label {
    padding: 4px 12px 2px;
    font-size: 11px;
    color: var(--gm-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 12px;
    background: none;
    border: none;
    color: var(--gm-fg);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .menu-item:hover { background: var(--gm-hover-bg); }
  .menu-item.active { color: var(--gm-accent); }
  .menu-item.danger { color: var(--gm-danger); }

  .menu-icon {
    width: 14px;
    text-align: center;
    color: var(--gm-fg-muted);
    font-size: 11px;
  }

  .menu-divider {
    height: 1px;
    background: var(--gm-border);
    margin: 2px 0;
  }

  .type-badge {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .type-string  { background: var(--gm-type-string-bg);  color: var(--gm-type-string-fg); }
  .type-number  { background: var(--gm-type-number-bg);  color: var(--gm-type-number-fg); }
  .type-boolean { background: var(--gm-type-bool-bg);    color: var(--gm-type-bool-fg); }
  .type-date    { background: var(--gm-type-date-bg);    color: var(--gm-type-date-fg); }
</style>
