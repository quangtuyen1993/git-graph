<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { marked } from 'marked';

  interface FileChange {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }

  interface Provider {
    id: string;
    name: string;
    available: boolean;
    group: 'cli' | 'api';
  }

  export let providers: Provider[] = [];
  export let branches: { name: string; current: boolean }[] = [];
  export let compareFiles: FileChange[] | null = null;
  export let compareLoading = false;
  export let initialSource = '';
  export let initialTarget = '';
  export let initialProvider = '';
  export let initialModel = '';
  export let reviewResult: { content: string; provider: string; model: string; timestamp: string } | null = null;
  export let reviewLoading = false;
  export let error = '';

  const dispatch = createEventDispatcher();

  let sourceBranch = '';
  let targetBranch = '';
  let selectedProvider = '';
  let modelInput = '';
  let filterText = '';

  // Sync initial source/target from parent (right-click context) — only on change
  let lastInitialSource = '';
  let lastInitialTarget = '';
  $: if (initialSource !== lastInitialSource) {
    lastInitialSource = initialSource;
    if (initialSource) sourceBranch = initialSource;
  }
  $: if (initialTarget !== lastInitialTarget) {
    lastInitialTarget = initialTarget;
    if (initialTarget) targetBranch = initialTarget;
  }

  $: cliProviders = providers.filter(p => p.group === 'cli');
  $: apiProviders = providers.filter(p => p.group === 'api');
  $: availableProviders = providers.filter(p => p.available);

  // Restore saved provider/model once
  let restoredSettings = false;
  $: if (!restoredSettings && providers.length > 0) {
    restoredSettings = true;
    if (initialProvider && providers.some(p => p.id === initialProvider && p.available)) {
      selectedProvider = initialProvider;
    } else if (availableProviders.length > 0) {
      selectedProvider = availableProviders[0].id;
    }
    if (initialModel) modelInput = initialModel;
  }

  // Notify parent when settings change
  function notifySettingsChange() {
    dispatch('settingsChange', { provider: selectedProvider, model: modelInput });
  }

  $: filteredFiles = compareFiles?.filter(f =>
    f.path.toLowerCase().includes(filterText.toLowerCase())
  ) ?? [];

  $: totalAdditions = compareFiles?.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  $: totalDeletions = compareFiles?.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  function handleCompare() {
    if (!sourceBranch || !targetBranch) return;
    dispatch('compare', { sourceBranch, targetBranch });
  }

  function handleReview() {
    if (!sourceBranch || !targetBranch || !selectedProvider) return;
    dispatch('review', {
      sourceBranch,
      targetBranch,
      provider: selectedProvider,
      model: modelInput || 'default',
    });
  }

  function handleFileClick(file: FileChange) {
    dispatch('openDiff', { sourceBranch, targetBranch, path: file.path, oldPath: file.oldPath, status: file.status });
  }

  function getStatusLetter(status: string): string {
    switch (status) {
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'copied': return 'C';
      default: return 'M';
    }
  }

  function getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  function getFileDir(path: string): string {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/');
  }

  function formatMarkdown(text: string): string {
    return marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  }
</script>

