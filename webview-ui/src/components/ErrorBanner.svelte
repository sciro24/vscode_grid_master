<script lang="ts">
  import { uiStore } from '../stores/ui.svelte.js';
  interface Props { message: string; }
  let { message }: Props = $props();
</script>

<div class="error-banner" role="alert">
  <svg viewBox="0 0 16 16" width="14" height="14" style="flex-shrink:0">
    <path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z"/>
  </svg>
  <span>{message}</span>
  <button onclick={() => uiStore.setError('')}>×</button>
</div>

<style>
  .error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(220, 60, 60, 0.12);
    border-bottom: 1px solid rgba(220, 60, 60, 0.3);
    color: var(--gm-danger);
    font-size: 12px;
    flex-shrink: 0;
  }

  span { flex: 1; }

  button {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--gm-danger);
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    opacity: 0.7;
  }
  button:hover { opacity: 1; }
</style>
