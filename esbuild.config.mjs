import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
