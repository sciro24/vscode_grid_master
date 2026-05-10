<script lang="ts">
  import { gridStore, type DatasetReport } from '../stores/grid.svelte.js';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  const report = $derived<DatasetReport | null>(gridStore.computeDatasetStats());

  function fmt(n: number | undefined): string {
    if (n === undefined || !isFinite(n)) return '—';
    if (Number.isInteger(n)) return n.toLocaleString('en-US', { useGrouping: false });
    return n.toLocaleString('en-US', { maximumFractionDigits: 4, useGrouping: false });
  }

  function fmtPct(p: number): string {
    return p.toFixed(1) + '%';
  }
</script>

<div class="overlay" onclick={onClose} role="presentation" aria-hidden="true"></div>

<div class="stats-panel" role="dialog" aria-label="Dataset statistics">
  <button class="close-btn" onclick={onClose} aria-label="Close">×</button>

  {#if !report}
    <div class="msg">
      <strong>Dataset statistics not available</strong>
      <p>Statistics need the full dataset in memory. For Parquet/Arrow files in lazy mode (>100k rows) the data is streamed on demand and full-dataset stats are not yet computed.</p>
    </div>
  {:else}
    <div class="header">
      <div class="title">Dataset overview</div>
      <div class="filename">{gridStore.fileName}</div>
    </div>

    <div class="overview">
      <div class="stat">
        <div class="stat-label">Rows</div>
        <div class="stat-val">{fmt(report.totalRows)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Columns</div>
        <div class="stat-val">{fmt(report.totalCols)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Cells</div>
        <div class="stat-val">{fmt(report.totalCells)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Nulls</div>
        <div class="stat-val">{fmt(report.nullCells)}</div>
        <div class="stat-sub">{fmtPct(report.nullPct)}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Column types</div>
      <div class="type-bar">
        {#each Object.entries(report.typeCounts) as [type, count]}
          {@const pct = (count / report.totalCols) * 100}
          <div class="type-seg type-{type}" style="width: {pct}%;" title="{type}: {count} ({fmtPct(pct)})">
            {#if pct > 12}{type} · {count}{/if}
          </div>
        {/each}
      </div>
      <div class="type-legend">
        {#each Object.entries(report.typeCounts) as [type, count]}
          <span class="legend-item">
            <span class="legend-dot type-{type}"></span>
            {type} ({count})
          </span>
        {/each}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Per-column summary</div>
      <div class="table-wrap">
        <table class="cols-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Type</th>
              <th>Nulls</th>
              <th>Distinct</th>
              <th>Min</th>
              <th>Max</th>
              <th>Mean</th>
            </tr>
          </thead>
          <tbody>
            {#each report.columns as c}
              <tr>
                <td class="dim">{c.index + 1}</td>
                <td class="cname" title={c.name}>{c.name}</td>
                <td><span class="type-badge type-{c.type}">{c.type}</span></td>
                <td class="num">
                  {fmt(c.nulls)}
                  <span class="dim">({fmtPct(c.nullPct)})</span>
                </td>
                <td class="num">{fmt(c.distinct)}</td>
                <td class="num">{fmt(c.min)}</td>
                <td class="num">{fmt(c.max)}</td>
                <td class="num">{fmt(c.mean)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
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
    width: min(820px, 94vw);
    max-height: 90vh;
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
    margin-bottom: 14px;
    padding-right: 28px;
  }
  .title { font-size: 15px; font-weight: 600; }
  .filename {
    font-size: 11px;
    color: var(--gm-fg-muted);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overview {
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
    font-size: 18px;
    font-weight: 600;
    margin-top: 2px;
  }
  .stat-sub {
    font-size: 10px;
    color: var(--gm-fg-muted);
    margin-top: 2px;
  }

  .section { margin-top: 14px; }

  .section-title {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--gm-fg-muted);
    letter-spacing: 0.05em;
    margin-bottom: 8px;
    font-weight: 600;
  }

  .type-bar {
    display: flex;
    width: 100%;
    height: 22px;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid var(--gm-border);
  }

  .type-seg {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--gm-fg);
    overflow: hidden;
    white-space: nowrap;
    transition: filter 0.15s;
  }
  .type-seg:hover { filter: brightness(1.15); }

  .type-string  { background: var(--gm-type-string-bg, #4a9eff44); color: var(--gm-type-string-fg, #cfe6ff); }
  .type-number  { background: var(--gm-type-number-bg, #6abf6944); color: var(--gm-type-number-fg, #d2f0c8); }
  .type-boolean { background: var(--gm-type-bool-bg, #d18a4744);   color: var(--gm-type-bool-fg, #ffd9b0); }
  .type-date    { background: var(--gm-type-date-bg, #b97acc44);   color: var(--gm-type-date-fg, #e8c8f3); }

  .type-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 6px;
    font-size: 11px;
  }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-dot {
    width: 10px; height: 10px; border-radius: 2px;
    display: inline-block;
  }

  .table-wrap {
    border: 1px solid var(--gm-border);
    border-radius: 6px;
    overflow-x: auto;
  }

  .cols-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }

  .cols-table th, .cols-table td {
    padding: 5px 8px;
    text-align: left;
    border-bottom: 1px solid var(--gm-border);
    white-space: nowrap;
  }

  .cols-table th {
    background: var(--gm-header-bg, var(--vscode-editorWidget-background));
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--gm-fg-muted);
    letter-spacing: 0.05em;
  }

  .cols-table tbody tr:hover {
    background: var(--gm-hover-bg, var(--vscode-list-hoverBackground));
  }

  .cols-table tbody tr:last-child td { border-bottom: none; }

  .num {
    text-align: right;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .cname {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dim {
    color: var(--gm-fg-muted);
    font-size: 10px;
  }

  .type-badge {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .msg {
    padding: 10px;
    color: var(--gm-fg-muted);
    line-height: 1.5;
  }
  .msg p { margin: 6px 0 0; font-size: 11px; }
</style>
