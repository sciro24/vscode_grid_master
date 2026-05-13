<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
</script>

<div class="sheet-tabs" role="tablist" aria-label="Sheets">
  {#each gridStore.availableSheets as sheet}
    <button
      role="tab"
      class="sheet-tab"
      class:active={sheet === gridStore.selectedSheet}
      aria-selected={sheet === gridStore.selectedSheet}
      onclick={() => gridStore.selectSheet(sheet)}
    >{sheet}</button>
  {/each}
</div>

<style>
  .sheet-tabs {
    display: flex;
    flex-direction: row;
    flex-shrink: 0;
    overflow-x: auto;
    border-top: 1px solid var(--vscode-tab-border, var(--gm-border));
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--gm-toolbar-bg));
    scrollbar-width: thin;
  }

  .sheet-tab {
    padding: 4px 14px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    cursor: pointer;
    border: none;
    border-right: 1px solid var(--vscode-tab-border, var(--gm-border));
    background: transparent;
    color: var(--vscode-tab-inactiveForeground, var(--gm-fg-muted));
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.1s;
  }

  .sheet-tab:hover {
    background: var(--vscode-tab-hoverBackground, rgba(128,128,128,0.1));
    color: var(--vscode-tab-activeForeground, var(--gm-fg));
  }

  .sheet-tab.active {
    background: var(--vscode-tab-activeBackground, var(--gm-bg));
    color: var(--vscode-tab-activeForeground, var(--gm-fg));
    border-bottom: 2px solid var(--vscode-focusBorder, var(--gm-accent));
  }
</style>
