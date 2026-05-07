<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import { uiStore } from '../stores/ui.svelte.js';

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatRowCount(n: number): string {
    return n.toLocaleString();
  }

  const isFiltered = $derived(gridStore.filters.length > 0 || gridStore.globalSearch.length > 0);
  const rowDisplay = $derived(
    isFiltered
      ? `${formatRowCount(gridStore.filteredRows)} of ${formatRowCount(gridStore.totalRows)} rows`
      : `${formatRowCount(gridStore.totalRows)} rows`
  );

  const colCount = $derived(gridStore.visibleSchema.length);
  const totalCols = $derived(gridStore.schema.length);
  const colDisplay = $derived(
    colCount < totalCols
      ? `${colCount}/${totalCols} cols`
      : `${totalCols} cols`
  );

  const cell = $derived(gridStore.selectedCell);
  const fileSize = $derived(formatBytes(gridStore.totalBytes));
  const fileType = $derived(gridStore.fileType.toUpperCase());
  const isDirty = $derived(uiStore.isDirty);
</script>

<div class="status-bar">
  <div class="status-left">
    <span class="status-badge type-badge">{fileType}</span>
    <span class="status-item">{rowDisplay}</span>
    <span class="status-sep">·</span>
    <span class="status-item">{colDisplay}</span>
    <span class="status-sep">·</span>
    <span class="status-item muted">{fileSize}</span>
  </div>

  <div class="status-right">
    {#if cell !== null}
      <span class="status-item muted">
        Row {(cell.row + 1).toLocaleString()}, Col {cell.col + 1}
      </span>
    {/if}

    {#if isDirty}
      <span class="status-badge dirty-badge">Unsaved</span>
    {:else if gridStore.totalRows > 0}
      <span class="status-badge saved-badge">Saved</span>
    {/if}
  </div>
</div>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    height: 22px;
    background: var(--gm-statusbar-bg);
    border-top: 1px solid var(--gm-border);
    flex-shrink: 0;
    font-size: 11px;
    color: var(--gm-fg-muted);
  }

  .status-left,
  .status-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-item { white-space: nowrap; }
  .status-item.muted { color: var(--gm-fg-subtle); }
  .status-sep { color: var(--gm-border); }

  .status-badge {
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .type-badge {
    background: var(--gm-accent-light);
    color: var(--gm-accent);
  }

  .dirty-badge {
    background: rgba(255, 165, 0, 0.15);
    color: orange;
  }

  .saved-badge {
    background: rgba(80, 200, 120, 0.12);
    color: var(--gm-success);
  }
</style>
