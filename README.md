# Grid Master

**A fast, in-editor data grid for VS Code.** Open CSV, Parquet, Arrow, JSON, Excel, SQLite, Avro and ORC files as an interactive spreadsheet — without ever leaving the editor.

<p align="center">
  <img src="assets/screenshot-1.png" alt="Grid Master — main grid view" width="48%" />
  &nbsp;&nbsp;
  <img src="assets/screenshot-2.png" alt="Grid Master — filter and column tools" width="48%" />
</p>

<!--
  Drop two screenshots into assets/ named screenshot-1.png and screenshot-2.png.
  Recommended size: 1280×800 each, PNG, ≤300 KB. They render side-by-side here
  and on both the VS Marketplace and Open VSX listings.
-->

---

## Supported formats

| Extension | Format | Engine |
|---|---|---|
| `.csv` `.tsv` `.txt` | Delimited text | PapaParse (inline, instant) |
| `.parquet` `.parq` | Apache Parquet | parquet-wasm + Apache Arrow |
| `.arrow` `.feather` | Apache Arrow / Feather | Apache Arrow JS |
| `.json` | JSON array | In-worker parser |
| `.jsonl` `.ndjson` | Newline-delimited JSON | In-worker parser |
| `.xlsx` `.xlsb` `.xls` `.xlsm` | Excel workbooks | SheetJS (in-worker) |
| `.avro` | Apache Avro (OCF) | avsc (extension host) |
| `.db` `.sqlite` `.sqlite3` | SQLite databases | sql.js WASM (extension host) |
| `.orc` | Apache ORC | pyorc via Python 3 (extension host) |

**Partitioned datasets** (Spark-style directories named `*.parquet` containing `part-*.parquet` files) are detected automatically and loaded as a single merged table.

---

## Features

### Grid & navigation
- **Virtualised renderer** — only rows in the visible viewport are rendered. 1M-row Parquet files scroll at 60 fps.
- **Click-to-sort** on any column header — cycles asc → desc → unsorted.
- **Drag-to-resize** column borders. Double-click the resize handle to auto-fit to content.
- **Column color coding** — toggle a muted pastel palette to make wide tables easier to scan visually.
- **Hide / show columns** from a dropdown panel in the toolbar.

### Search & filter
- **Global search** — type in the toolbar to instantly filter all rows across every column.
- **Per-column filters** — click the filter icon on any header to set conditions (equals, contains, greater than, regex, is null, etc.).
- **Live row count** — the toolbar shows how many rows match the current search/filter.

### Editing
- **Inline editing** — double-click any cell to edit its value in place.
- **Per-edit Undo** — step back through changes one at a time.
- **Discard all** — revert every pending edit with one click.
- **Save** — write edits back to the file (CSV formats).

### Data quality
- **Type inference** — numbers, booleans, dates and strings are detected automatically from the data.
- **No locale-mangling** — `2024` stays `2024`, never `2.024`. Numbers use plain formatting regardless of the OS locale.
- **Null awareness** — null / empty / NA cells are displayed distinctly and handled correctly in filters and stats.

### Persistence
- **Sidecar file** — column widths and hidden columns are remembered per-file in a tiny `.gridmaster.json` next to the data file.

### Export
- **Export as CSV / TSV / JSON** from the toolbar — saves the current filtered and sorted view.

### SQLite multi-table
- When you open a `.db` file with multiple tables, Grid Master shows a quick-pick so you can choose which table to load.

---

## See it in action

<p align="center">
  <img src="assets/demo.gif" alt="Grid Master demo" width="80%" />
</p>

<!--
  Drop a demo recording at assets/demo.gif (or assets/demo.mp4 — for video,
  replace the <img> above with a <video> tag). Keep it under 8 MB so it
  renders inline on GitHub and the marketplaces. ~10–20 seconds is plenty.
-->

---

## Getting started

1. **Install** the extension from the VS Code Marketplace.
2. **Open any supported file** — Grid Master activates automatically for `.csv`, `.parquet`, `.arrow`, `.jsonl`, `.xlsx`, `.avro`, `.db`, `.orc` and more.
3. For `.json` files (which are common in non-tabular contexts), right-click in the Explorer and pick **Open with Grid Master**.
4. **ORC files** require Python 3 with `pyorc` installed: `pip3 install pyorc`.

---

## Commands

| Command | Description |
|---|---|
| `Grid Master: Open with Grid Master` | Open the active or selected file in the grid |
| `Grid Master: Open as Text` | Re-open the current file in VS Code's plain text editor |
| `Grid Master: Set as Default Editor` | Register Grid Master as the default editor for all supported tabular formats |
| `Grid Master: Export as CSV` | Export the current view (with active filters/sort) to a CSV file |
| `Grid Master: Export as TSV` | Export as tab-separated values |
| `Grid Master: Export as JSON` | Export as a JSON array |
| `Grid Master: Show Column Statistics` | Min, max, distinct count and null count for the focused column |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `gridMaster.csvDelimiterAutoDetect` | `true` | Auto-detect the CSV delimiter |
| `gridMaster.csvDelimiter` | `,` | Fallback delimiter when auto-detect is off |
| `gridMaster.maxRowsInMemory` | `25000` | Maximum rows kept in the LRU cache |
| `gridMaster.chunkSize` | `500` | Rows fetched per virtual scroll chunk |
| `gridMaster.dateFormat` | `auto` | Date display format: `auto`, `ISO`, or `locale` |

---

## Performance

| Format | Parsing | Notes |
|---|---|---|
| CSV / TSV | Main thread, synchronous | PapaParse; files up to ~500 MB open in under a second |
| Parquet / Arrow | Web Worker (WASM) | parquet-wasm + Apache Arrow; only scrolled chunks are decoded |
| JSON / NDJSON | Web Worker | Parsed directly; avoids `eval`-based paths that break VS Code's CSP |
| Excel | Web Worker | SheetJS reads the first sheet |
| SQLite / Avro / ORC | Extension host (Node.js) | Decoded server-side, streamed to the webview as rows |

An LRU chunk cache keeps memory bounded regardless of file size. Sorting and filtering run inside the worker over a fully materialised row array, so no round-trips to disk for every sort click.

---

## Privacy

Grid Master runs entirely on your machine. Files are never uploaded anywhere, no telemetry is collected, and no network requests are made (Parquet/Arrow WASM is inlined into the extension bundle).

---

## Requirements

- VS Code 1.74 or later.
- For ORC files: Python 3 with `pip3 install pyorc`.
- For Avro files: no extra dependencies (avsc is bundled).
- For SQLite files: no extra dependencies (sql.js WASM is bundled).

---

## Issues & feedback

Found a bug or have a feature request? [Open an issue on GitHub](https://github.com/sciro24/vscode_grid_master/issues).

---

## License

MIT