<div class="review-panel">
  <!-- Branch comparison config -->
  <div class="compare-config">
    <div class="config-row">
      <label class="config-label" for="cmp-source">Base</label>
      <select id="cmp-source" class="config-select" bind:value={sourceBranch}>
        {#each branches as branch}
          <option value={branch.name}>{branch.name}{branch.current ? ' ●' : ''}</option>
        {/each}
      </select>
    </div>

    <div class="config-row">
      <label class="config-label" for="cmp-target">Head</label>
      <select id="cmp-target" class="config-select" bind:value={targetBranch}>
        <option value="" disabled>Select branch...</option>
        {#each branches as branch}
          {#if branch.name !== sourceBranch}
            <option value={branch.name}>{branch.name}{branch.current ? ' ●' : ''}</option>
          {/if}
        {/each}
      </select>
    </div>

    <div class="config-actions">
      <button
        class="btn btn-primary"
        on:click={handleCompare}
        disabled={compareLoading || !sourceBranch || !targetBranch}
      >
        {compareLoading ? '⏳ Loading...' : '📂 Compare'}
      </button>
      <button
        class="btn btn-secondary"
        on:click={handleReview}
        disabled={reviewLoading || !sourceBranch || !targetBranch || !selectedProvider}
      >
        {reviewLoading ? '⏳ Reviewing...' : '🤖 AI Review'}
      </button>
    </div>
  </div>

  <!-- AI Provider config (collapsible) -->
  <details class="ai-config">
    <summary class="ai-config-summary">AI Settings</summary>
    <div class="ai-config-body">
      <div class="config-row">
        <label class="config-label" for="ai-prov">Provider</label>
        <select id="ai-prov" class="config-select" bind:value={selectedProvider} on:change={notifySettingsChange}>
          {#if cliProviders.length > 0}
            <optgroup label="CLI (subscription)">
              {#each cliProviders as p}
                <option value={p.id} disabled={!p.available}>{p.name}</option>
              {/each}
            </optgroup>
          {/if}
          {#if apiProviders.length > 0}
            <optgroup label="API (key required)">
              {#each apiProviders as p}
                <option value={p.id} disabled={!p.available}>{p.name}{p.available ? '' : ' ⚠️'}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
      </div>
      <div class="config-row">
        <label class="config-label" for="ai-model">Model</label>
        <input
          id="ai-model"
          type="text"
          class="config-input"
          bind:value={modelInput}
          on:change={notifySettingsChange}
          placeholder="default (leave empty for CLI default)"
        />
      </div>
    </div>
  </details>

  {#if error}
    <div class="review-error">{error}</div>
  {/if}

  <!-- Files changed section -->
  {#if compareFiles !== null}
    <div class="files-section">
      <div class="files-header">
        <span class="files-title">FILES CHANGED</span>
        <span class="files-count">{compareFiles.length}</span>
        <span class="files-stats">
          {#if totalAdditions > 0}<span class="stat-add">+{totalAdditions}</span>{/if}
          {#if totalDeletions > 0}<span class="stat-del">-{totalDeletions}</span>{/if}
        </span>
      </div>

      <div class="files-filter">
        <input
          type="text"
          class="config-input"
          placeholder="Filter files..."
          bind:value={filterText}
        />
      </div>

      <div class="file-list">
        {#each filteredFiles as file}
          <button
            class="file-entry"
            on:click={() => handleFileClick(file)}
            type="button"
          >
            <span class="file-status file-status-{file.status}">{getStatusLetter(file.status)}</span>
            <span class="file-name">{getFileName(file.path)}</span>
            <span class="file-dir">{getFileDir(file.path)}</span>
            <span class="file-stats">
              {#if !file.binary}
                {#if file.additions > 0}<span class="stat-add">+{file.additions}</span>{/if}
                {#if file.deletions > 0}<span class="stat-del">-{file.deletions}</span>{/if}
              {:else}
                <span class="file-binary">BIN</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- AI Review result -->
  {#if reviewResult}
    <div class="review-result">
      <div class="result-header">
        <span class="result-title">AI REVIEW</span>
        <span class="result-meta">{reviewResult.provider}/{reviewResult.model}</span>
      </div>
      <div class="result-content">
        {@html formatMarkdown(reviewResult.content)}
      </div>
    </div>
  {/if}
</div>

<style>
  .review-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .compare-config {
    padding: 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
  }

  .config-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .config-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    min-width: 50px;
    flex-shrink: 0;
  }

  .config-select, .config-input {
    flex: 1;
    padding: 3px 6px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    background: var(--vscode-input-background, #1e1e1e);
    color: var(--vscode-input-foreground, #cccccc);
    font-size: 12px;
    border-radius: 3px;
    outline: none;
  }

  .config-select:focus, .config-input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .config-input::placeholder {
    color: var(--vscode-input-placeholderForeground, #666);
  }

  .config-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  .btn {
    flex: 1;
    padding: 5px 10px;
    border: none;
    font-size: 12px;
    font-weight: 500;
    border-radius: 3px;
    cursor: pointer;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .btn-primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #cccccc);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }

  /* AI config collapsible */
  .ai-config {
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    flex-shrink: 0;
  }

  .ai-config-summary {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground, #888);
    cursor: pointer;
    user-select: none;
  }

  .ai-config-summary:hover {
    color: var(--vscode-foreground, #ccc);
  }

  .ai-config-body {
    padding: 0 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Error */
  .review-error {
    padding: 6px 12px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f44747);
    font-size: 12px;
    flex-shrink: 0;
  }

  /* Files section */
  .files-section {
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
  }

  .files-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .files-title {
    color: var(--vscode-descriptionForeground, #888);
  }

  .files-count {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
  }

  .files-stats {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }

  .stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); font-size: 11px; }
  .stat-del { color: var(--vscode-errorForeground, #f44747); font-size: 11px; }

  .files-filter {
    padding: 0 12px 6px;
  }

  .file-list {
    max-height: 300px;
    overflow-y: auto;
  }

  .file-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    cursor: pointer;
    font-size: 13px;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    width: 100%;
    font-family: inherit;
  }

  .file-entry:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .file-status {
    width: 14px;
    text-align: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .file-status-added { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .file-status-deleted { color: var(--vscode-errorForeground, #f44747); }
  .file-status-modified { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .file-status-renamed { color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }

  .file-name {
    font-weight: 500;
    white-space: nowrap;
  }

  .file-dir {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .file-stats {
    display: flex;
    gap: 4px;
    margin-left: auto;
    font-size: 11px;
    flex-shrink: 0;
  }

  .file-binary {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 10px;
  }

  /* Review result */
  .review-result {
    flex: 1;
    overflow-y: auto;
  }

  .result-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
  }

  .result-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground, #888);
  }

  .result-meta {
    font-size: 10px;
    opacity: 0.6;
    margin-left: auto;
  }

  .result-content {
    padding: 16px;
    font-size: 13px;
    line-height: 1.7;
  }

  .result-content :global(h2), .result-content :global(h3), .result-content :global(h4) {
    margin: 16px 0 8px;
  }

  .result-content :global(h2:first-child),
  .result-content :global(h3:first-child),
  .result-content :global(h4:first-child) {
    margin-top: 0;
  }

  .result-content :global(p) {
    margin: 0 0 12px;
  }

  .result-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .result-content :global(strong) { color: var(--vscode-foreground, #eee); }

  .result-content :global(code) {
    background: var(--vscode-textCodeBlock-background, #2a2a2a);
    padding: 2px 5px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }

  .result-content :global(pre) {
    background: var(--vscode-textCodeBlock-background, #2a2a2a);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 12px 0;
  }

  .result-content :global(pre code) { background: none; padding: 0; }

  .result-content :global(ul), .result-content :global(ol) {
    margin: 8px 0 12px;
    padding-left: 24px;
  }

  .result-content :global(li) { margin: 6px 0; }

  .result-content :global(hr) {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, #333);
    margin: 16px 0;
  }

  .result-content :global(blockquote) {
    margin: 12px 0;
    padding: 8px 12px;
    border-left: 3px solid var(--vscode-textBlockQuote-border, #4fc1ff);
    background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.02));
  }
</style>
