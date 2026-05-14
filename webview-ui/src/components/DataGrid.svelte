<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import { postMessage } from '../bridge/vscode.js';
  import type { CellValue } from '@shared/schema.js';
  import RowContextMenu from './RowContextMenu.svelte';
  import ColumnMenu from './ColumnMenu.svelte';
  import ColumnStatsPanel from './ColumnStatsPanel.svelte';

  const ROW_HEIGHT = 26;
  const HEADER_HEIGHT = 32;
  const OVERSCAN = 8;
  const MIN_COL_WIDTH = 40;
  const MAX_SCROLLABLE_HEIGHT = 33_000_000;

  let scrollerEl: HTMLDivElement;
  let scrollTop = $state(0);
  let viewportHeight = $state(600);
  let scrollHeight = $state(0);

  const totalRows = $derived(gridStore.filteredRows);
  const realTotalHeight = $derived(totalRows * ROW_HEIGHT);
  const virtualTotalHeight = $derived(Math.min(realTotalHeight, MAX_SCROLLABLE_HEIGHT));
  const compressedScroll = $derived(realTotalHeight > MAX_SCROLLABLE_HEIGHT);
  // Read cacheVersion so cell reads in the template re-evaluate when the cache mutates.
  const cacheTick = $derived(gridStore.cacheVersion);

  const visibleRowCount = $derived(Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2);
  const maxDataStart = $derived(Math.max(0, totalRows - visibleRowCount));
  const maxScrollTop = $derived(Math.max(1, scrollHeight - viewportHeight));
  const isNearBottom = $derived.by(() => maxScrollTop - scrollTop <= ROW_HEIGHT * (OVERSCAN + 2));
  const isAtEnd = $derived.by(() => scrollTop + viewportHeight >= scrollHeight - 1);
  const scrollRatio = $derived.by(() => {
    if (!compressedScroll) return 0;
    if (isAtEnd || isNearBottom) return 1;
    return Math.min(1, Math.max(0, scrollTop / maxScrollTop));
  });

  const rawDisplayStartRow = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));

  const rawDataStartRow = $derived.by(() => {
    if (!compressedScroll) {
      return Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    }
    if (isAtEnd || isNearBottom) return maxDataStart;
    const base = Math.floor(scrollRatio * maxDataStart);
    if (base >= maxDataStart - OVERSCAN) return maxDataStart;
    const withOverscan = base - OVERSCAN;
    return Math.max(0, Math.min(withOverscan, maxDataStart));
  });
  const startRow = $derived.by(() => {
    if (totalRows === 0) return 0;
    const clamped = Math.min(rawDataStartRow, maxDataStart);
    if (clamped + visibleRowCount >= totalRows) return maxDataStart;
    return clamped;
  });
  const endRow = $derived(Math.min(totalRows, startRow + visibleRowCount));
  const rowCount = $derived(Math.max(0, endRow - startRow));

  // displayStartRow must always equal startRow so the CSS translateY matches
  // the data rows being rendered. Previously these diverged near the bottom,
  // causing the last rows to be positioned off-screen and an infinite-scroll loop.
  const displayStartRow = $derived(startRow);

  $effect(() => {
    gridStore.updateViewport(startRow, endRow);
  });

  function onScroll(e: Event) {
    const el = e.target as HTMLDivElement;
    scrollTop = el.scrollTop;
    scrollHeight = el.scrollHeight;
  }

  function onResize() {
    if (scrollerEl) {
      viewportHeight = scrollerEl.clientHeight;
      scrollHeight = scrollerEl.scrollHeight;
    }
  }

  $effect(() => {
    if (scrollerEl) {
      viewportHeight = scrollerEl.clientHeight;
      scrollHeight = scrollerEl.scrollHeight;
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

  function colBgStyle(colIndex: number): string {
    const color = gridStore.colColors.get(colIndex);
    return color ? `background-color: ${color};` : '';
  }

  // True while the user has the column-colour palette enabled.
  // When on, cells get muted pastels and the border treatment / selection style
  // need to adapt so the visualisation stays readable.
  const colouredMode = $derived(gridStore.colColors.size > 0);

  // ── Context menus ─────────────────────────────────────────────────────────

  let rowMenu = $state<{ row: number; x: number; y: number } | null>(null);
  let colMenu = $state<{ colIndex: number; x: number; y: number } | null>(null);
  let statsCol = $state<number | null>(null);

  function onRowContextMenu(e: MouseEvent, row: number) {
    e.preventDefault();
    colMenu = null;
    gridStore.selectRow(row);
    rowMenu = { row, x: e.clientX, y: e.clientY };
  }

  function onHeaderContextMenu(e: MouseEvent, colIndex: number) {
    e.preventDefault();
    rowMenu = null;
    colMenu = { colIndex, x: e.clientX, y: e.clientY };
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  function onRowNumClick(row: number) {
    // Toggle: clicking the same row again clears just the row part of the selection
    // (keeps the column selection if any, so the cross pivot can still be visible).
    if (gridStore.selectedRow === row) gridStore.selectedRow = null;
    else gridStore.selectRow(row);
  }

  function onHeaderClick(colIndex: number) {
    if (gridStore.selectedCol === colIndex) gridStore.selectedCol = null;
    else gridStore.selectCol(colIndex);
  }

  function onCellClick(e: MouseEvent, row: number, col: number) {
    if (e.shiftKey) {
      gridStore.extendRange(row, col);
    } else {
      gridStore.selectCell(row, col);
    }
  }

  const selectedRow = $derived(gridStore.selectedRow);
  const selectedCol = $derived(gridStore.selectedCol);
  const selectedCell = $derived(gridStore.selectedCell);
  const selectedRange = $derived(gridStore.selectedRange);
  const frozenCols = $derived(gridStore.frozenCols);

  // Returns the sticky `left` offset (in px) for a frozen column at visual position `colPos`.
  // Row-number column is 56px + 1px border = 57px. Sums widths of all frozen cols before this one.
  function getFrozenLeft(col: import('@shared/schema.js').ColumnSchema, colPos: number): number {
    const ROW_NUM_WIDTH = 57;
    let left = ROW_NUM_WIDTH;
    const visSchema = gridStore.visibleSchema;
    for (let i = 0; i < colPos; i++) {
      const c = visSchema[i];
      if (c && frozenCols.has(c.index)) {
        left += colWidth(c.name, c.inferredType);
      }
    }
    return left;
  }

  // ── Column drag-to-reorder ────────────────────────────────────────────────

  let dragFromPos = $state<number | null>(null);
  let dragOverPos = $state<number | null>(null);

  function onHeaderDragStart(e: DragEvent, colPos: number) {
    dragFromPos = colPos;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(colPos));
    }
  }

  function onHeaderDragOver(e: DragEvent, colPos: number) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverPos = colPos;
  }

  function onHeaderDrop(e: DragEvent, colPos: number) {
    e.preventDefault();
    if (dragFromPos !== null && dragFromPos !== colPos) {
      gridStore.reorderColumn(dragFromPos, colPos);
    }
    dragFromPos = null;
    dragOverPos = null;
  }

  function onHeaderDragEnd() {
    dragFromPos = null;
    dragOverPos = null;
  }

  function isRowSelected(row: number): boolean {
    return selectedRow === row;
  }

  function isColSelected(col: number): boolean {
    return selectedCol === col;
  }

  function isCellSelected(row: number, col: number): boolean {
    return selectedCell?.row === row && selectedCell?.col === col;
  }

  function isInRange(row: number, col: number): boolean {
    if (!selectedRange) return false;
    return row >= selectedRange.r1 && row <= selectedRange.r2
      && col >= selectedRange.c1 && col <= selectedRange.c2;
  }

  // True when both row & column are selected and this cell sits on their intersection.
  function isCrossPivot(row: number, col: number): boolean {
    return selectedRow === row && selectedCol === col;
  }

  // ── Keyboard navigation ────────────────────────────────────────────────────

  function activeCell(): { row: number; col: number } | null {
    return gridStore.selectedCell ?? gridStore.selectionAnchor;
  }

  function clampRow(r: number): number {
    return Math.max(0, Math.min(gridStore.filteredRows - 1, r));
  }
  function clampCol(c: number): number {
    const cols = gridStore.visibleSchema;
    if (cols.length === 0) return 0;
    return Math.max(0, Math.min(cols.length - 1, c));
  }

  // Map between visibleSchema position and the underlying schema index.
  function visiblePosFromColIdx(colIdx: number): number {
    const cols = gridStore.visibleSchema;
    const i = cols.findIndex(c => c.index === colIdx);
    return i < 0 ? 0 : i;
  }
  function colIdxFromVisiblePos(pos: number): number {
    const cols = gridStore.visibleSchema;
    const p = clampCol(pos);
    return cols[p]?.index ?? 0;
  }

  // Scroll the grid so the row at `r` is comfortably in view.
  function scrollRowIntoView(r: number) {
    if (!scrollerEl) return;
    const top = HEADER_HEIGHT + r * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    const viewTop = scrollerEl.scrollTop;
    const viewBottom = viewTop + scrollerEl.clientHeight;
    if (top < viewTop + HEADER_HEIGHT) scrollerEl.scrollTop = Math.max(0, top - HEADER_HEIGHT);
    else if (bottom > viewBottom) scrollerEl.scrollTop = bottom - scrollerEl.clientHeight;
  }

  function onKeyDown(e: KeyboardEvent) {
    // Don't intercept while editing a cell — the inline input owns keys.
    if (editingCell) return;
    // Don't intercept when the focus is inside an input/textarea/contenteditable
    // (search box, rename input, etc.) — those handle their own keys.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    // Cmd/Ctrl + C → copy current selection
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
      const txt = gridStore.copySelectionToClipboard();
      if (txt !== null) e.preventDefault();
      return;
    }

    const cur = activeCell();
    if (!cur) return;

    let { row, col } = cur;
    let handled = true;

    switch (e.key) {
      case 'ArrowUp':    row = clampRow(row - 1); break;
      case 'ArrowDown':  row = clampRow(row + 1); break;
      case 'ArrowLeft': {
        const p = visiblePosFromColIdx(col);
        col = colIdxFromVisiblePos(p - 1);
        break;
      }
      case 'ArrowRight':
      case 'Tab': {
        const p = visiblePosFromColIdx(col);
        col = colIdxFromVisiblePos(p + 1);
        break;
      }
      case 'Home': {
        if (e.ctrlKey || e.metaKey) row = 0;
        col = colIdxFromVisiblePos(0);
        break;
      }
      case 'End': {
        if (e.ctrlKey || e.metaKey) row = clampRow(gridStore.filteredRows - 1);
        col = colIdxFromVisiblePos(gridStore.visibleSchema.length - 1);
        break;
      }
      case 'PageUp': {
        const pageRows = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
        row = clampRow(row - pageRows);
        break;
      }
      case 'PageDown': {
        const pageRows = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
        row = clampRow(row + pageRows);
        break;
      }
      case 'Enter': {
        startEdit(row, col);
        break;
      }
      case 'Escape': {
        gridStore.clearSelection();
        break;
      }
      default:
        handled = false;
    }

    if (handled) {
      e.preventDefault();
      if (e.key !== 'Enter' && e.key !== 'Escape') {
        if (e.shiftKey && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown')) {
          gridStore.extendRange(row, col);
        } else {
          gridStore.selectCell(row, col);
        }
        scrollRowIntoView(row);
      }
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="grid-root" class:is-resizing={resizing !== null} class:is-coloured={colouredMode}>
  <div class="grid-scroller" bind:this={scrollerEl} onscroll={onScroll}>
    <div class="grid-sizer" style="height: {virtualTotalHeight + HEADER_HEIGHT}px;">

      <!-- Sticky header -->
      <div class="grid-header" style="height: {HEADER_HEIGHT}px;">
        <div class="row-num-cell header-cell row-num-frozen">#</div>
        {#each gridStore.visibleSchema as col, colPos (col.index)}
          {@const colSel = isColSelected(col.index)}
          {@const isFrozen = frozenCols.has(col.index)}
          <div
            class="header-cell"
            class:header-cell-selected={colSel}
            class:col-frozen={isFrozen}
            class:drag-over={dragOverPos === colPos && dragFromPos !== colPos}
            draggable="true"
            ondragstart={(e) => onHeaderDragStart(e, colPos)}
            ondragover={(e) => onHeaderDragOver(e, colPos)}
            ondrop={(e) => onHeaderDrop(e, colPos)}
            ondragend={onHeaderDragEnd}
            style="width: {colWidth(col.name, col.inferredType)}px; {colBgStyle(col.index)}{isFrozen ? ' left: ' + getFrozenLeft(col, colPos) + 'px;' : ''}"
            oncontextmenu={(e) => onHeaderContextMenu(e, col.index)}
          >
            <button
              class="header-btn"
              onclick={() => onHeaderClick(col.index)}
              title="Click to select column — right-click for sort, filter & more"
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
      <div class="grid-rows" style="transform: translateY({HEADER_HEIGHT + displayStartRow * ROW_HEIGHT}px);">
        {#each Array(rowCount) as _, i}
          {@const row = startRow + i}
          {@const rowSel = isRowSelected(row)}
          <div class="grid-row" class:row-selected={rowSel} style="height: {ROW_HEIGHT}px;">
            <div
              class="row-num-cell row-num-frozen"
              class:row-num-selected={rowSel}
              onclick={() => onRowNumClick(row)}
              oncontextmenu={(e) => onRowContextMenu(e, row)}
              title="Click to select row — right-click for options"
              role="button"
              tabindex="-1"
            >{row + 1}</div>
            {#each gridStore.visibleSchema as col, colPos (col.index)}
              {@const val = (cacheTick, gridStore.getCell(row, col.index))}
              {@const isFrozen = frozenCols.has(col.index)}
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
                  class:cell-selected={isCellSelected(row, col.index)}
                  class:cell-col-selected={isColSelected(col.index)}
                  class:cell-cross={isCrossPivot(row, col.index)}
                  class:cell-in-range={isInRange(row, col.index)}
                  class:col-frozen={isFrozen}
                  style="width: {colWidth(col.name, col.inferredType)}px; {colBgStyle(col.index)}{isFrozen ? ' left: ' + getFrozenLeft(col, colPos) + 'px;' : ''}"
                  onclick={(e) => onCellClick(e, row, col.index)}
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

{#if rowMenu}
  <RowContextMenu
    row={rowMenu.row}
    anchor={{ x: rowMenu.x, y: rowMenu.y }}
    onClose={() => rowMenu = null}
  />
{/if}

{#if colMenu}
  <ColumnMenu
    colIndex={colMenu.colIndex}
    anchor={{ x: colMenu.x, y: colMenu.y }}
    onClose={() => colMenu = null}
    onShowStats={(idx) => statsCol = idx}
  />
{/if}

{#if statsCol !== null}
  <ColumnStatsPanel colIndex={statsCol} onClose={() => statsCol = null} />
{/if}

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

  .header-cell.header-cell-selected {
    background: var(--vscode-list-activeSelectionBackground, rgba(100, 149, 237, 0.3));
    box-shadow: inset 0 -2px 0 var(--vscode-focusBorder, #007acc);
  }

  .header-cell.header-cell-selected .header-btn {
    color: var(--vscode-list-activeSelectionForeground, var(--gm-fg));
    font-weight: 700;
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

  .grid-row.row-selected > .cell {
    background: var(--vscode-list-activeSelectionBackground, rgba(100, 149, 237, 0.18));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }

  .cell.cell-col-selected {
    background: var(--vscode-list-activeSelectionBackground, rgba(100, 149, 237, 0.18));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }

  .cell.cell-selected {
    outline: 2px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -2px;
    background: var(--vscode-list-activeSelectionBackground, rgba(100, 149, 237, 0.25));
  }

  /* Intersection of selected row & column — same family as the rest of the
     selection (VS Code accent blue) but stronger, so the pivot stands out
     without breaking the colour scheme. */
  .grid-row.row-selected > .cell.cell-cross,
  .cell.cell-cross {
    background: var(--vscode-list-activeSelectionBackground, rgba(100, 149, 237, 0.55));
    color: var(--vscode-list-activeSelectionForeground, inherit);
    font-weight: 700;
    box-shadow: inset 0 0 0 2px var(--vscode-focusBorder, #007acc);
    filter: brightness(1.25) saturate(1.15);
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
    cursor: pointer;
  }

  .row-num-cell:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
    color: var(--gm-fg);
  }

  .row-num-cell.row-num-selected {
    background: var(--vscode-list-activeSelectionBackground, rgba(100, 149, 237, 0.3));
    color: var(--vscode-list-activeSelectionForeground, inherit);
    font-weight: 600;
  }

  /* ── Freeze panes ────────────────────────────────────────────────────────
     The row-number column (56px wide) is always frozen so the row index stays
     visible while scrolling horizontally. The optional first-data-column freeze
     is toggled via gridStore.freezeFirstColumn and offsets by 56px (+1 border).
     Use a slightly stronger right-edge shadow on the rightmost frozen column
     to visually separate frozen from scrolling content. */
  .row-num-cell.row-num-frozen {
    position: sticky;
    left: 0;
    z-index: 3;
  }
  /* Header row-num must beat regular header z-index too */
  .grid-header .row-num-cell.row-num-frozen {
    z-index: 4;
  }

  .header-cell.col-frozen,
  .cell.col-frozen {
    position: sticky;
    z-index: 1;
    background: var(--gm-cell-bg, var(--vscode-editor-background));
    box-shadow: 2px 0 0 0 var(--vscode-focusBorder, #007acc);
  }
  .grid-header .header-cell.col-frozen {
    z-index: 3;
    background: var(--gm-header-bg, var(--vscode-editorWidget-background));
  }

  /* Range selection rectangle. Each cell in the rectangle gets a subtle tint;
     the active cell on top of the range still shows its outline.
     Lower specificity than .cell-cross / .cell-selected so they win. */
  .cell.cell-in-range {
    background: var(--vscode-list-activeSelectionBackground, rgba(100, 149, 237, 0.18));
    color: var(--vscode-list-activeSelectionForeground, inherit);
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

  /* ── Coloured mode ──────────────────────────────────────────────────────
     When the user enables column colours, two things change:
       1. Column separators get a slightly stronger border so the pastels
          don't bleed into each other visually.
       2. Selection styles switch from a solid blue overlay (which would mix
          poorly with pastels and wash out the colour mapping) to an outline
          + underline treatment that *adds* to the cell without hiding its
          base colour. */

  .grid-root.is-coloured .cell,
  .grid-root.is-coloured .header-cell {
    border-right-color: var(--vscode-panel-border, rgba(255, 255, 255, 0.18));
    border-right-width: 1px;
    box-shadow: inset -1px 0 0 0 rgba(0, 0, 0, 0.08);
  }

  /* Row selection in coloured mode: top + bottom accent bars instead of overlay */
  .grid-root.is-coloured .grid-row.row-selected > .cell {
    background: inherit;
    color: inherit;
    box-shadow:
      inset 0 2px 0 0 var(--vscode-focusBorder, #007acc),
      inset 0 -2px 0 0 var(--vscode-focusBorder, #007acc),
      inset -1px 0 0 0 rgba(0, 0, 0, 0.08);
    filter: brightness(1.04);
  }

  /* Column selection in coloured mode: side accent bars on every cell of the column */
  .grid-root.is-coloured .cell.cell-col-selected {
    background: inherit;
    color: inherit;
    box-shadow:
      inset 2px 0 0 0 var(--vscode-focusBorder, #007acc),
      inset -2px 0 0 0 var(--vscode-focusBorder, #007acc);
    filter: brightness(1.04);
  }

  /* Cross pivot in coloured mode: full outline on top of base colour */
  .grid-root.is-coloured .grid-row.row-selected > .cell.cell-cross,
  .grid-root.is-coloured .cell.cell-cross {
    background: inherit;
    color: var(--vscode-editor-foreground, inherit);
    font-weight: 700;
    box-shadow: inset 0 0 0 2px var(--vscode-focusBorder, #007acc);
    filter: brightness(1.18) saturate(1.2);
  }

  /* Header of selected column in coloured mode: keep pastel background, just bolder bottom bar */
  .grid-root.is-coloured .header-cell.header-cell-selected {
    background: inherit;
    box-shadow: inset 0 -3px 0 var(--vscode-focusBorder, #007acc);
  }

  /* Selected single cell in coloured mode keeps the focus outline,
     but no overlay tint that would obscure the column colour */
  .grid-root.is-coloured .cell.cell-selected {
    background: inherit;
  }

  .header-cell.drag-over {
    border-left: 2px solid var(--vscode-focusBorder, #007acc);
  }

  .header-cell[draggable="true"] {
    cursor: grab;
  }
  .header-cell[draggable="true"]:active {
    cursor: grabbing;
    opacity: 0.7;
  }
</style>
