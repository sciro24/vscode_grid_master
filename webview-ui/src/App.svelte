<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { setupMessageHandler } from './bridge/messageHandler.js';
  import { postMessage } from './bridge/vscode.js';
  import { gridStore } from './stores/grid.svelte.js';
  import { uiStore } from './stores/ui.svelte.js';
  import Toolbar from './components/Toolbar.svelte';
  import FilterBar from './components/FilterBar.svelte';
  import DataGrid from './components/DataGrid.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import LoadingOverlay from './components/LoadingOverlay.svelte';
  import ErrorBanner from './components/ErrorBanner.svelte';

  let teardown: (() => void) | null = null;

  onMount(() => {
    console.log('[GridMaster] App.onMount, build=', (window as any).__GM_BUILD__);
    teardown = setupMessageHandler();
    postMessage({ type: 'READY' });
    console.log('[GridMaster] READY sent');
  });

  onDestroy(() => teardown?.());

  const hasData = $derived(gridStore.schema.length > 0);
  const hasFilters = $derived(gridStore.filters.length > 0);
</script>

<div class="app-shell">
  {#if uiStore.error}
    <ErrorBanner message={uiStore.error} />
  {/if}

  <Toolbar />

  {#if hasFilters}
    <FilterBar />
  {/if}

  <div class="grid-area">
    {#if uiStore.loading && !hasData}
      <LoadingOverlay message={uiStore.loadingMessage} progress={uiStore.loadingProgress} />
    {:else if hasData}
      <DataGrid />
    {:else}
      <div class="empty-state">
        <span class="empty-icon">⊞</span>
        <p>Open a CSV, TSV, Parquet, Arrow, JSON or JSONL file to get started.</p>
      </div>
    {/if}
  </div>

  <StatusBar />
</div>

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100%;
    overflow: hidden;
    background: var(--gm-bg);
    color: var(--gm-fg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }

  .grid-area {
    flex: 1;
    overflow: hidden;
    position: relative;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--gm-fg-muted);
  }

  .empty-icon {
    font-size: 48px;
    opacity: 0.3;
  }
</style>
