# Grid Master

A fast, in-editor spreadsheet for tabular data files. Open **CSV**, **TSV**, **Parquet**, **Arrow / Feather**, **JSON** and **JSONL / NDJSON** files as an interactive grid — without ever leaving VS Code.

Powered by [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview), [Svelte 5](https://svelte.dev/) and a virtualised renderer that stays smooth on files with hundreds of thousands of rows.

---

## Features

- **Multiple formats out of the box** — `.csv`, `.tsv`, `.parquet`, `.parq`, `.arrow`, `.feather`, `.jsonl`, `.ndjson`. Open `.json` files via right-click → *Open with Grid Master*.
- **Virtualised grid** — only visible rows are rendered, so 1M-row Parquet files scroll at 60 fps.
- **Click-to-sort** on any column header (asc / desc / unsorted).
- **Global search** across every cell, with live row-count update.
- **Inline editing** — double-click any cell to edit. Per-edit **Undo** and a single-click **Discard all changes** button.
- **Drag-to-resize** column borders, plus auto-fit widths computed from the data on load.
- **Column color coding** — toggle a muted pastel palette to make wide tables easier to scan.
- **Hide / show columns** from a dropdown panel.
- **Type inference** — numbers, booleans, dates and strings are detected automatically.
- **No locale-mangling of numbers** — `2024` stays `2024`, never `2.024`.
- **Sidecar persistence** — column widths are remembered per-file in a tiny `.gridmaster.json`.
- **Right-click → Open with Grid Master** for any supported file in the Explorer or editor tab.

## Getting started

1. Install the extension.
2. Open any `.csv`, `.parquet`, `.arrow`, `.jsonl` (etc.) file — it opens in Grid Master automatically.
3. For `.json` files, right-click in the Explorer and pick *Open with Grid Master*.
4. Run the command **Grid Master: Set as Default Editor for CSV/TSV/Parquet/Arrow** to make it the default for tabular files.

## Commands

| Command | What it does |
|---|---|
| `Grid Master: Open with Grid Master` | Open the active or selected file in the grid |
| `Grid Master: Open as Text` | Re-open the current file in VS Code's text editor |
| `Grid Master: Set as Default Editor for CSV/TSV/Parquet/Arrow` | Register Grid Master as the default editor for tabular formats |
| `Grid Master: Export as CSV` | Export the current view to a CSV file |
| `Grid Master: Show Column Statistics` | Quick stats (min, max, distinct, nulls) for the selected column |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `gridMaster.csvDelimiterAutoDetect` | `true` | Detect CSV delimiter automatically |
| `gridMaster.csvDelimiter` | `,` | Default CSV delimiter when auto-detect is off |
| `gridMaster.maxRowsInMemory` | `25000` | Max rows kept in webview memory (LRU) |
| `gridMaster.chunkSize` | `500` | Rows per chunk when streaming large files |
| `gridMaster.dateFormat` | `auto` | Date display format (`auto`, `ISO`, `locale`) |

## Performance

- CSV is parsed inline on the main thread with [PapaParse](https://www.papaparse.com/) — instant open for files up to a few hundred MB.
- Parquet, Arrow and JSON are streamed through a DuckDB-WASM Web Worker. Only the chunks you scroll past are pulled into memory.
- An LRU chunk cache keeps memory bounded regardless of file size.

## Privacy

Grid Master runs entirely on your machine. No files are uploaded, no telemetry is collected.

## Issues & feedback

Found a bug? Have a feature request? Open an issue on the [GitHub repository](https://github.com/your-org/vscode-grid-master).

## License

MIT.
