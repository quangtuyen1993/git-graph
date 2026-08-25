<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { bridge } from './lib/message-bridge';
  import { LatestRequestGate, runLatestRequest } from './lib/latest-request';
  import FileTreeList from './components/detail/FileTreeList.svelte';
  import { buildPathTree } from './lib/path-tree';
  import Combobox from './components/Combobox.svelte';
  import LoadingSpinner from './components/common/LoadingSpinner.svelte';

  type Mode = 'commit' | 'range' | 'branch';
  type ReviewStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

  interface Repo { path: string; name: string; active: boolean }
  interface Branch { name: string; current?: boolean }
  interface Commit { hash: string; abbreviatedHash: string; subject: string; authorDate: string }
  interface Provider { id: string; name: string; available: boolean; group: string }
  interface FileChange {
    path: string; oldPath: string | null; status: string;
    additions: number; deletions: number; binary: boolean;
  }
  interface ReviewEntry {
    id: string; kind: Mode;
    baseRef: string; baseSha: string; headRef: string; headSha: string;
    subject?: string; provider: string; model: string; status: ReviewStatus;
    startedAt: string; finishedAt?: string; error?: string;
  }
  interface ComboItem { label: string; value: string; detail?: string }

  // --- State ---
  let repos: Repo[] = [];
  let selectedRepoPath = '';
  let mode: Mode = 'branch';
  let branches: Branch[] = [];
  let commits: Commit[] = [];
  let providers: Provider[] = [];
  let reviews: ReviewEntry[] = [];

  // Input values per mode
  let commitValue = '';
  let baseCommitValue = '';
  let headCommitValue = '';
  let baseBranchValue = '';
  let headBranchValue = '';

  // Action bar
  let selectedProvider = '';
  let modelInput = '';

  // Files pane
  let files: FileChange[] | null = null;
  let compareLoading = false;
  let viewMode: 'tree' | 'flat' = 'flat';
  let collapsedFolders: Record<string, boolean> = {};

  // Misc
  let error = '';
  let latestStartedId = '';
  let now = Date.now();
  let targetOverridden = false;

  const compareGate = new LatestRequestGate();
  const unsubscribers: Array<() => void> = [];

  // --- Derived ---
  $: branchItems = branches.map((b): ComboItem => ({
    label: b.name,
    value: b.name,
    detail: b.current ? '● current' : undefined,
  }));

  $: commitItems = commits.map((c): ComboItem => ({
    label: `${c.abbreviatedHash} ${c.subject}`,
    value: c.hash,
    detail: relativeDate(c.authorDate),
  }));

  $: canCompare = (() => {
    switch (mode) {
      case 'commit': return !!commitValue;
      case 'range': return !!baseCommitValue && !!headCommitValue;
      case 'branch': return !!baseBranchValue && !!headBranchValue;
    }
  })();

  $: canReview = canCompare && !!selectedProvider;

  $: fileTree = viewMode === 'tree' && files ? buildPathTree(files, (f) => f.path) : [];
  $: totalAdditions = files?.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  $: totalDeletions = files?.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  // Ticker for running reviews
  let ticker: ReturnType<typeof setInterval> | undefined;
  $: hasRunning = reviews.some(r => r.status === 'running');
  $: if (hasRunning && ticker === undefined) {
    ticker = setInterval(() => { now = Date.now(); }, 1000);
  } else if (!hasRunning && ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
    now = Date.now();
  }

  // --- Lifecycle ---
  onMount(() => {
    unsubscribers.push(bridge.on('review.changed', () => { void refreshReviews(); }));
    unsubscribers.push(bridge.on('review.target', (data) => {
      targetOverridden = true;
      const t = data as { kind: Mode; baseRef: string; headRef: string; subject?: string };
      mode = t.kind;
      applyTarget(t);
      files = null;
      error = '';
      void compare();
    }));
    unsubscribers.push(bridge.on('repo.changed', () => {
      targetOverridden = false;
      files = null;
      error = '';
      void init();
    }));
    void init();
  });

  onDestroy(() => {
    unsubscribers.forEach(unsub => unsub());
    if (ticker !== undefined) clearInterval(ticker);
  });

  // --- Init ---
  async function init(): Promise<void> {
    try {
      const [repoList, branchList, commitList, providerList, savedProvider, savedModel, storedTarget, savedViewMode, savedMode] = await Promise.all([
        bridge.send('review.getRepos') as Promise<Repo[]>,
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('review.getCommits') as Promise<Commit[]>,
        bridge.send('ai.providers') as Promise<Provider[]>,
        bridge.send('ui.getState', { key: 'aiReview.provider' }) as Promise<string | null>,
        bridge.send('ui.getState', { key: 'aiReview.model' }) as Promise<string | null>,
        bridge.send('review.getTarget') as Promise<{ kind: Mode; baseRef: string; headRef: string; subject?: string } | null>,
        bridge.send('ui.getState', { key: 'detail.viewMode' }) as Promise<string | null>,
        bridge.send('ui.getState', { key: 'review.mode' }) as Promise<string | null>,
      ]);

      repos = repoList ?? [];
      const activeRepo = repos.find(r => r.active);
      selectedRepoPath = activeRepo?.path ?? (repos[0]?.path ?? '');

      branches = branchList ?? [];
      commits = commitList ?? [];
      providers = providerList ?? [];

      if (savedViewMode === 'tree' || savedViewMode === 'flat') viewMode = savedViewMode;

      const available = providers.filter(p => p.available);
      selectedProvider = savedProvider && available.some(p => p.id === savedProvider)
        ? savedProvider
        : (available[0]?.id ?? '');
      modelInput = savedModel ?? '';

      if (!targetOverridden) {
        if (savedMode && ['commit', 'range', 'branch'].includes(savedMode)) {
          mode = savedMode as Mode;
        }
        if (storedTarget) {
          mode = storedTarget.kind;
          applyTarget(storedTarget);
        } else {
          applyDefaults();
        }
      }

      await refreshReviews();
      void compare();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function applyTarget(t: { kind: Mode; baseRef: string; headRef: string; subject?: string }): void {
    switch (t.kind) {
      case 'commit':
        commitValue = t.headRef;
        break;
      case 'range':
        baseCommitValue = t.baseRef;
        headCommitValue = t.headRef;
        break;
      case 'branch':
        baseBranchValue = t.baseRef;
        headBranchValue = t.headRef;
        break;
    }
  }

  function applyDefaults(): void {
    if (mode === 'branch') {
      headBranchValue = branches.find(b => b.current)?.name ?? '';
      baseBranchValue = ['main', 'master'].find(name =>
        name !== headBranchValue && branches.some(b => b.name === name)) ?? '';
    }
  }

  // --- Mode switching ---
  function setMode(newMode: Mode): void {
    if (newMode === mode) return;
    mode = newMode;
    // Clear inputs and files on mode switch
    commitValue = '';
    baseCommitValue = '';
    headCommitValue = '';
    baseBranchValue = '';
    headBranchValue = '';
    files = null;
    error = '';
    // Apply defaults for branch mode
    if (mode === 'branch') {
      applyDefaults();
      void compare();
    }
    void bridge.send('ui.setState', { key: 'review.mode', value: mode }).catch(() => {});
  }

  // --- Repo change ---
  function handleRepoChange(e: globalThis.Event): void {
    const target = e.target as HTMLSelectElement;
    selectedRepoPath = target.value;
    void bridge.send('ui.setState', { key: 'review.repo', value: selectedRepoPath }).catch(() => {});
    // Reload branches + commits for new repo context
    void reloadForRepo();
  }

  async function reloadForRepo(): Promise<void> {
    try {
      const [branchList, commitList] = await Promise.all([
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('review.getCommits') as Promise<Commit[]>,
      ]);
      branches = branchList ?? [];
      commits = commitList ?? [];
      applyDefaults();
      files = null;
      void compare();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // --- Compare ---
  async function compare(): Promise<void> {
    if (!canCompare) { files = null; return; }
    compareLoading = true;
    const params = getCompareParams();
    try {
      await runLatestRequest(
        compareGate,
        () => bridge.send('review.compare', params) as Promise<{ files: FileChange[] }>,
        (result) => { files = result.files; error = ''; },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      compareLoading = false;
    }
  }

  function getCompareParams(): { kind: Mode; baseRef: string; headRef: string } {
    switch (mode) {
      case 'commit': return { kind: 'commit', baseRef: `${commitValue}~1`, headRef: commitValue };
      case 'range': return { kind: 'range', baseRef: baseCommitValue, headRef: headCommitValue };
      case 'branch': return { kind: 'branch', baseRef: baseBranchValue, headRef: headBranchValue };
    }
  }

  function saveTarget(): void {
    const params = getCompareParams();
    void Promise.resolve(bridge.send('review.saveTarget', params)).catch(() => {});
  }

  // --- Combobox handlers ---
  function handleCommitSelect(): void {
    if (commitValue) {
      saveTarget();
      void compare();
    }
  }

  function handleRangeSelect(): void {
    if (baseCommitValue && headCommitValue) {
      saveTarget();
      void compare();
    }
  }

  function handleBranchSelect(): void {
    if (baseBranchValue && headBranchValue) {
      saveTarget();
      void compare();
    }
  }

  function swapInputs(): void {
    if (mode === 'range') {
      [baseCommitValue, headCommitValue] = [headCommitValue, baseCommitValue];
    } else if (mode === 'branch') {
      [baseBranchValue, headBranchValue] = [headBranchValue, baseBranchValue];
    }
    files = null;
    saveTarget();
    void compare();
  }

  // --- Reviews ---
  async function refreshReviews(): Promise<void> {
    try {
      reviews = (await bridge.send('review.list') as ReviewEntry[]) ?? [];
    } catch {
      // Keep stale list visible rather than showing empty
    }
  }

  async function startReview(): Promise<void> {
    if (!canReview) return;
    error = '';
    const params = getCompareParams();
    try {
      const started = await bridge.send('review.start', {
        ...params,
        provider: selectedProvider,
        model: modelInput,
      }) as { id: string };
      latestStartedId = started.id;
      await refreshReviews();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // --- Action bar ---
  function saveSettings(): void {
    void bridge.send('ui.setState', { key: 'aiReview.provider', value: selectedProvider });
    void bridge.send('ui.setState', { key: 'aiReview.model', value: modelInput });
  }

  // --- Files pane ---
  function setViewMode(newMode: 'tree' | 'flat'): void {
    viewMode = newMode;
    void Promise.resolve(bridge.send('ui.setState', { key: 'detail.viewMode', value: newMode })).catch(() => {});
  }

  function toggleFolder(path: string): void {
    collapsedFolders = { ...collapsedFolders, [path]: !collapsedFolders[path] };
  }

  async function openFile(file: FileChange): Promise<void> {
    const params = getCompareParams();
    try {
      await bridge.send('ui.compareDiff', {
        sourceBranch: params.baseRef, targetBranch: params.headRef,
        path: file.path, oldPath: file.oldPath, status: file.status,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // --- Review rows ---
  async function rowAction(
    method: 'review.open' | 'review.cancel' | 'review.delete' | 'review.rerun',
    entry: ReviewEntry,
  ): Promise<void> {
    try {
      await bridge.send(method, { id: entry.id });
      if (method !== 'review.open') await refreshReviews();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function entryLabel(entry: ReviewEntry): string {
    if (entry.kind === 'commit') {
      return `${entry.headSha.slice(0, 7)}${entry.subject ? ` "${entry.subject}"` : ''}`;
    }
    if (entry.kind === 'range') return `${entry.baseSha.slice(0, 7)}..${entry.headSha.slice(0, 7)}`;
    return `${entry.baseRef} ← ${entry.headRef}`;
  }

  function statusIcon(status: ReviewStatus): string {
    switch (status) {
      case 'running': return '⟳';
      case 'done': return '✓';
      case 'failed': return '✗';
      case 'cancelled': return '⊘';
      default: return '⚠';
    }
  }

  function timeLabel(entry: ReviewEntry): string {
    if (entry.status === 'running') {
      const seconds = Math.max(0, Math.floor((now - new Date(entry.startedAt).getTime()) / 1000));
      return seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
        : `${seconds}s`;
    }
    const ended = new Date(entry.finishedAt ?? entry.startedAt).getTime();
    const minutes = Math.floor((now - ended) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  }

  function relativeDate(isoDate: string): string {
    const diff = Date.now() - new Date(isoDate).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
</script>

<div class="review-app">
  <!-- Repo picker -->
  <section class="repo-picker" aria-label="Repository selector">
    <select aria-label="Repository" bind:value={selectedRepoPath} on:change={handleRepoChange}>
      {#each repos as repo (repo.path)}
        <option value={repo.path}>{repo.name}</option>
      {/each}
    </select>
  </section>

  <!-- Mode tabs -->
  <div class="mode-tabs" role="tablist" aria-label="Compare mode">
    <button
      role="tab"
      aria-selected={mode === 'commit'}
      on:click={() => setMode('commit')}
    >1 Commit</button>
    <button
      role="tab"
      aria-selected={mode === 'range'}
      on:click={() => setMode('range')}
    >2 Commits</button>
    <button
      role="tab"
      aria-selected={mode === 'branch'}
      on:click={() => setMode('branch')}
    >2 Branches</button>
  </div>

  <!-- Input area -->
  <section class="input-area" aria-label="Compare inputs">
    {#if mode === 'commit'}
      <div class="input-row">
        <Combobox
          items={commitItems}
          bind:value={commitValue}
          placeholder="Select commit…"
          aria-label="Commit"
          on:select={handleCommitSelect}
          on:blur={handleCommitSelect}
        />
      </div>
    {:else if mode === 'range'}
      <div class="input-row dual">
        <Combobox
          items={commitItems}
          bind:value={baseCommitValue}
          placeholder="Base commit…"
          aria-label="Base commit"
          on:select={handleRangeSelect}
          on:blur={handleRangeSelect}
        />
        <button class="icon-btn swap-btn" title="Swap base and head" aria-label="Swap base and head"
          on:click={swapInputs}>⇄</button>
        <Combobox
          items={commitItems}
          bind:value={headCommitValue}
          placeholder="Head commit…"
          aria-label="Head commit"
          on:select={handleRangeSelect}
          on:blur={handleRangeSelect}
        />
      </div>
    {:else}
      <div class="input-row dual">
        <Combobox
          items={branchItems}
          bind:value={baseBranchValue}
          placeholder="Base branch…"
          aria-label="Base branch"
          on:select={handleBranchSelect}
          on:blur={handleBranchSelect}
        />
        <button class="icon-btn swap-btn" title="Swap base and head" aria-label="Swap base and head"
          on:click={swapInputs}>⇄</button>
        <Combobox
          items={branchItems}
          bind:value={headBranchValue}
          placeholder="Head branch…"
          aria-label="Head branch"
          on:select={handleBranchSelect}
          on:blur={handleBranchSelect}
        />
      </div>
    {/if}
  </section>

  <!-- Action bar -->
  <section class="action-bar" aria-label="Review actions">
    <select aria-label="Provider" bind:value={selectedProvider} on:change={saveSettings}>
      {#each providers as provider (provider.id)}
        <option value={provider.id} disabled={!provider.available}>{provider.name}</option>
      {/each}
    </select>
    <input aria-label="Model" placeholder="model (optional)"
      bind:value={modelInput} on:change={saveSettings} />
    <button class="review-btn" disabled={!canReview} on:click={startReview}>
      Review
    </button>
  </section>

  {#if error}<div class="error" role="alert">{error}</div>{/if}

  <!-- Body: files + reviews side by side -->
  <div class="body">
    <section class="pane files-pane" aria-label="Changed files">
      <h3>
        Changed files
        {#if files}
          ({files.length})
          <span class="add">+{totalAdditions}</span>
          <span class="del">−{totalDeletions}</span>
        {/if}
        <span class="view-toggle">
          <button class="icon-btn" class:active={viewMode === 'tree'} title="View as tree"
            aria-label="View as tree" aria-pressed={viewMode === 'tree'}
            on:click={() => setViewMode('tree')}>☷</button>
          <button class="icon-btn" class:active={viewMode === 'flat'} title="View as list"
            aria-label="View as list" aria-pressed={viewMode === 'flat'}
            on:click={() => setViewMode('flat')}>☰</button>
        </span>
      </h3>
      {#if compareLoading}
        <p class="hint">Comparing…</p>
      {:else if !canCompare}
        <p class="hint">Pick inputs to compare.</p>
      {:else if files && files.length === 0}
        <p class="hint">No differences.</p>
      {:else if files && viewMode === 'tree'}
        <FileTreeList
          nodes={fileTree}
          {collapsedFolders}
          on:folderToggle={(event) => toggleFolder(event.detail.path)}
          on:openFile={(event) => openFile(event.detail)}
        />
      {:else if files}
        <ul>
          {#each files as file (file.path)}
            <li>
              <button class="file-row" on:click={() => openFile(file)}>
                <span class="path">{file.path}</span>
                {#if !file.binary}
                  <span class="add">+{file.additions}</span>
                  <span class="del">−{file.deletions}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="pane reviews-pane" aria-label="Reviews">
      <h3 class="reviews-title">
        Reviews
        {#if hasRunning}<LoadingSpinner label="Review running…" />{/if}
      </h3>
      {#if reviews.length === 0}
        <p class="hint">No reviews yet.</p>
      {/if}
      <ul>
        {#each reviews as entry (entry.id)}
          <li class="review-row" class:latest={entry.id === latestStartedId}>
            <button class="open" title="Open review" on:click={() => rowAction('review.open', entry)}>
              {#if entry.status === 'running'}
                <!-- Replaces the static ⟳: same slot, same colour, now actually moving.
                     The pane heading spinner is the summary; this one is per-entry, and
                     its label is the first text alternative this status has ever had. -->
                <span class="status status-running"><LoadingSpinner label="Review running…" /></span>
              {:else}
                <span class="status status-{entry.status}">{statusIcon(entry.status)}</span>
              {/if}
              <span class="label">{entryLabel(entry)}</span>
              <span class="time">{timeLabel(entry)}</span>
            </button>
            {#if entry.status === 'running'}
              <button class="icon-btn" title="Cancel" aria-label="Cancel"
                on:click={() => rowAction('review.cancel', entry)}>✕</button>
            {:else}
              <button class="icon-btn" title="Re-run" aria-label="Re-run"
                on:click={() => rowAction('review.rerun', entry)}>↻</button>
              <button class="icon-btn" title="Delete" aria-label="Delete"
                on:click={() => rowAction('review.delete', entry)}>🗑</button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  </div>
</div>

<style>
  .review-app {
    height: 100%;
    display: flex;
    flex-direction: column;
    color: var(--vscode-foreground);
    font-size: 12px;
  }
  .repo-picker {
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    flex: none;
  }
  .repo-picker select {
    width: 100%;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    padding: 3px 6px;
  }
  .mode-tabs {
    display: flex;
    gap: 0;
    padding: 0 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    flex: none;
  }
  .mode-tabs button {
    flex: 1;
    padding: 6px 8px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 12px;
    opacity: 0.7;
  }
  .mode-tabs button[aria-selected="true"] {
    opacity: 1;
    border-bottom-color: var(--vscode-focusBorder, #007acc);
  }
  .mode-tabs button:hover { opacity: 1; }
  .input-area {
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    flex: none;
  }
  .input-row { display: flex; align-items: center; gap: 6px; }
  .input-row.dual { display: flex; }
  .swap-btn { flex: none; }
  .action-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    flex: none;
  }
  .action-bar select, .action-bar input {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    padding: 2px 4px;
    max-width: 180px;
  }
  .action-bar input { width: 140px; }
  .icon-btn {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 2px;
  }
  .icon-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  .icon-btn:disabled { opacity: 0.4; cursor: default; }
  .view-toggle { float: right; display: inline-flex; gap: 2px; }
  .view-toggle .icon-btn.active {
    background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground));
  }
  .review-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    padding: 3px 12px;
    cursor: pointer;
  }
  .review-btn:disabled { opacity: 0.5; cursor: default; }
  .error {
    flex: none;
    padding: 4px 10px;
    color: var(--vscode-errorForeground);
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  }
  .body { flex: 1; display: flex; min-height: 0; }
  .pane { flex: 1; min-width: 0; overflow-y: auto; padding: 6px 10px; }
  .files-pane { border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35)); }
  .pane h3 {
    margin: 0 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.8;
  }
  .reviews-title {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pane ul { list-style: none; margin: 0; padding: 0; }
  .hint { opacity: 0.7; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .file-row, .review-row .open {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 3px 4px;
    border-radius: 3px;
    text-align: left;
  }
  .file-row:hover, .review-row .open:hover { background: var(--vscode-list-hoverBackground); }
  .file-row .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .review-row { display: flex; align-items: center; }
  .review-row .open { flex: 1; min-width: 0; }
  .review-row.latest { background: var(--vscode-list-inactiveSelectionBackground); border-radius: 3px; }
  .review-row .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .review-row .time { opacity: 0.7; flex: none; }
  .status { flex: none; width: 14px; text-align: center; }
  .status-running { color: var(--vscode-charts-blue, #3794ff); }
  .status-done { color: var(--vscode-charts-green, #89d185); }
  .status-failed { color: var(--vscode-errorForeground); }
  .status-cancelled, .status-interrupted { opacity: 0.7; }
</style>
