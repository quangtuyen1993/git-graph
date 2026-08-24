<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { bridge } from './lib/message-bridge';
  import { LatestRequestGate, runLatestRequest } from './lib/latest-request';

  type ReviewTargetKind = 'branch' | 'commit' | 'range';
  type ReviewStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

  interface Branch { name: string; current?: boolean }
  interface Provider { id: string; name: string; available: boolean; group: 'cli' | 'api' }
  interface FileChange {
    path: string; oldPath: string | null; status: string;
    additions: number; deletions: number; binary: boolean;
  }
  interface ReviewTarget { kind: ReviewTargetKind; baseRef: string; headRef: string; subject?: string }
  interface ReviewEntry {
    id: string; kind: ReviewTargetKind;
    baseRef: string; baseSha: string; headRef: string; headSha: string;
    subject?: string; provider: string; model: string; status: ReviewStatus;
    startedAt: string; finishedAt?: string; error?: string;
  }

  let branches: Branch[] = [];
  let providers: Provider[] = [];
  let reviews: ReviewEntry[] = [];
  let target: ReviewTarget = { kind: 'branch', baseRef: '', headRef: '' };
  let files: FileChange[] | null = null;
  let compareLoading = false;
  let selectedProvider = '';
  let modelInput = '';
  let error = '';
  let latestStartedId = '';
  let now = Date.now();
  // Một sự kiện review.target có thể tới trước khi init() lấy xong target mặc định
  // (host gửi ngay khi người dùng chọn "Review" từ graph); cờ này giữ cho init()
  // không ghi đè lựa chọn đó bằng giá trị mặc định đến muộn hơn.
  let targetOverridden = false;

  const compareGate = new LatestRequestGate();
  const unsubscribers: Array<() => void> = [];

  onMount(() => {
    unsubscribers.push(bridge.on('review.changed', () => { void refreshReviews(); }));
    unsubscribers.push(bridge.on('review.target', (data) => {
      targetOverridden = true;
      target = data as ReviewTarget;
      files = null;
      error = '';
      void compare();
    }));
    // The review webview is retainContextWhenHidden and never re-resolved, so
    // a host-side repo switch (graph's repo picker) never reaches it on its
    // own. Drop the stale branch list/target/files and re-run the same
    // initialization used at mount, against the newly active repo.
    unsubscribers.push(bridge.on('repo.changed', () => {
      targetOverridden = false;
      files = null;
      error = '';
      void init();
    }));
    void init();
  });

  onDestroy(() => {
    unsubscribers.forEach(unsubscribe => unsubscribe());
    if (ticker !== undefined) clearInterval(ticker);
  });

  async function init(): Promise<void> {
    try {
      const [branchList, providerList, savedProvider, savedModel, storedTarget] = await Promise.all([
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('ai.providers') as Promise<Provider[]>,
        bridge.send('ui.getState', { key: 'aiReview.provider' }) as Promise<string | null>,
        bridge.send('ui.getState', { key: 'aiReview.model' }) as Promise<string | null>,
        bridge.send('review.getTarget') as Promise<ReviewTarget | null>,
      ]);
      branches = branchList ?? [];
      providers = providerList ?? [];
      const available = providers.filter(p => p.available);
      selectedProvider = savedProvider && available.some(p => p.id === savedProvider)
        ? savedProvider
        : (available[0]?.id ?? '');
      modelInput = savedModel ?? '';
      if (!targetOverridden) {
        target = storedTarget ?? defaultTarget();
      }
      await refreshReviews();
      void compare();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function defaultTarget(): ReviewTarget {
    const head = branches.find(b => b.current)?.name ?? '';
    const base = ['main', 'master'].find(name =>
      name !== head && branches.some(b => b.name === name)) ?? '';
    return { kind: 'branch', baseRef: base, headRef: head };
  }

  async function refreshReviews(): Promise<void> {
    try {
      reviews = (await bridge.send('review.list') as ReviewEntry[]) ?? [];
    } catch {
      // Danh sách cũ trên màn hình vẫn đúng hơn là một danh sách trống.
    }
  }

  $: canCompare = !!target.headRef && !!target.baseRef;

  async function compare(): Promise<void> {
    if (!canCompare) { files = null; return; }
    compareLoading = true;
    try {
      await runLatestRequest(
        compareGate,
        () => bridge.send('review.compare', {
          kind: target.kind, baseRef: target.baseRef, headRef: target.headRef,
        }) as Promise<{ files: FileChange[] }>,
        (result) => { files = result.files; error = ''; },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      compareLoading = false;
    }
  }

  function setBranch(side: 'base' | 'head', name: string): void {
    target = side === 'base'
      ? { kind: 'branch', baseRef: name, headRef: target.headRef }
      : { kind: 'branch', baseRef: target.baseRef, headRef: name };
    files = null;
    void compare();
  }

  function swap(): void {
    target = { ...target, baseRef: target.headRef, headRef: target.baseRef };
    files = null;
    void compare();
  }

  function clearChip(): void {
    target = defaultTarget();
    files = null;
    error = '';
    void compare();
  }

  async function startReview(): Promise<void> {
    if (!canCompare || !selectedProvider) return;
    error = '';
    try {
      const started = await bridge.send('review.start', {
        kind: target.kind, baseRef: target.baseRef, headRef: target.headRef,
        provider: selectedProvider, model: modelInput,
      }) as { id: string };
      latestStartedId = started.id;
      await refreshReviews();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function saveSettings(): void {
    void bridge.send('ui.setState', { key: 'aiReview.provider', value: selectedProvider });
    void bridge.send('ui.setState', { key: 'aiReview.model', value: modelInput });
  }

  async function openFile(file: FileChange): Promise<void> {
    try {
      await bridge.send('ui.compareDiff', {
        sourceBranch: target.baseRef, targetBranch: target.headRef,
        path: file.path, oldPath: file.oldPath, status: file.status,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

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

  function chipLabel(t: ReviewTarget): string {
    return t.kind === 'commit'
      ? `${t.headRef.slice(0, 7)}${t.subject ? ` "${t.subject}"` : ''}`
      : `${t.baseRef.slice(0, 7)}..${t.headRef.slice(0, 7)}`;
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

  // Đồng hồ chỉ chạy khi có run đang chạy — không có interval mồ côi lúc im ắng.
  let ticker: ReturnType<typeof setInterval> | undefined;
  $: hasRunning = reviews.some(r => r.status === 'running');
  $: if (hasRunning && ticker === undefined) {
    ticker = setInterval(() => { now = Date.now(); }, 1000);
  } else if (!hasRunning && ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
    now = Date.now();
  }

  $: totalAdditions = files?.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  $: totalDeletions = files?.reduce((sum, f) => sum + f.deletions, 0) ?? 0;
</script>

<div class="review-app">
  <header class="toolbar" aria-label="Review toolbar">
    {#if target.kind === 'branch'}
      <select aria-label="Base branch" value={target.baseRef}
        on:change={(e) => setBranch('base', e.currentTarget.value)}>
        <option value="" disabled>base…</option>
        {#each branches as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}
      </select>
      <span class="arrow">←</span>
      <select aria-label="Head branch" value={target.headRef}
        on:change={(e) => setBranch('head', e.currentTarget.value)}>
        <option value="" disabled>head…</option>
        {#each branches as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}
      </select>
      <button class="icon-btn" title="Swap base and head" aria-label="Swap base and head"
        on:click={swap} disabled={!canCompare}>⇄</button>
    {:else}
      <span class="chip">
        {chipLabel(target)}
        {#if target.kind === 'range'}
          <button class="icon-btn" title="Swap base and head" aria-label="Swap base and head"
            on:click={swap}>⇄</button>
        {/if}
        <button class="icon-btn" title="Back to branch compare" aria-label="Back to branch compare"
          on:click={clearChip}>✕</button>
      </span>
    {/if}
    <span class="spacer"></span>
    <select aria-label="Provider" bind:value={selectedProvider} on:change={saveSettings}>
      {#each providers as provider (provider.id)}
        <option value={provider.id} disabled={!provider.available}>{provider.name}</option>
      {/each}
    </select>
    <input aria-label="Model" placeholder="model (optional)"
      bind:value={modelInput} on:change={saveSettings} />
    <button class="review-btn" disabled={!canCompare || !selectedProvider} on:click={startReview}>
      Review
    </button>
  </header>

  {#if error}<div class="error" role="alert">{error}</div>{/if}

  <div class="body">
    <section class="pane files-pane" aria-label="Changed files">
      <h3>
        Changed files
        {#if files}
          ({files.length})
          <span class="add">+{totalAdditions}</span>
          <span class="del">−{totalDeletions}</span>
        {/if}
      </h3>
      {#if compareLoading}
        <p class="hint">Comparing…</p>
      {:else if !canCompare}
        <p class="hint">Pick a base and a head to compare.</p>
      {:else if files && files.length === 0}
        <p class="hint">No differences.</p>
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
      <h3>Reviews</h3>
      {#if reviews.length === 0}
        <p class="hint">No reviews yet.</p>
      {/if}
      <ul>
        {#each reviews as entry (entry.id)}
          <li class="review-row" class:latest={entry.id === latestStartedId}>
            <button class="open" title="Open review" on:click={() => rowAction('review.open', entry)}>
              <span class="status status-{entry.status}">{statusIcon(entry.status)}</span>
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
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    flex: none;
  }
  .toolbar select, .toolbar input {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    padding: 2px 4px;
    max-width: 180px;
  }
  .toolbar input { width: 140px; }
  .arrow { opacity: 0.7; }
  .spacer { flex: 1; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
  }
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
