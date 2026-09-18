import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The domain layer is pure TypeScript with no React Native imports, which is
 * exactly why it can be tested at full speed in Node. Anything that needs a
 * device (SQLite, camera, printer) is exercised separately.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
