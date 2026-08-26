import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
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
        'src/extension/services/edge-range-index.ts',
        'src/extension/services/graph-loader.ts',
        'src/extension/services/graph.service.ts',
        'src/extension/controllers/graph-method-handler.ts',
        'src/extension/controllers/git-method-handler.ts',
        'src/extension/utils/git-parser.ts',
        'src/extension/utils/rebase-todo.ts',
        'src/extension/services/active-repo.ts',
        'src/extension/services/review-key.ts',
        'src/extension/services/review-store.ts',
        'src/extension/services/review-runner.ts',
        'src/extension/controllers/review-method-handler.ts',
        'src/extension/providers/review-tree-provider.ts',
        'src/webview/lib/**/*.ts',
        'src/webview/components/actions/ContextMenu.svelte',
        'src/webview/components/layout/ResizeHandle.svelte',
        'src/webview/components/sidebar/BranchSidebar.svelte',
        'src/extension/services/forge/remote-url.ts',
        'src/extension/services/forge/forge-registry.ts',
        'src/extension/services/forge/forge-store.ts',
        'src/extension/services/forge/forge.types.ts',
        'src/extension/services/forge/url-safety.ts',
        'src/extension/services/forge/bitbucket/bitbucket-constants.ts',
        'src/extension/services/forge/bitbucket/bitbucket-auth.ts',
        'src/extension/services/forge/bitbucket/bitbucket-api.ts',
        'src/extension/services/forge/bitbucket/bitbucket-mapper.ts',
        'src/extension/services/forge/bitbucket/bitbucket-cloud.provider.ts',
        'src/extension/services/forge/bitbucket/bitbucket-sign-in.ts',
        'src/extension/controllers/forge-method-handler.ts',
        'src/webview/components/sidebar/PullRequestList.svelte',
        'src/webview/components/detail/PullRequestDetail.svelte'
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
