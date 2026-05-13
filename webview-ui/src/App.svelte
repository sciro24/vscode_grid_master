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
  import LargeFileWarning from './components/LargeFileWarning.svelte';
  import ErrorBanner from './components/ErrorBanner.svelte';
  import NoticeBanner from './components/NoticeBanner.svelte';

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
  const memoryTruncated = $derived(gridStore.rowCapWarning === 'memory');
</script>

<div class="app-shell">
  {#if uiStore.error}
    <ErrorBanner message={uiStore.error} />
  {/if}

  {#if memoryTruncated}
    <NoticeBanner message="Truncated due to memory limits. The grid stopped loading additional rows to keep the session stable." />
  {/if}

  {#if uiStore.parseWarnings !== null}
    <NoticeBanner
      message="{uiStore.parseWarnings.length} parse warning{uiStore.parseWarnings.length === 1 ? '' : 's'} — rows may have missing fields. First: {uiStore.parseWarnings[0]?.message ?? ''}"
      onDismiss={() => uiStore.setParseWarnings(null)}
    />
  {/if}

  <Toolbar />

  {#if hasFilters}
    <FilterBar />
  {/if}

  <div class="grid-area">
    {#if uiStore.largeFileWarning !== null}
      <LargeFileWarning fileSizeMb={uiStore.largeFileWarning.fileSizeMb} />
    {:else if uiStore.loading}
      <!-- Keep LoadingOverlay for entire duration — during streaming this covers
           the partially-loaded grid so the user sees clean progress, not a flickering grid. -->
      <LoadingOverlay
        message={uiStore.streamProgress !== undefined
          ? `Loading… ${uiStore.streamProgress}% · ${gridStore.totalRows.toLocaleString('en-US')} rows`
          : uiStore.loadingMessage}
        progress={uiStore.streamProgress ?? uiStore.loadingProgress}
      />
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

  .stream-progress-bar {
    height: 3px;
    background: var(--gm-border);
    flex-shrink: 0;
    overflow: hidden;
  }

  .stream-progress-fill {
    height: 100%;
    background: var(--gm-success);
    transition: width 0.3s ease;
  }

  .stream-progress-toast {
    position: absolute;
    bottom: 32px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--gm-toolbar-bg, var(--vscode-editorWidget-background));
    border: 1px solid var(--gm-border, var(--vscode-panel-border));
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    font-size: 11px;
    color: var(--gm-fg-muted);
    z-index: 5;
    pointer-events: none;
  }

  .stream-toast-spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid var(--gm-border);
    border-top-color: var(--gm-accent, var(--vscode-focusBorder));
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
