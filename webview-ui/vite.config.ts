import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import { promises as fs, createWriteStream } from 'fs';
import https from 'https';

// Copy DuckDB-WASM runtime assets into dist so the extension host can read
// them at startup and pass them to the webview as base64.
// Extensions are downloaded from extensions.duckdb.org at build time so the
// vsix ships everything needed offline.
function copyDuckDbAssets(): Plugin {
  // Copy parquet-wasm runtime into dist so the host can read it and pass it
  // as base64 to the webview worker.
  const FROM_NPM: { src: string; dst: string }[] = [
    { src: 'parquet-wasm/esm/parquet_wasm_bg.wasm', dst: 'parquet_wasm_bg.wasm' },
  ];
  const EXT_BASE = '';
  const EXTENSIONS: string[] = [];

  return {
    name: 'copy-duckdb-assets',
    apply: 'build',
    async closeBundle() {
      const src = path.resolve(__dirname, 'node_modules/@duckdb/duckdb-wasm/dist');
      const dst = path.resolve(__dirname, 'dist');
      await fs.mkdir(dst, { recursive: true });

      for (const entry of FROM_NPM) {
        const srcPath = path.resolve(__dirname, 'node_modules', entry.src);
        const dstPath = path.join(dst, entry.dst);
        try {
          await fs.copyFile(srcPath, dstPath);
          const stat = await fs.stat(dstPath);
          console.log(`[copy-duckdb-assets] copied ${entry.dst} (${stat.size} bytes)`);
        } catch (e) {
          console.warn(`[copy-duckdb-assets] could not copy ${entry.dst}:`, e);
        }
      }

      for (const f of EXTENSIONS) {
        const dstPath = path.join(dst, f);
        // Skip download if file already present and non-empty.
        try {
          const stat = await fs.stat(dstPath);
          if (stat.size > 0) continue;
        } catch { /* not present, download */ }

        try {
          await new Promise<void>((resolve, reject) => {
            const file = createWriteStream(dstPath);
            https.get(`${EXT_BASE}/${f}`, (res) => {
              res.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
            }).on('error', (e) => { fs.unlink(dstPath).catch(() => {}); reject(e); });
          });
          const stat = await fs.stat(dstPath);
          console.log(`[copy-duckdb-assets] downloaded ${f} (${stat.size} bytes)`);
        } catch (e) {
          console.warn(`[copy-duckdb-assets] failed to download ${f}:`, e);
        }
      }
    },
  };
}

// Two-pass build:
//   GM_BUILD=worker  → bundle the DuckDB worker into a single self-contained
//                      file (duckdb.worker.js) with all deps inlined.
//   GM_BUILD=main    → build the Svelte app (default).
//
// The worker MUST be self-contained because it's loaded via a same-origin
// blob wrapper and cannot resolve relative `import`s.
const TARGET = process.env.GM_BUILD ?? 'main';

export default defineConfig(() => {
  if (TARGET === 'worker') {
    return {
      plugins: [],
      build: {
        outDir: 'dist',
        emptyOutDir: false,
        lib: {
          entry: path.resolve(__dirname, 'src/workers/duckdb.worker.ts'),
          // IIFE — classic worker, loaded via blob+importScripts pattern.
          formats: ['iife'],
          name: 'GridMasterWorker',
          fileName: () => 'duckdb.worker.js',
        },
        rollupOptions: {
          output: {
            inlineDynamicImports: true,
          },
        },
        target: 'es2022',
        minify: true,
        sourcemap: false,
      },
      resolve: {
        alias: { '@shared': path.resolve(__dirname, '../src/shared') },
      },
    };
  }

  // Main webview app build.
  return {
    plugins: [svelte(), copyDuckDbAssets()],
    build: {
      outDir: 'dist',
      // Don't wipe the worker output produced by the previous pass.
      emptyOutDir: false,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
        },
        output: {
          entryFileNames: 'main.js',
          manualChunks: () => 'main',
          assetFileNames: '[name][extname]',
          format: 'es',
        },
      },
      target: 'es2022',
      minify: true,
      sourcemap: false,
    },
    resolve: {
      alias: { '@shared': path.resolve(__dirname, '../src/shared') },
    },
  };
});
