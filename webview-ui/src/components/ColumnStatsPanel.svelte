<script lang="ts">
  import { gridStore, type ColumnReport } from '../stores/grid.svelte.js';

  interface Props {
    colIndex: number;
    onClose: () => void;
  }

  let { colIndex, onClose }: Props = $props();

  const report = $derived<ColumnReport | null>(gridStore.computeColumnStats(colIndex));

  function fmt(n: number): string {
    if (!isFinite(n)) return String(n);
    if (Number.isInteger(n)) return n.toLocaleString('en-US', { useGrouping: false });
    return n.toLocaleString('en-US', { maximumFractionDigits: 4, useGrouping: false });
  }

  function pct(part: number, total: number): string {
    if (total === 0) return '0%';
    return ((part / total) * 100).toFixed(1) + '%';
  }

  // Top distribution bar widths (relative to most common value)
  const topMax = $derived(report?.top[0]?.count ?? 1);
  const histMax = $derived(report?.numeric ? Math.max(...report.numeric.histogram.map(b => b.count), 1) : 1);

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" onclick={onClose} role="presentation" aria-hidden="true"></div>

<div class="stats-panel" role="dialog" aria-label="Column statistics">
  <button class="close-btn" onclick={onClose} aria-label="Close">×</button>

  {#if !report}
    <div class="msg">
      <strong>Statistics not available</strong>
      <p>Column statistics are computed in-memory. For Parquet/Arrow/JSON/Excel files larger than 100k rows, only chunks loaded so far are available — try scrolling through the column first.</p>
    </div>
  {:else}
    <div class="header">
      <div class="title">{report.name}</div>
      <span class="type-badge type-{report.type}">{report.type}</span>
    </div>

    <div class="grid-overview">
      <div class="stat">
        <div class="stat-label">Total</div>
        <div class="stat-val">{fmt(report.total)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Distinct</div>
        <div class="stat-val">{fmt(report.distinct)}</div>
        <div class="stat-sub">{pct(report.distinct, report.total)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Null</div>
        <div class="stat-val">{fmt(report.nulls)}</div>
        <div class="stat-sub">{pct(report.nulls, report.total)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Filled</div>
        <div class="stat-val">{fmt(report.total - report.nulls)}</div>
        <div class="stat-sub">{pct(report.total - report.nulls, report.total)}</div>
      </div>
    </div>

    {#if report.numeric}
      <div class="section">
        <div class="section-title">Numeric summary</div>
        <div class="num-grid">
          <div><span class="lbl">min</span><span class="val">{fmt(report.numeric.min)}</span></div>
          <div><span class="lbl">max</span><span class="val">{fmt(report.numeric.max)}</span></div>
          <div><span class="lbl">mean</span><span class="val">{fmt(report.numeric.mean)}</span></div>
          <div><span class="lbl">median</span><span class="val">{fmt(report.numeric.median)}</span></div>
          <div><span class="lbl">stddev</span><span class="val">{fmt(report.numeric.stddev)}</span></div>
          <div><span class="lbl">sum</span><span class="val">{fmt(report.numeric.sum)}</span></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Distribution</div>
        <div class="histogram">
          {#each report.numeric.histogram as bin}
            <div class="hist-row" title="{fmt(bin.from)} – {fmt(bin.to)}: {bin.count}">
              <span class="hist-range">{fmt(bin.from)}</span>
              <div class="hist-track">
                <div class="hist-bar" style="width: {(bin.count / histMax) * 100}%;"></div>
              </div>
              <span class="hist-count">{fmt(bin.count)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if report.top.length > 0}
      <div class="section">
        <div class="section-title">Top values</div>
        <div class="top-list">
          {#each report.top as t}
            <div class="top-row" title={t.value}>
              <span class="top-val">{t.value || '∅'}</span>
              <div class="top-track">
                <div class="top-bar" style="width: {(t.count / topMax) * 100}%;"></div>
              </div>
              <span class="top-count">{fmt(t.count)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 999;
  }

  .stats-panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1000;
    width: min(560px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    background: var(--gm-menu-bg, var(--vscode-editorWidget-background));
    border: 1px solid var(--gm-border, var(--vscode-panel-border));
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    padding: 18px 22px 22px;
    color: var(--gm-fg, var(--vscode-editor-foreground));
    font-size: 12px;
  }

  .close-btn {
    position: absolute;
    top: 6px;
    right: 8px;
    background: none;
    border: none;
    color: var(--gm-fg-muted);
    font-size: 22px;
    cursor: pointer;
    line-height: 1;
    padding: 4px 8px;
  }
  .close-btn:hover { color: var(--gm-fg); }

  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    padding-right: 28px;
  }

  .title {
    font-size: 15px;
    font-weight: 600;
  }

  .type-badge {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .type-string  { background: var(--gm-type-string-bg);  color: var(--gm-type-string-fg); }
  .type-number  { background: var(--gm-type-number-bg);  color: var(--gm-type-number-fg); }
  .type-boolean { background: var(--gm-type-bool-bg);    color: var(--gm-type-bool-fg); }
  .type-date    { background: var(--gm-type-date-bg);    color: var(--gm-type-date-fg); }

  .grid-overview {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-bottom: 14px;
  }

  .stat {
    background: var(--vscode-input-background, rgba(255,255,255,0.04));
    border: 1px solid var(--gm-border);
    border-radius: 6px;
    padding: 8px 10px;
    text-align: center;
  }

  .stat-label {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--gm-fg-muted);
    letter-spacing: 0.05em;
  }

  .stat-val {
    font-size: 16px;
    font-weight: 600;
    margin-top: 2px;
  }

  .stat-sub {
    font-size: 10px;
    color: var(--gm-fg-muted);
    margin-top: 2px;
  }

  .section {
    margin-top: 14px;
  }

  .section-title {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--gm-fg-muted);
    letter-spacing: 0.05em;
    margin-bottom: 8px;
    font-weight: 600;
  }

  .num-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px 16px;
  }

  .num-grid > div {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    border-bottom: 1px dotted var(--gm-border);
  }

  .lbl {
    color: var(--gm-fg-muted);
    text-transform: uppercase;
    font-size: 10px;
  }

  .val {
    font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 500;
  }

  .histogram, .top-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .hist-row, .top-row {
    display: grid;
    grid-template-columns: 90px 1fr 60px;
    gap: 8px;
    align-items: center;
  }

  .hist-range, .top-val {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--gm-fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist-track, .top-track {
    background: var(--gm-border, rgba(255,255,255,0.08));
    height: 14px;
    border-radius: 2px;
    overflow: hidden;
  }

  .hist-bar {
    height: 100%;
    background: var(--vscode-charts-blue, #4a9eff);
    transition: width 0.2s;
  }

  .top-bar {
    height: 100%;
    background: var(--vscode-charts-green, #6abf69);
    transition: width 0.2s;
  }

  .hist-count, .top-count {
    text-align: right;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--gm-fg);
  }

  .msg {
    padding: 10px;
    color: var(--gm-fg-muted);
    line-height: 1.5;
  }

  .msg p {
    margin: 6px 0 0;
    font-size: 11px;
  }
</style>
