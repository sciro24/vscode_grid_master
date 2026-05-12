<script lang="ts">
  import { tick } from 'svelte';
  import { gridStore } from '../stores/grid.svelte.js';

  interface Props {
    colIndex: number;
    anchor: { x: number; y: number };
    onClose: () => void;
    onShowStats?: (colIndex: number) => void;
  }

  let { colIndex, anchor, onClose, onShowStats }: Props = $props();

  const col = $derived(gridStore.schema[colIndex]);
  const isCsv = $derived(gridStore.fileType === 'csv');
  const frozenCols = $derived(gridStore.frozenCols);
  const isCurrentlyFrozen = $derived(frozenCols.has(colIndex));
  const isSorted = $derived(gridStore.sort?.colIndex === colIndex);
  const sortDir = $derived(gridStore.sort?.direction);

  // Inline rename state
  let renaming = $state(false);
  let renameValue = $state('');
  let renameInputEl: HTMLInputElement | null = $state(null);

  function act(fn: () => void) { fn(); onClose(); }

  function showStats() {
    onShowStats?.(colIndex);
    onClose();
  }

  // Track whether the user is interacting with the rename input. While true,
  // the global click-outside handler must not close the menu.
  let suppressOutsideClose = $state(false);

  async function startRename(e?: MouseEvent) {
    // Stop the click from bubbling to the window listener that may close the menu.
    e?.stopPropagation();
    suppressOutsideClose = true;
    renameValue = col?.name ?? '';
    renaming = true;
    await tick();   // wait for the input to actually be mounted
    renameInputEl?.focus();
    renameInputEl?.select();
  }

  function commitRename() {
    if (!renaming) return;
    suppressOutsideClose = false;
    const trimmed = renameValue.trim();
    const currentName = col?.name ?? '';
    if (trimmed === '' || trimmed === currentName) {
      // Nothing to do; just exit edit mode and keep the menu open.
      renaming = false;
      return;
    }
    const ok = gridStore.renameColumn(colIndex, trimmed);
    renaming = false;
    if (ok) onClose();
  }

  function cancelRename() {
    suppressOutsideClose = false;
    renaming = false;
  }

  function onRenameKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  }

  function handleClickOutside(e: MouseEvent) {
    if (suppressOutsideClose) return;
    if (!(e.target as Element).closest('.column-menu')) onClose();
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div
  class="column-menu"
  style="left: {anchor.x}px; top: {anchor.y}px;"
  role="menu"
  tabindex="-1"
>
  <div class="menu-header">
    {#if renaming}
      <input
        class="rename-input"
        bind:this={renameInputEl}
        bind:value={renameValue}
        onkeydown={onRenameKey}
        onblur={commitRename}
        onclick={(ev) => ev.stopPropagation()}
        onmousedown={(ev) => ev.stopPropagation()}
        placeholder="Column name"
        aria-label="Rename column"
      />
    {:else}
      {col?.name ?? `Column ${colIndex}`}
    {/if}
  </div>

  {#if isCsv && !renaming}
    <div class="menu-section">
      <button class="menu-item" onclick={(ev) => startRename(ev)}>
        <span class="menu-icon">✎</span> Rename column
      </button>
    </div>
    <div class="menu-divider"></div>
  {/if}

  <div class="menu-section">
    <button class="menu-item" onclick={() => act(() => gridStore.setSort({ colIndex, direction: 'asc' }))} class:active={isSorted && sortDir === 'asc'}>
      <span class="menu-icon">↑</span> Sort A → Z
    </button>
    <button class="menu-item" onclick={() => act(() => gridStore.setSort({ colIndex, direction: 'desc' }))} class:active={isSorted && sortDir === 'desc'}>
      <span class="menu-icon">↓</span> Sort Z → A
    </button>
    {#if isSorted}
      <button class="menu-item" onclick={() => act(() => gridStore.setSort(null))}>
        <span class="menu-icon">✕</span> Clear sort
      </button>
    {/if}
  </div>

  <div class="menu-divider"></div>

  <div class="menu-section">
    <button class="menu-item" onclick={() => act(() => gridStore.setFilter({ colIndex, op: 'is_not_null', value: '' }))}>
      <span class="menu-icon">⊟</span> Filter by this column
    </button>
    <button class="menu-item" onclick={() => act(() => gridStore.copyColumnToClipboard(colIndex))}>
      <span class="menu-icon">⎘</span> Copy column
    </button>
    <button class="menu-item" onclick={showStats}>
      <span class="menu-icon">∑</span> Column statistics
    </button>
  </div>

  {#if isCsv}
    <div class="menu-divider"></div>
    <div class="menu-section">
      <button class="menu-item" onclick={() => act(() => gridStore.duplicateColumn(colIndex))}>
        <span class="menu-icon">⿻</span> Duplicate column
      </button>
    </div>
  {/if}

  <div class="menu-divider"></div>

  <div class="menu-section">
    {#if isCurrentlyFrozen}
      <button class="menu-item" onclick={() => act(() => gridStore.toggleFreezeCol(colIndex))}>
        <span class="menu-icon">📌</span> Unfreeze column
      </button>
      {#if frozenCols.size > 1}
        <button class="menu-item" onclick={() => act(() => gridStore.unfreezeAllCols())}>
          <span class="menu-icon">✕</span> Unfreeze all columns
        </button>
      {/if}
    {:else}
      <button class="menu-item" onclick={() => act(() => gridStore.toggleFreezeCol(colIndex))}>
        <span class="menu-icon">📌</span> Freeze column
      </button>
    {/if}
  </div>

  <div class="menu-divider"></div>

  <div class="menu-section">
    <button class="menu-item" onclick={() => act(() => gridStore.toggleColumnVisibility(colIndex))}>
      <span class="menu-icon">○</span> Hide column
    </button>
    {#if isCsv}
      <button class="menu-item danger" onclick={() => act(() => gridStore.deleteColumn(colIndex))}>
        <span class="menu-icon">✕</span> Delete column
      </button>
    {/if}
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename-input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder, #007acc);
    border-radius: 3px;
    padding: 3px 6px;
    font-size: 12px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    outline: none;
    box-sizing: border-box;
  }

  .menu-section {
    padding: 4px 0;
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
</style>
