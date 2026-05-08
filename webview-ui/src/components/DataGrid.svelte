<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import { postMessage } from '../bridge/vscode.js';
  import type { CellValue } from '@shared/schema.js';

  const ROW_HEIGHT = 26;
  const HEADER_HEIGHT = 32;
  const OVERSCAN = 8;
  const MIN_COL_WIDTH = 40;

  let scrollerEl: HTMLDivElement;
  let scrollTop = $state(0);
  let viewportHeight = $state(600);

  const totalRows = $derived(gridStore.filteredRows);
  const totalHeight = $derived(totalRows * ROW_HEIGHT);
  // Read cacheVersion so cell reads in the template re-evaluate when the cache mutates.
  const cacheTick = $derived(gridStore.cacheVersion);

  const startRow = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const visibleRowCount = $derived(Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2);
  const endRow = $derived(Math.min(totalRows, startRow + visibleRowCount));

  $effect(() => {
    gridStore.updateViewport(startRow, endRow);
  });

  function onScroll(e: Event) {
    scrollTop = (e.target as HTMLDivElement).scrollTop;
  }

  function onResize() {
    if (scrollerEl) viewportHeight = scrollerEl.clientHeight;
  }

  $effect(() => {
    if (scrollerEl) {
      viewportHeight = scrollerEl.clientHeight;
      const ro = new ResizeObserver(onResize);
      ro.observe(scrollerEl);
      return () => ro.disconnect();
    }
  });

  function formatCell(v: CellValue): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') {
      if (!isFinite(v)) return String(v);
      // Integers: render as-is (no thousand separator) — locale grouping turns
      // 2024 into "2.024" in it-IT, which corrupts year columns and IDs.
      // Data grids should display the raw value.
      if (Number.isInteger(v)) return String(v);
      // Floats: trim to 6 decimals but keep '.' as decimal separator (en-US),
      // so we don't surprise users by swapping '.' for ',' in numeric columns.
      return v.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: false });
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  function isNull(v: CellValue): boolean {
    return v === null || v === undefined;
  }

  // ── Column resize ─────────────────────────────────────────────────────────

  let resizing = $state<{ colName: string; startX: number; startW: number } | null>(null);

  function startResize(e: MouseEvent, colName: string, colType: string) {
    e.preventDefault();
    e.stopPropagation();
    const startW = colWidth(colName, colType);
    resizing = { colName, startX: e.clientX, startW };

    function onMove(ev: MouseEvent) {
      if (!resizing) return;
      const w = Math.max(MIN_COL_WIDTH, resizing.startW + ev.clientX - resizing.startX);
      gridStore.setColumnWidth(resizing.colName, w);
    }

    function onUp() {
      resizing = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Editing ───────────────────────────────────────────────────────────────

  let editingCell = $state<{ row: number; col: number } | null>(null);
  let editValue = $state('');

  function startEdit(row: number, colIdx: number) {
    const v = gridStore.getCell(row, colIdx);
    editingCell = { row, col: colIdx };
    editValue = isNull(v) ? '' : String(v);
  }

  function commitEdit() {
    if (!editingCell) return;
    const { row, col } = editingCell;
    const oldValue = gridStore.getCell(row, col);
    const newValue: CellValue = editValue === '' ? null : (
      !isNaN(Number(editValue)) ? Number(editValue) :
      editValue.toLowerCase() === 'true' ? true :
      editValue.toLowerCase() === 'false' ? false :
      editValue
    );
    gridStore.setCellValue(row, col, newValue);
    const editId = `edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    postMessage({ type: 'EDIT', payload: { editId, row, col, oldValue, newValue } });
    editingCell = null;
  }

  function cancelEdit() { editingCell = null; }

  function onCellKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  }

  // ── Column widths ─────────────────────────────────────────────────────────

  function colWidth(name: string, type: string): number {
    const stored = gridStore.colWidths.get(name);
    if (stored) return stored;
    const auto = gridStore.getAutoWidth(name);
    if (auto) return auto;
    switch (type) {
      case 'number':  return 110;
      case 'boolean': return 80;
      case 'date':    return 140;
      default:        return 160;
    }
  }

  // ── Sort ──────────────────────────────────────────────────────────────────

  function toggleSort(colIdx: number) {
    const cur = gridStore.sort;
    if (cur && cur.colIndex === colIdx) {
      gridStore.setSort(cur.direction === 'asc' ? { colIndex: colIdx, direction: 'desc' } : null);
    } else {
      gridStore.setSort({ colIndex: colIdx, direction: 'asc' });
    }
  }

  function sortIndicator(colIdx: number): string {
    const s = gridStore.sort;
    if (!s || s.colIndex !== colIdx) return '';
    return s.direction === 'asc' ? ' ↑' : ' ↓';
  }

  // ── Column colors ─────────────────────────────────────────────────────────

  // Accessed via gridStore.colColors (set by Toolbar)
  function colBgStyle(colIndex: number): string {
    const color = gridStore.colColors.get(colIndex);
    return color ? `background-color: ${color};` : '';
  }
</script>

<div class="grid-root" class:is-resizing={resizing !== null}>
  <div class="grid-scroller" bind:this={scrollerEl} onscroll={onScroll}>
    <div class="grid-sizer" style="height: {totalHeight + HEADER_HEIGHT}px;">

      <!-- Sticky header -->
      <div class="grid-header" style="height: {HEADER_HEIGHT}px;">
        <div class="row-num-cell header-cell">#</div>
        {#each gridStore.visibleSchema as col (col.index)}
          <div
            class="header-cell"
            style="width: {colWidth(col.name, col.inferredType)}px; {colBgStyle(col.index)}"
          >
            <button
              class="header-btn"
              onclick={() => toggleSort(col.index)}
              title="Click to sort"
            >
              <span class="header-name">{col.name}{sortIndicator(col.index)}</span>
              <span class="header-type">{col.inferredType}</span>
            </button>
            <!-- Resize handle -->
            <div
              class="resize-handle"
              onmousedown={(e) => startResize(e, col.name, col.inferredType)}
              role="separator"
              aria-label="Resize column"
            ></div>
          </div>
        {/each}
      </div>

      <!-- Virtualized rows -->
      <div class="grid-rows" style="transform: translateY({HEADER_HEIGHT + startRow * ROW_HEIGHT}px);">
        {#each Array(endRow - startRow) as _, i}
          {@const row = startRow + i}
          <div class="grid-row" style="height: {ROW_HEIGHT}px;">
            <div class="row-num-cell">{row + 1}</div>
            {#each gridStore.visibleSchema as col (col.index)}
              {@const val = (cacheTick, gridStore.getCell(row, col.index))}
              {#if editingCell && editingCell.row === row && editingCell.col === col.index}
                <input
                  class="cell-input"
                  style="width: {colWidth(col.name, col.inferredType)}px"
                  bind:value={editValue}
                  onblur={commitEdit}
                  onkeydown={onCellKey}
                  autofocus
                />
              {:else}
                <div
                  class="cell"
                  class:cell-null={isNull(val)}
                  class:cell-number={col.inferredType === 'number'}
                  style="width: {colWidth(col.name, col.inferredType)}px; {colBgStyle(col.index)}"
                  ondblclick={() => startEdit(row, col.index)}
                  role="button"
                  tabindex="-1"
                >
                  {isNull(val) ? '∅' : formatCell(val)}
                </div>
              {/if}
            {/each}
          </div>
        {/each}
      </div>

    </div>
  </div>
</div>

<style>
  .grid-root {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--gm-cell-bg, var(--vscode-editor-background));
    color: var(--gm-fg, var(--vscode-editor-foreground));
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 12px;
  }

  /* Prevent text selection while resizing */
  .grid-root.is-resizing {
    user-select: none;
    cursor: col-resize;
  }

  .grid-scroller {
    width: 100%;
    height: 100%;
    overflow: auto;
    position: relative;
  }

  .grid-sizer {
    position: relative;
    min-width: 100%;
    width: max-content;
  }

  .grid-header {
    display: flex;
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--gm-header-bg, var(--vscode-editorWidget-background));
    border-bottom: 1px solid var(--gm-border, var(--vscode-panel-border));
  }

  .header-cell {
    position: relative;
    display: flex;
    align-items: stretch;
    border-right: 1px solid var(--gm-border, var(--vscode-panel-border));
    overflow: visible;
    flex-shrink: 0;
  }

  .header-btn {
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 4px 8px;
    flex: 1;
    min-width: 0;
    font-weight: 600;
    font-size: 11px;
    color: var(--gm-header-fg, var(--vscode-editor-foreground));
    text-align: left;
    cursor: pointer;
    background: transparent;
    border: none;
    overflow: hidden;
    white-space: nowrap;
    user-select: none;
  }

  .header-btn:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .header-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .header-type {
    font-size: 9px;
    opacity: 0.5;
    text-transform: uppercase;
    font-weight: 400;
  }

  /* Resize handle — 6px wide strip on the right edge of the header cell */
  .resize-handle {
    position: absolute;
    right: -3px;
    top: 0;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 3;
  }

  .resize-handle:hover,
  .resize-handle:active {
    background: var(--vscode-focusBorder);
    opacity: 0.7;
  }

  .grid-rows {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    will-change: transform;
  }

  .grid-row {
    display: flex;
    border-bottom: 1px solid var(--gm-border, var(--vscode-panel-border));
  }

  .grid-row:hover > .cell {
    filter: brightness(0.95);
  }

  .row-num-cell {
    width: 56px;
    flex-shrink: 0;
    padding: 0 8px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    color: var(--gm-fg-muted, var(--vscode-descriptionForeground));
    border-right: 1px solid var(--gm-border, var(--vscode-panel-border));
    font-size: 11px;
    background: var(--gm-header-bg, var(--vscode-editorWidget-background));
    user-select: none;
  }

  .cell {
    padding: 0 8px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    border-right: 1px solid var(--gm-border, var(--vscode-panel-border));
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: cell;
  }

  .cell-number {
    justify-content: flex-end;
    font-variant-numeric: tabular-nums;
  }

  .cell-null {
    color: var(--gm-fg-subtle, var(--vscode-descriptionForeground));
    opacity: 0.5;
    font-style: italic;
  }

  .cell-input {
    padding: 0 8px;
    flex-shrink: 0;
    border: 2px solid var(--vscode-focusBorder);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: inherit;
    outline: none;
    box-sizing: border-box;
  }
</style>
