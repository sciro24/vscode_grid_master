import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import { promises as fs } from 'fs';

// Copy parquet-wasm runtime into dist so the host can read it and pass it
// as base64 to the webview worker.
function copyWorkerAssets(): Plugin {
  const FROM_NPM: { src: string; dst: string }[] = [
    { src: 'parquet-wasm/esm/parquet_wasm_bg.wasm', dst: 'parquet_wasm_bg.wasm' },
  ];

  return {
    name: 'copy-worker-assets',
    apply: 'build',
    async closeBundle() {
      const dst = path.resolve(__dirname, 'dist');
      await fs.mkdir(dst, { recursive: true });

      for (const entry of FROM_NPM) {
        const srcPath = path.resolve(__dirname, 'node_modules', entry.src);
        const dstPath = path.join(dst, entry.dst);
        try {
          await fs.copyFile(srcPath, dstPath);
          const stat = await fs.stat(dstPath);
          console.log(`[copy-worker-assets] copied ${entry.dst} (${stat.size} bytes)`);
        } catch (e) {
          console.warn(`[copy-worker-assets] could not copy ${entry.dst}:`, e);
        }
      }
    },
  };
}

// Two-pass build:
//   GM_BUILD=worker  → bundle the DuckDB worker into a single self-contained
//                      file (data.worker.js) with all deps inlined.
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
          entry: path.resolve(__dirname, 'src/workers/data.worker.ts'),
          // IIFE — classic worker, loaded via blob+importScripts pattern.
          formats: ['iife'],
          name: 'GridMasterWorker',
          fileName: () => 'data.worker.js',
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
    plugins: [svelte(), copyWorkerAssets()],
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
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
