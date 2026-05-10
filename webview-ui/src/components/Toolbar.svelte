<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import { uiStore } from '../stores/ui.svelte.js';
  import { postMessage } from '../bridge/vscode.js';
  import DatasetStatsPanel from './DatasetStatsPanel.svelte';

  let searchInput = $state('');
  let showColumnPanel = $state(false);
  let showDatasetStats = $state(false);

  function handleSearch(e: Event) {
    const q = (e.target as HTMLInputElement).value;
    searchInput = q;
    gridStore.setGlobalSearch(q);
  }

  function handleSave() {
    if (gridStore.fileType === 'csv') {
      const content = gridStore.serializeCsv();
      if (content === null) return;
      // Host writes the bytes and replies with SAVE_ACK; we optimistically clear
      // the edit history so the dirty indicator updates immediately.
      postMessage({ type: 'SAVE_DATA', payload: { content } });
    } else {
      // Non-CSV formats: edits live in-memory only. Just notify the host so it
      // can clear its dirty flag (no real write-back yet).
      postMessage({ type: 'SAVE' });
    }
    gridStore.clearEditHistory();
  }

  function handleUndo() {
    gridStore.undoLastEdit();
  }

  function handleDiscard() {
    gridStore.discardAllEdits();
  }

  function handleExport() {
    postMessage({
      type: 'EXPORT',
      payload: { format: 'csv', includeHeaders: true },
    });
  }

  function clearFilters() {
    gridStore.clearFilters();
  }

  // Clicking anywhere in the toolbar (background or non-interactive area)
  // clears the row/column/cell selection — same behaviour as VS Code.
  // Buttons and the search input have their own onclick handlers that stop
  // propagation here only if needed; otherwise it's harmless to also clear
  // selection when pressing a toolbar button (selection isn't tied to it).
  function onToolbarClick() {
    gridStore.clearSelection();
  }

  const hasFilters = $derived(gridStore.filters.length > 0);
  const fileName = $derived(gridStore.fileName);
  const isDirty = $derived(uiStore.isDirty);
  const colorsActive = $derived(gridStore.colColors.size > 0);
  const canUndo = $derived(gridStore.editCount > 0);
  const freezeFirstCol = $derived(gridStore.freezeFirstColumn);
</script>

