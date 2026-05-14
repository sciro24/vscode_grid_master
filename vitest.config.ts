import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['webview-ui/**', 'node_modules/**', 'dist/**', 'out/**']
  }
});
