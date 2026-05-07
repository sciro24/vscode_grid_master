<script lang="ts">
  interface Props {
    message?: string;
    progress?: number;
  }
  let { message = 'Loading…', progress }: Props = $props();
</script>

<div class="loading-overlay">
  <div class="loading-card">
    <div class="spinner"></div>
    <p class="loading-message">{message}</p>
    {#if progress !== undefined}
      <div class="progress-track">
        <div class="progress-fill" style="width: {progress}%"></div>
      </div>
      <span class="progress-label">{progress}%</span>
    {/if}
  </div>
</div>

<style>
  .loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--gm-bg);
    z-index: 10;
  }

  .loading-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 2px solid var(--gm-border);
    border-top-color: var(--gm-accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-message {
    font-size: 13px;
    color: var(--gm-fg-muted);
    margin: 0;
  }

  .progress-track {
    width: 200px;
    height: 3px;
    background: var(--gm-border);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--gm-accent);
    transition: width 0.2s ease;
    border-radius: 2px;
  }

  .progress-label {
    font-size: 11px;
    color: var(--gm-fg-muted);
  }
</style>
