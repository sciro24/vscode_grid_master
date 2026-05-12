<script lang="ts">
  import { postMessage } from '../bridge/vscode.js';
  import { uiStore } from '../stores/ui.svelte.js';

  interface Props {
    fileSizeMb: number;
  }
  let { fileSizeMb }: Props = $props();

  function confirm() {
    uiStore.setLargeFileWarning(null);
    postMessage({ type: 'LARGE_FILE_OPEN_CONFIRM' });
  }

  function cancel() {
    uiStore.setLargeFileWarning(null);
    postMessage({ type: 'LARGE_FILE_OPEN_CANCEL' });
  }
</script>

<div class="warning-overlay">
  <div class="warning-card">
    <div class="warning-icon">⚠</div>
    <p class="warning-title">Large file</p>
    <p class="warning-body">
      This file is <strong>{fileSizeMb} MB</strong>. Opening it may take a while
      and use significant memory.
    </p>
    <div class="warning-actions">
      <button class="btn btn-secondary" onclick={cancel}>Cancel</button>
      <button class="btn btn-primary" onclick={confirm}>Open anyway</button>
    </div>
  </div>
</div>

<style>
  .warning-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--gm-bg);
    z-index: 20;
  }

  .warning-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 28px 32px;
    background: var(--gm-toolbar-bg);
    border: 1px solid var(--gm-border);
    border-radius: 6px;
    max-width: 340px;
    text-align: center;
  }

  .warning-icon {
    font-size: 32px;
    line-height: 1;
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  .warning-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--gm-fg);
  }

  .warning-body {
    margin: 0;
    font-size: 12px;
    color: var(--gm-fg-muted);
    line-height: 1.5;
  }

  .warning-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .btn {
    padding: 5px 14px;
    border-radius: 3px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--gm-border);
    font-family: var(--vscode-font-family);
  }

  .btn-secondary {
    background: transparent;
    color: var(--gm-fg-muted);
  }

  .btn-secondary:hover {
    background: var(--gm-hover-bg);
    color: var(--gm-fg);
  }

  .btn-primary {
    background: var(--gm-accent);
    color: var(--vscode-button-foreground, #fff);
    border-color: transparent;
  }

  .btn-primary:hover {
    background: var(--gm-accent-hover);
  }
</style>
