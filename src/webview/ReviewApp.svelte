<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { bridge } from './lib/message-bridge';
  import { LatestRequestGate, runLatestRequest } from './lib/latest-request';
  import FileTreeList from './components/detail/FileTreeList.svelte';
  import { buildPathTree } from './lib/path-tree';
  import Combobox from './components/Combobox.svelte';
  import LoadingSpinner from './components/common/LoadingSpinner.svelte';

  type Mode = 'commit' | 'range' | 'branch' | 'pr';
  type ReviewStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  type PrReviewerStatus = 'approved' | 'changes_requested' | 'pending' | 'commented';

  interface Repo { path: string; name: string; active: boolean }
  interface Branch { name: string; current?: boolean }
  interface Commit { hash: string; abbreviatedHash: string; subject: string; authorDate: string }
  interface Provider { id: string; name: string; available: boolean; group: string }
  interface FileChange {
    path: string; oldPath: string | null; status: string;
    additions: number; deletions: number; binary: boolean;
  }
  interface ForgeUser { displayName: string; accountId: string }
  interface PullRequestSummary {
    id: string; number: number; title: string; state: string;
    sourceBranch: string; targetBranch: string;
    reviewers: { user: ForgeUser; status: PrReviewerStatus }[];
    commentCount: number; webUrl: string; updatedAt: string;
  }
  interface ReviewEntry {
    id: string; kind: Mode;
    baseRef: string; baseSha: string; headRef: string; headSha: string;
    subject?: string;
    /** Present only for kind 'pr'. */
    prId?: string; prNumber?: number; providerId?: string;
    provider: string; model: string; status: ReviewStatus;
    startedAt: string; finishedAt?: string; error?: string;
  }
  interface ComboItem { label: string; value: string; detail?: string }
  interface StoredTarget {
    kind: Mode; baseRef: string; headRef: string; subject?: string; prId?: string;
  }

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

  // Pull Request mode
  let forgeAvailable = false;
  let pullRequests: PullRequestSummary[] = [];
  let selectedPrId = '';
  let selectedPr: PullRequestSummary | null = null;

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

  $: prItems = pullRequests.map((pr): ComboItem => ({
    label: `#${pr.number} ${pr.title}`,
    value: pr.id,
    detail: pr.sourceBranch,
  }));

  $: canCompare = (() => {
    switch (mode) {
      case 'commit': return !!commitValue;
      case 'range': return !!baseCommitValue && !!headCommitValue;
      case 'branch': return !!baseBranchValue && !!headBranchValue;
      case 'pr': return !!selectedPrId;
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
      const t = data as StoredTarget;
      mode = t.kind;
      applyTarget(t);
      files = null;
      error = '';
      refreshFiles();
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
      const [repoList, branchList, commitList, providerList, savedProvider, savedModel, storedTarget, savedViewMode, savedMode, forgeStatus] = await Promise.all([
        bridge.send('review.getRepos') as Promise<Repo[]>,
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('review.getCommits') as Promise<Commit[]>,
        bridge.send('ai.providers') as Promise<Provider[]>,
        bridge.send('ui.getState', { key: 'aiReview.provider' }) as Promise<string | null>,
        bridge.send('ui.getState', { key: 'aiReview.model' }) as Promise<string | null>,
        bridge.send('review.getTarget') as Promise<StoredTarget | null>,
        bridge.send('ui.getState', { key: 'detail.viewMode' }) as Promise<string | null>,
        bridge.send('ui.getState', { key: 'review.mode' }) as Promise<string | null>,
        // forge.status never prompts and is safe on every panel load, the
        // same as the sidebar section — a repository with no forge remote
        // must produce no error and no console noise, so a rejection here
        // is swallowed rather than failing the rest of init.
        (bridge.send('forge.status') as Promise<{ available: boolean }>).catch(() => ({ available: false })),
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

      forgeAvailable = Boolean(forgeStatus?.available);
      if (forgeAvailable) {
        void loadPullRequestList();
      } else {
        pullRequests = [];
        selectedPrId = '';
        selectedPr = null;
      }

      if (!targetOverridden) {
        const validModes: Mode[] = forgeAvailable
          ? ['commit', 'range', 'branch', 'pr']
          : ['commit', 'range', 'branch'];
        if (savedMode && validModes.includes(savedMode as Mode)) {
          mode = savedMode as Mode;
        }
        // A stored target of kind 'pr' is restored only when the repository
        // still has a forge provider — the mode it belongs to is absent
        // otherwise, so falling back to defaults is the only sound choice.
        if (storedTarget && (storedTarget.kind !== 'pr' || forgeAvailable)) {
          mode = storedTarget.kind;
          applyTarget(storedTarget);
        } else {
          applyDefaults();
        }
      }

      await refreshReviews();
      if (mode === 'pr') {
        if (selectedPrId) void loadPullRequestContext(selectedPrId);
      } else {
        void compare();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function applyTarget(t: StoredTarget): void {
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
      case 'pr':
        selectedPrId = t.prId ?? '';
        break;
    }
  }

  /** Dispatches to the git-based compare or the pull request file fetch, whichever the current mode needs. */
  function refreshFiles(): void {
    if (mode === 'pr') {
      if (selectedPrId) void loadPullRequestFiles(selectedPrId);
      else files = null;
    } else {
      void compare();
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
    // Clear the git-based inputs and files on mode switch. The pull request
    // selection is deliberately not cleared here — switching away from
    // Pull Request mode and back must not lose it.
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
    }
    refreshFiles();
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
      const [branchList, commitList, forgeStatus] = await Promise.all([
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('review.getCommits') as Promise<Commit[]>,
        (bridge.send('forge.status') as Promise<{ available: boolean }>).catch(() => ({ available: false })),
      ]);
      branches = branchList ?? [];
      commits = commitList ?? [];

      // A pull request id belongs to the repository it came from — it must
      // not carry over to a different repository selected from the picker.
      forgeAvailable = Boolean(forgeStatus?.available);
      selectedPrId = '';
      selectedPr = null;
      pullRequests = [];
      if (forgeAvailable) {
        void loadPullRequestList();
      } else if (mode === 'pr') {
        mode = 'branch';
      }

      applyDefaults();
      files = null;
      refreshFiles();
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

  function getCompareParams(): { kind: Mode; baseRef: string; headRef: string; prId?: string; subject?: string } {
    switch (mode) {
      case 'commit': return { kind: 'commit', baseRef: `${commitValue}~1`, headRef: commitValue };
      case 'range': return { kind: 'range', baseRef: baseCommitValue, headRef: headCommitValue };
      case 'branch': return { kind: 'branch', baseRef: baseBranchValue, headRef: headBranchValue };
      case 'pr': return {
        kind: 'pr', baseRef: '', headRef: '', prId: selectedPrId,
        ...(selectedPr?.title ? { subject: selectedPr.title } : {}),
      };
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

  // --- Pull Request mode ---

  /** Populates the combobox's candidates. Never called when there is no provider. */
  async function loadPullRequestList(): Promise<void> {
    try {
      const result = await bridge.send('forge.pr.list') as { pullRequests: PullRequestSummary[] };
      pullRequests = result.pullRequests ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Changed files for the selected pull request, from `forge.pr.files` —
   * never `review.compare` or a git diff. Routed through the same gate as
   * the git-based `compare()` so a stale response from a fetch superseded by
   * a newer selection can never win.
   */
  async function loadPullRequestFiles(prId: string): Promise<void> {
    compareLoading = true;
    try {
      await runLatestRequest(
        compareGate,
        () => bridge.send('forge.pr.files', { id: prId }) as Promise<{ files: FileChange[] }>,
        (result) => { files = result.files; error = ''; },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      compareLoading = false;
    }
  }

  /**
   * Resolves the full summary (title, reviewers) for a pull request id that
   * did not come from the freshly-selected combobox item — the restore path
   * after a reload, where the list may not have loaded yet or the pull
   * request may have left the "open" list since it was reviewed.
   */
  async function loadPullRequestContext(prId: string): Promise<void> {
    selectedPr = pullRequests.find(pr => pr.id === prId) ?? null;
    if (!selectedPr) {
      try {
        selectedPr = await bridge.send('forge.pr.get', { id: prId }) as PullRequestSummary;
      } catch {
        // Leave selectedPr null — the reviewer chips just won't show; the
        // combobox still carries the id and the Review button still works.
      }
    }
    void loadPullRequestFiles(prId);
  }

  function handlePrSelect(): void {
    if (!selectedPrId) {
      selectedPr = null;
      files = null;
      return;
    }
    selectedPr = pullRequests.find(pr => pr.id === selectedPrId) ?? null;
    saveTarget();
    void loadPullRequestFiles(selectedPrId);
  }

  function reviewerCount(pr: PullRequestSummary, status: PrReviewerStatus): number {
    return pr.reviewers.filter(r => r.status === status).length;
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
    // A pull request's head commit is usually not fetched locally, so there
    // is no diff editor this can safely open yet — see PullRequestDetail.svelte
    // for the same reasoning. The file rows stay display-only in this mode.
    if (mode === 'pr') return;
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
    if (entry.kind === 'pr') {
      const number = entry.prNumber !== undefined ? `#${entry.prNumber}` : '#?';
      return `PR ${number}${entry.subject ? ` ${entry.subject}` : ''}`;
    }
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
    {#if forgeAvailable}
      <button
        role="tab"
        aria-selected={mode === 'pr'}
        on:click={() => setMode('pr')}
      >Pull Request</button>
    {/if}
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
    {:else if mode === 'branch'}
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
    {:else}
      <div class="input-row">
        <Combobox
          items={prItems}
          bind:value={selectedPrId}
          placeholder="Select pull request…"
          aria-label="Pull request"
          on:select={handlePrSelect}
          on:blur={handlePrSelect}
        />
      </div>
      {#if selectedPr}
        <div class="pr-target-summary">
          <span class="pr-number">#{selectedPr.number}</span>
          <span class="pr-title">{selectedPr.title}</span>
          {#if reviewerCount(selectedPr, 'approved') > 0}
            <span class="pr-chip approved" aria-label="{reviewerCount(selectedPr, 'approved')} approved">
              ✓{reviewerCount(selectedPr, 'approved')}
            </span>
          {/if}
          {#if reviewerCount(selectedPr, 'changes_requested') > 0}
            <span class="pr-chip changes" aria-label="{reviewerCount(selectedPr, 'changes_requested')} requested changes">
              ✗{reviewerCount(selectedPr, 'changes_requested')}
            </span>
          {/if}
          {#if reviewerCount(selectedPr, 'pending') > 0}
            <span class="pr-chip pending" aria-label="{reviewerCount(selectedPr, 'pending')} pending">
              …{reviewerCount(selectedPr, 'pending')}
            </span>
          {/if}
        </div>
      {/if}
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
              <button class="file-row" disabled={mode === 'pr'} on:click={() => openFile(file)}>
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
  .pr-target-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 11px;
  }
  .pr-target-summary .pr-number { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .pr-target-summary .pr-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-chip { flex-shrink: 0; }
  .pr-chip.approved { color: var(--vscode-testing-iconPassed); }
  .pr-chip.changes { color: var(--vscode-testing-iconFailed); }
  .pr-chip.pending { opacity: 0.7; }
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
  .file-row:hover:not(:disabled), .review-row .open:hover { background: var(--vscode-list-hoverBackground); }
  .file-row:disabled { cursor: default; }
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
