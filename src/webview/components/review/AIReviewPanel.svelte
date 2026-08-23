<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let providers: { id: string; name: string; available: boolean; models: string[] }[] = [];
  export let branches: { name: string; current: boolean }[] = [];
  export let result: { content: string; provider: string; model: string; timestamp: string } | null = null;
  export let loading = false;
  export let error = '';

  const dispatch = createEventDispatcher();

  let selectedProvider = '';
  let selectedModel = '';
  let sourceBranch = '';
  let targetBranch = '';

  $: availableProviders = providers.filter(p => p.available);
  $: if (availableProviders.length > 0 && !selectedProvider) {
    selectedProvider = availableProviders[0].id;
  }
  $: currentProvider = providers.find(p => p.id === selectedProvider);
  $: if (currentProvider && currentProvider.models.length > 0 && !selectedModel) {
    selectedModel = currentProvider.models[0];
  }
  $: localBranches = branches.filter(b => !b.current);
  $: currentBranch = branches.find(b => b.current);
  $: if (currentBranch && !sourceBranch) {
    sourceBranch = currentBranch.name;
  }

  function handleReview() {
    if (!sourceBranch || !targetBranch || !selectedProvider) return;
    dispatch('review', {
      sourceBranch,
      targetBranch,
      provider: selectedProvider,
      model: selectedModel,
    });
  }

  function handleProviderChange() {
    const provider = providers.find(p => p.id === selectedProvider);
    if (provider && provider.models.length > 0) {
      selectedModel = provider.models[0];
    }
  }

  function formatMarkdown(text: string): string {
    // Basic markdown → HTML for review display
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Headers
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Code blocks
      .replace(/```[\s\S]*?```/g, (match) => {
        const code = match.replace(/```\w*\n?/, '').replace(/\n?```$/, '');
        return `<pre><code>${code}</code></pre>`;
      })
      // Inline code
      .replace(/`(.+?)`/g, '<code>$1</code>')
      // Lists
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
      // Line breaks
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }
</script>

<div class="review-panel">
  <div class="review-header">
    <span class="review-title">AI CODE REVIEW</span>
  </div>

  <!-- Config section -->
  <div class="review-config">
    <!-- Provider + Model selector -->
    <div class="config-row">
      <label class="config-label" for="ai-provider">Provider</label>
      <select
        id="ai-provider"
        class="config-select"
        bind:value={selectedProvider}
        on:change={handleProviderChange}
      >
        {#each providers as provider}
          <option value={provider.id} disabled={!provider.available}>
            {provider.name} {provider.available ? '' : '(not configured)'}
          </option>
        {/each}
      </select>
    </div>

    <div class="config-row">
      <label class="config-label" for="ai-model">Model</label>
      <select id="ai-model" class="config-select" bind:value={selectedModel}>
        {#if currentProvider}
          {#each currentProvider.models as model}
            <option value={model}>{model}</option>
          {/each}
        {/if}
      </select>
    </div>

    <!-- Branch comparison -->
    <div class="config-row">
      <label class="config-label" for="ai-source">Source</label>
      <select id="ai-source" class="config-select" bind:value={sourceBranch}>
        {#each branches as branch}
          <option value={branch.name}>{branch.name} {branch.current ? '(current)' : ''}</option>
        {/each}
      </select>
    </div>

    <div class="config-row">
      <label class="config-label" for="ai-target">Compare to</label>
      <select id="ai-target" class="config-select" bind:value={targetBranch}>
        <option value="" disabled>Select target branch...</option>
        {#each branches as branch}
          {#if branch.name !== sourceBranch}
            <option value={branch.name}>{branch.name}</option>
          {/if}
        {/each}
      </select>
    </div>

    <button
      class="review-btn"
      on:click={handleReview}
      disabled={loading || !sourceBranch || !targetBranch || !selectedProvider}
    >
      {#if loading}
        ⏳ Reviewing...
      {:else}
        🔍 Review Diff
      {/if}
    </button>
  </div>

  <!-- Error -->
  {#if error}
    <div class="review-error">{error}</div>
  {/if}

  <!-- Result -->
  {#if result}
    <div class="review-result">
      <div class="result-meta">
        <span class="result-provider">{result.provider}/{result.model}</span>
        <span class="result-time">{new Date(result.timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="result-content">
        {@html formatMarkdown(result.content)}
      </div>
    </div>
  {/if}
</div>



<style>
  .review-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .review-header {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    flex-shrink: 0;
  }

  .review-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-sideBarSectionHeader-foreground, #bbbbbb);
  }

  .review-config {
    padding: 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .config-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .config-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    min-width: 70px;
    flex-shrink: 0;
  }

  .config-select {
    flex: 1;
    padding: 3px 6px;
    border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
    background: var(--vscode-dropdown-background, #1e1e1e);
    color: var(--vscode-dropdown-foreground, #cccccc);
    font-size: 12px;
    border-radius: 3px;
    outline: none;
  }

  .config-select:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .review-btn {
    margin-top: 4px;
    padding: 6px 12px;
    border: none;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    font-size: 12px;
    font-weight: 500;
    border-radius: 3px;
    cursor: pointer;
    width: 100%;
  }

  .review-btn:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  .review-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .review-error {
    padding: 8px 12px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f44747);
    font-size: 12px;
    flex-shrink: 0;
  }

  .review-result {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }

  .result-meta {
    display: flex;
    justify-content: space-between;
    margin-bottom: 12px;
    font-size: 11px;
    opacity: 0.6;
  }

  .result-provider {
    font-weight: 600;
  }

  .result-content {
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-foreground, #cccccc);
  }

  .result-content :global(h2),
  .result-content :global(h3),
  .result-content :global(h4) {
    margin: 12px 0 6px;
    color: var(--vscode-foreground, #eee);
  }

  .result-content :global(h2) { font-size: 15px; }
  .result-content :global(h3) { font-size: 14px; }
  .result-content :global(h4) { font-size: 13px; }

  .result-content :global(strong) {
    color: var(--vscode-foreground, #eee);
  }

  .result-content :global(code) {
    background: var(--vscode-textCodeBlock-background, #2a2a2a);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }

  .result-content :global(pre) {
    background: var(--vscode-textCodeBlock-background, #2a2a2a);
    padding: 8px 12px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 8px 0;
  }

  .result-content :global(pre code) {
    background: none;
    padding: 0;
  }

  .result-content :global(li) {
    margin: 4px 0;
    padding-left: 4px;
  }
</style>
