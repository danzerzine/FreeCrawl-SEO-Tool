import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages export `./dist` only. Tests resolve them to their
// sources instead, so `npm test` needs no build step first.
const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // See vitest.node-sqlite.ts.
      sqlite: fileURLToPath(new URL('./vitest.node-sqlite.ts', import.meta.url)),
      '@freecrawl/shared-types': src('shared-types'),
      '@freecrawl/db': src('db'),
      '@freecrawl/core': src('core'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/cli/src/**/*.test.ts',
      'apps/mcp-server/src/**/*.test.ts',
      'apps/desktop/src/renderer/src/**/*.test.ts',
      'apps/desktop/src/main/**/*.test.ts',
    ],
    environment: 'node',
  },
});