<div class="toolbar" onclick={onToolbarClick} role="presentation">
  <div class="toolbar-left">
    <span class="file-name" title={fileName}>
      {fileName}
      {#if isDirty}<span class="dirty-dot" title="Unsaved changes">●</span>{/if}
    </span>
  </div>

  <div class="toolbar-center">
    <div class="search-box">
      <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14">
        <path fill="currentColor" d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
      </svg>
      <input
        type="text"
        placeholder="Search…"
        value={searchInput}
        oninput={handleSearch}
        class="search-input"
      />
      {#if searchInput}
        <button class="clear-btn" onclick={() => { searchInput = ''; gridStore.setGlobalSearch(''); }}>×</button>
      {/if}
    </div>
  </div>

  <div class="toolbar-right">
    {#if hasFilters}
      <button class="btn btn-ghost" onclick={clearFilters} title="Clear all filters">
        <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M.36 0h15.28l-5.98 7.97V16l-3.32-1.66V7.97L.36 0z"/></svg>
        Clear filters
      </button>
    {/if}

    <button
      class="btn btn-ghost"
      class:btn-active={colorsActive}
      onclick={() => gridStore.toggleColColors()}
      title={colorsActive ? 'Remove column colors' : 'Color columns'}
    >
      <!-- Palette icon -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
        <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5a6.5 6.5 0 0 1 6.5 6.5c0 1.1-.9 2-2 2a2 2 0 0 1-1.41-.59l-.01-.01A2 2 0 0 0 9.5 9a2 2 0 0 0-2 2 .5.5 0 0 1-.5.5A6.5 6.5 0 0 1 1.5 8 6.5 6.5 0 0 1 8 1.5zM5 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM6.5 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>
      </svg>
    </button>

    <button
      class="btn btn-ghost"
      onclick={() => showDatasetStats = true}
      title="Dataset statistics — distribution and per-column summary"
    >
      <!-- Bar chart icon -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
        <path d="M2 13h2v-3H2v3zm3.5 0h2V7h-2v6zm3.5 0h2V4H9v9zm3.5 0h2V1h-2v12zM1 14.5h14V16H1v-1.5z"/>
      </svg>
    </button>

    <button
      class="btn btn-ghost"
      class:btn-active={freezeFirstCol}
      onclick={() => gridStore.toggleFreezeFirstColumn()}
      title={freezeFirstCol ? 'Unfreeze first column' : 'Freeze first column (keep it visible while scrolling)'}
    >
      <!-- Pin/snowflake icon -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
        <path d="M8 0v4M8 12v4M0 8h4M12 8h4M2.3 2.3l2.8 2.8M10.9 10.9l2.8 2.8M2.3 13.7l2.8-2.8M10.9 5.1l2.8-2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>
        <circle cx="8" cy="8" r="1.6"/>
      </svg>
    </button>

    <div class="col-panel-wrap">
      <button class="btn btn-ghost" onclick={() => showColumnPanel = !showColumnPanel} title="Show / hide columns">
        <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M0 2h4v12H0V2zm6 0h4v12H6V2zm6 0h4v12h-4V2z"/></svg>
      </button>
      {#if showColumnPanel}
        <div class="col-panel" role="dialog">
          <div class="col-panel-header">Columns</div>
          <div class="col-panel-body">
            {#each gridStore.schema as col (col.index)}
              <label class="col-row">
                <input
                  type="checkbox"
                  checked={!gridStore.hiddenCols.has(col.index)}
                  onchange={() => gridStore.toggleColumnVisibility(col.index)}
                />
                <span class="col-name">{col.name}</span>
                <span class="col-type">{col.inferredType}</span>
              </label>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <button class="btn btn-ghost" onclick={handleExport} title="Export">
      <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 12l-4-4h2.5V2h3v6H12L8 12zM1 14h14v1.5H1V14z"/></svg>
    </button>

    {#if canUndo}
      <button class="btn btn-ghost" onclick={handleUndo} title="Undo last edit">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M5.7 4.3a1 1 0 0 1 0 1.4L4.4 7H10a4 4 0 0 1 0 8H7a1 1 0 0 1 0-2h3a2 2 0 0 0 0-4H4.4l1.3 1.3a1 1 0 1 1-1.4 1.4l-3-3a1 1 0 0 1 0-1.4l3-3a1 1 0 0 1 1.4 0z"/>
        </svg>
        Undo
      </button>
    {/if}

    {#if isDirty}
      <button class="btn btn-ghost btn-discard" onclick={handleDiscard} title="Discard all changes">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M5 1h6v1h4v2H1V2h4V1zm-2 4h10l-1 10H4L3 5z"/>
        </svg>
        Don't save
      </button>

      <button class="btn btn-primary" onclick={handleSave}>
        Save
      </button>
    {/if}
  </div>
</div>

{#if showDatasetStats}
  <DatasetStatsPanel onClose={() => showDatasetStats = false} />
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--gm-toolbar-bg);
    border-bottom: 1px solid var(--gm-border);
    min-height: 38px;
    flex-shrink: 0;
  }

  .toolbar-left {
    flex: 0 0 auto;
    min-width: 0;
  }

  .toolbar-center {
    flex: 1;
    display: flex;
    justify-content: center;
  }

  .toolbar-right {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .file-name {
    font-size: 12px;
    color: var(--gm-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  .dirty-dot {
    color: var(--gm-accent);
    margin-left: 4px;
    font-size: 10px;
  }

  .search-box {
    display: flex;
    align-items: center;
    background: var(--gm-input-bg);
    border: 1px solid var(--gm-border);
    border-radius: 4px;
    padding: 0 8px;
    gap: 6px;
    height: 26px;
    min-width: 220px;
    max-width: 400px;
    width: 100%;
    transition: border-color 0.15s;
  }

  .search-box:focus-within {
    border-color: var(--gm-accent);
  }

  .search-icon {
    color: var(--gm-fg-muted);
    flex-shrink: 0;
  }

  .search-input {
    border: none;
    background: transparent;
    color: var(--gm-fg);
    font-size: 12px;
    outline: none;
    flex: 1;
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--gm-fg-muted);
  }

  .clear-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--gm-fg-muted);
    font-size: 16px;
    line-height: 1;
    padding: 0;
    display: flex;
    align-items: center;
  }

  .clear-btn:hover { color: var(--gm-fg); }

  .btn {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    border: none;
    transition: background 0.12s;
    height: 26px;
    white-space: nowrap;
  }

  .btn-ghost {
    background: transparent;
    color: var(--gm-fg-muted);
  }

  .btn-ghost:hover {
    background: var(--gm-hover-bg);
    color: var(--gm-fg);
  }

  .btn-primary {
    background: var(--gm-accent);
    color: var(--vscode-button-foreground, #fff);
  }

  .btn-primary:hover {
    background: var(--gm-accent-hover);
  }

  .btn-active {
    color: var(--gm-accent, var(--vscode-focusBorder));
    background: var(--gm-hover-bg, var(--vscode-list-hoverBackground));
  }

  .btn-discard {
    color: var(--vscode-errorForeground, #f48771);
  }

  .btn-discard:hover {
    background: var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.15));
  }

  .col-panel-wrap {
    position: relative;
  }

  .col-panel {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 220px;
    max-height: 360px;
    background: var(--gm-toolbar-bg, var(--vscode-editorWidget-background));
    border: 1px solid var(--gm-border, var(--vscode-panel-border));
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 10;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .col-panel-header {
    padding: 6px 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--gm-fg-muted);
    border-bottom: 1px solid var(--gm-border, var(--vscode-panel-border));
  }

  .col-panel-body {
    overflow-y: auto;
    padding: 4px 0;
  }

  .col-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
  }

  .col-row:hover {
    background: var(--gm-hover-bg, var(--vscode-list-hoverBackground));
  }

  .col-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .col-type {
    font-size: 10px;
    opacity: 0.6;
    text-transform: uppercase;
  }
</style>
