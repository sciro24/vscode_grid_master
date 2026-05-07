import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'duckdb.worker': path.resolve(__dirname, 'src/workers/duckdb.worker.ts'),
      },
      output: {
        entryFileNames: (chunk) => `${chunk.name}.js`,
        // All non-worker chunks go into main.js to avoid CSP nonce issues
        // with dynamically imported chunks.
        manualChunks: (id) => {
          if (id.includes('duckdb.worker')) return undefined; // keep as own entry
          return 'main';
        },
        assetFileNames: '[name][extname]',
        format: 'es',
      },
    },
    target: 'es2022',
    minify: true,
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../src/shared'),
    },
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
});
