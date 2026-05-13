<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import { uiStore } from '../stores/ui.svelte.js';

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatNum(n: number): string {
    return n.toLocaleString('en-US');
  }

  function truncate(s: string, max = 40): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  // Read cacheVersion so cell-value reads in the template re-evaluate when the cache mutates.
  const cacheTick = $derived(gridStore.cacheVersion);

  const isFiltered = $derived(gridStore.filters.length > 0 || gridStore.globalSearch.length > 0);
  const rowDisplay = $derived(
    isFiltered
      ? `${formatNum(gridStore.filteredRows)} of ${formatNum(gridStore.totalRows)} rows`
      : `${formatNum(gridStore.totalRows)} rows`
  );

  const colCount = $derived(gridStore.visibleSchema.length);
  const totalCols = $derived(gridStore.schema.length);
  const colDisplay = $derived(
    colCount < totalCols
      ? `${colCount}/${totalCols} cols`
      : `${totalCols} cols`
  );

  const cell = $derived(gridStore.selectedCell);
  const range = $derived(gridStore.selectedRange);
  const selectedRow = $derived(gridStore.selectedRow);
  const selectedCol = $derived(gridStore.selectedCol);
  const fileSize = $derived(formatBytes(gridStore.totalBytes));
  const fileType = $derived(gridStore.fileType.toUpperCase());
  const isDirty = $derived(uiStore.isDirty);

  // Resolve the active cell value, name and address.
  const activeAddress = $derived.by(() => {
    if (!cell) return null;
    const colName = gridStore.schema[cell.col]?.name ?? `col${cell.col + 1}`;
    return { row: cell.row + 1, col: cell.col + 1, colName };
  });

  const activeValue = $derived.by(() => {
    if (!cell) return null;
    void cacheTick;  // force recompute on cache mutation
    const v = gridStore.getCell(cell.row, cell.col);
    if (v === null || v === undefined) return '∅';
    return truncate(String(v));
  });

  const rangeInfo = $derived.by(() => {
    if (!range) return null;
    const rows = range.r2 - range.r1 + 1;
    const cols = range.c2 - range.c1 + 1;
    return { rows, cols, total: rows * cols };
  });
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

  <div class="status-center">
    {#if rangeInfo}
      <span class="status-item">
        <strong>{formatNum(rangeInfo.rows)}×{formatNum(rangeInfo.cols)}</strong>
        <span class="muted">range · {formatNum(rangeInfo.total)} cells</span>
      </span>
    {:else if activeAddress && activeValue !== null}
      <span class="status-item">
        <span class="muted">R{formatNum(activeAddress.row)}</span>
        <span class="status-sep">·</span>
        <span class="muted">{truncate(activeAddress.colName, 20)}</span>
        <span class="status-sep">→</span>
        <strong class="status-value">{activeValue}</strong>
      </span>
    {:else if selectedRow !== null}
      <span class="status-item muted">Row {formatNum(selectedRow + 1)} selected</span>
    {:else if selectedCol !== null}
      <span class="status-item muted">
        Column “{truncate(gridStore.schema[selectedCol]?.name ?? '', 24)}” selected
      </span>
    {/if}
  </div>

  <div class="status-right">
    {#if uiStore.filterProgress !== null}
      <span class="status-badge filter-progress-badge">Filtering… {uiStore.filterProgress}%</span>
    {/if}
    {#if gridStore.rowCapWarning}
      {#if gridStore.rowCapWarning === 'preview'}
        <span class="status-badge cap-badge" title="Preview mode — showing the first 100k rows">Preview (Max 100k rows)</span>
      {:else if gridStore.rowCapWarning === 'memory'}
        <span class="status-badge cap-badge" title="Truncated due to memory limits">Truncated (memory)</span>
      {:else}
        <span class="status-badge cap-badge" title="File too large for full display — showing the first 1M rows">Truncated</span>
      {/if}
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
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    padding: 0 12px;
    height: 22px;
    background: var(--gm-statusbar-bg);
    border-top: 1px solid var(--gm-border);
    flex-shrink: 0;
    font-size: 11px;
    color: var(--gm-fg-muted);
    gap: 12px;
  }

  .status-left,
  .status-center,
  .status-right {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .status-center {
    justify-content: center;
    overflow: hidden;
  }

  .status-right {
    justify-self: end;
  }

  .status-item {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .status-item.muted, .muted { color: var(--gm-fg-subtle); }
  .status-sep { color: var(--gm-border); padding: 0 2px; }

  .status-value {
    color: var(--gm-fg);
    font-family: var(--vscode-editor-font-family, monospace);
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-block;
    vertical-align: bottom;
  }

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

  .cap-badge {
    background: rgba(204, 167, 0, 0.15);
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  .filter-progress-badge {
    background: var(--gm-accent-light);
    color: var(--gm-accent);
  }
</style>
