<script lang="ts">
  interface Props { message: string; onDismiss?: () => void; }
  let { message, onDismiss }: Props = $props();
</script>

<div class="notice-banner" role="status">
  <svg viewBox="0 0 16 16" width="14" height="14" style="flex-shrink:0">
    <path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z"/>
  </svg>
  <span>{message}</span>
  {#if onDismiss}
    <button class="dismiss-btn" onclick={onDismiss} aria-label="Dismiss">×</button>
  {/if}
</div>

<style>
  .notice-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--vscode-inputValidation-warningBackground, rgba(255, 204, 102, 0.2));
    border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 204, 102, 0.4));
    color: var(--vscode-inputValidation-warningForeground, var(--gm-fg));
    font-size: 12px;
    flex-shrink: 0;
  }

  span { flex: 1; }

  .dismiss-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    opacity: 0.7;
    flex-shrink: 0;
  }

  .dismiss-btn:hover { opacity: 1; }
</style>
