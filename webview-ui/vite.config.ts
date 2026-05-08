import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import { promises as fs } from 'fs';

// Copy DuckDB-WASM runtime assets (wasm + inner workers) into the webview
// dist so they can be loaded from the same origin as the webview. Loading
// them from jsdelivr is blocked by the webview CSP.
function copyDuckDbAssets(): Plugin {
  // We ship MVP + EH only. COI requires cross-origin isolation
  // (Cross-Origin-Opener-Policy headers) which VS Code webviews don't set,
  // so it would never be selected anyway.
  const FILES = [
    'duckdb-mvp.wasm',
    'duckdb-eh.wasm',
    'duckdb-browser-mvp.worker.js',
    'duckdb-browser-eh.worker.js',
  ];
  return {
    name: 'copy-duckdb-assets',
    apply: 'build',
    async closeBundle() {
      const src = path.resolve(__dirname, 'node_modules/@duckdb/duckdb-wasm/dist');
      const dst = path.resolve(__dirname, 'dist');
      await fs.mkdir(dst, { recursive: true });
      for (const f of FILES) {
        try {
          await fs.copyFile(path.join(src, f), path.join(dst, f));
        } catch (e) {
          console.warn(`[copy-duckdb-assets] could not copy ${f}:`, e);
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
          formats: ['es'],
          fileName: () => 'duckdb.worker.js',
        },
        rollupOptions: {
          // Inline everything — no external deps, no shared chunks.
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
