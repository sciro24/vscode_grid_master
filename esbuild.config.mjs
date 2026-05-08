import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Copy sql.js WASM into dist/ so the extension can locate it at runtime
// without relying on node_modules being present in the installed extension.
function copySqlJsWasm() {
  const src = path.resolve('node_modules/sql.js/dist/sql-wasm.wasm');
  const dst = path.resolve('dist/sql-wasm.wasm');
  if (fs.existsSync(src)) {
    fs.mkdirSync('dist', { recursive: true });
    fs.copyFileSync(src, dst);
    console.log('[extension] Copied sql-wasm.wasm to dist/');
  } else {
    console.warn('[extension] sql-wasm.wasm not found at', src);
  }
}

const ctx = await esbuild.context({
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'info',
  plugins: [
    {
      name: 'build-notifier',
      setup(build) {
        build.onEnd(result => {
          if (result.errors.length > 0) {
            console.error('[extension] Build failed:', result.errors);
          } else {
            copySqlJsWasm();
            console.log('[extension] Build complete');
          }
        });
      },
    },
  ],
});

if (watch) {
  await ctx.watch();
  console.log('[extension] Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
