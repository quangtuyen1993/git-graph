import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [['tests/webview/**/*.test.ts', 'jsdom']],
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: [
        'src/extension/services/git.service.ts',
        'src/extension/services/graph.service.ts',
        'src/extension/controllers/git-method-handler.ts',
        'src/extension/utils/git-parser.ts',
        'src/extension/utils/rebase-todo.ts',
        'src/webview/lib/**/*.ts',
        'src/webview/components/actions/ContextMenu.svelte',
        'src/webview/components/layout/ResizeHandle.svelte',
        'src/webview/components/sidebar/BranchSidebar.svelte'
      ],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
        branches: 70
      }
    }
  }
});
