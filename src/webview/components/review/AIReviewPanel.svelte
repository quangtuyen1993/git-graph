<script lang="ts">
  import Icon from '../common/Icon.svelte';
  import { createEventDispatcher, onDestroy } from 'svelte';

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
  export let reviewLoading = false;
  export let error = '';

  const dispatch = createEventDispatcher();

  let sourceBranch = '';
  let targetBranch = '';
  let selectedProvider = '';
  let modelInput = '';
  let filterText = '';
  let filesExpanded = true;
  let reviewStarted = false;

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

  // A review can legitimately run for minutes, so show elapsed time to make it
  // clear the run is alive rather than hung.
  let elapsedSeconds = 0;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;

  $: if (reviewLoading && elapsedTimer === undefined) {
    elapsedSeconds = 0;
    elapsedTimer = setInterval(() => { elapsedSeconds += 1; }, 1000);
  } else if (!reviewLoading && elapsedTimer !== undefined) {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  }

  onDestroy(() => {
    if (elapsedTimer !== undefined) clearInterval(elapsedTimer);
  });

  $: elapsedLabel = elapsedSeconds >= 60
    ? `${Math.floor(elapsedSeconds / 60)}m ${String(elapsedSeconds % 60).padStart(2, '0')}s`
    : `${elapsedSeconds}s`;

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
    reviewStarted = true;
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
        {reviewLoading ? `⏳ Reviewing… ${elapsedLabel}` : '🤖 Review Changes'}
      </button>
    </div>

    {#if reviewStarted}
      <p class="review-started-hint">Started — see the Code Review panel.</p>
    {/if}
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
    <div class="files-section" class:collapsed={!filesExpanded}>
      <button
        class="section-toggle"
        aria-expanded={filesExpanded}
        on:click={() => { filesExpanded = !filesExpanded; }}
      >
        <span class="chevron" class:collapsed={!filesExpanded}><Icon name="chevron-right" /></span>
        <span class="files-title">FILES CHANGED</span>
        <span class="files-count">{compareFiles.length}</span>
        <span class="files-stats">
          {#if totalAdditions > 0}<span class="stat-add">+{totalAdditions}</span>{/if}
          {#if totalDeletions > 0}<span class="stat-del">-{totalDeletions}</span>{/if}
        </span>
      </button>

      {#if filesExpanded}
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
        {#if filteredFiles.length === 0}
          <p class="files-empty">
            {compareFiles.length === 0 ? 'No differences between these branches.' : 'No files match the filter.'}
          </p>
        {/if}
      </div>
      {/if}
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

  /* Collapsible section headers. Full-width buttons so the whole row is a hit
     target, styled to read as a header rather than a control. */
  .section-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: none;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-sideBarSectionHeader-foreground, #bbb);
    cursor: pointer;
    text-align: left;
  }

  .section-toggle:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .section-toggle:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    opacity: 0.8;
    transform: rotate(90deg);
    transition: transform 0.15s ease;
  }

  .chevron.collapsed {
    transform: rotate(0deg);
  }

  /* The files section grows to fill the panel while open, but must not keep
     reserving that space once collapsed. */
  .files-section.collapsed {
    flex: 0 0 auto;
  }

  .files-title {
    color: var(--vscode-descriptionForeground, #888);
  }

  .files-empty {
    margin: 0;
    padding: 10px 12px 14px;
    font-size: 12px;
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

  .review-started-hint {
    margin: 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
  }
</style>
