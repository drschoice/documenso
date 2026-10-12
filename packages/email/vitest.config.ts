import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

/**
 * The templates are written against the Lingui macros (`Trans`, `msg`), which
 * are a compile-time transform rather than a runtime import - without it the
 * macro entry points resolve to nothing and every template throws on render.
 * These are the same two plugins the app's own Vite build uses, in the same
 * order.
 */
export default defineConfig({
  plugins: [macrosPlugin(), lingui()],
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
  },
});
