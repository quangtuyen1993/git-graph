<script context="module" lang="ts">
  // svelte-check: `export` of a type-only declaration is only valid in
  // `<script context="module">` — see PullRequestList.svelte's identical note.
  export type ReviewRowStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  export type ReviewRowKind = 'branch' | 'commit' | 'range' | 'pr' | 'worktree';

  /**
   * Mirrors `ReviewEntry` (src/extension/services/review-store.ts) — the
   * webview never imports extension types directly, the same reason
   * PullRequestList mirrors the forge pull request shape instead of
   * importing it. No files list, no body: those never crossed the wire for
   * `review.list`, and this row doesn't need them.
   */
  export interface ReviewRow {
    id: string;
    kind: ReviewRowKind;
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    subject?: string;
    prId?: string;
    prNumber?: number;
    providerId?: string;
    provider: string;
    model: string;
    status: ReviewRowStatus;
    startedAt: string;
    finishedAt?: string;
    error?: string;
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { reviewTargetLabel } from '../../lib/review-target-label';

  export let reviews: ReviewRow[] = [];
  export let query = '';

  const dispatch = createEventDispatcher<{ select: { id: string } }>();

  /* Same label the row renders is the label the search box matches — the
     resolved ambiguity from the brief. No second filtering mechanism. */
  $: needle = query.trim().toLowerCase();
  $: visible = needle
    ? reviews.filter((entry) => reviewTargetLabel(entry).toLowerCase().includes(needle))
    : reviews;

  const STATUS_LABEL: Record<ReviewRowStatus, string> = {
    running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
  };

  const STATUS_GLYPH: Record<ReviewRowStatus, string> = {
    running: '⧗', done: '✓', failed: '✗', cancelled: '⊘', interrupted: '⚠',
  };

  function timeLabel(entry: ReviewRow): string {
    const at = entry.status === 'running' ? entry.startedAt : (entry.finishedAt ?? entry.startedAt);
    const minutes = Math.floor((Date.now() - new Date(at).getTime()) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  }
</script>

{#if visible.length === 0}
  <div class="review-empty">{needle ? 'No matching reviews' : 'No reviews'}</div>
{:else}
  {#each visible as entry (entry.id)}
    <button type="button" class="review-row" on:click={() => dispatch('select', { id: entry.id })}>
      <span class="review-status status-{entry.status}" aria-label={STATUS_LABEL[entry.status]}>
        {STATUS_GLYPH[entry.status]}
      </span>
      <span class="review-target">{reviewTargetLabel(entry)}</span>
      <span class="review-provider">{entry.provider}{entry.model ? ` · ${entry.model}` : ''}</span>
      <span class="review-time">{timeLabel(entry)}</span>
      {#if entry.status === 'failed' && entry.error}
        <span class="review-error">{entry.error}</span>
      {/if}
    </button>
  {/each}
{/if}

<style>
  .review-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 8px 3px 20px;
    border: none;
    background: none;
    color: var(--vscode-foreground);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .review-row:hover { background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04)); }
  .review-status { font-size: 10px; flex-shrink: 0; }
  .review-status.status-done { color: var(--vscode-testing-iconPassed); }
  .review-status.status-failed { color: var(--vscode-testing-iconFailed); }
  .review-status.status-running { color: var(--vscode-charts-yellow, #cca700); }
  .review-status.status-cancelled,
  .review-status.status-interrupted { color: var(--vscode-descriptionForeground); }
  .review-target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .review-provider {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .review-time { flex-shrink: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .review-error {
    flex-basis: 100%;
    color: var(--vscode-testing-iconFailed);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .review-empty {
    padding: 3px 8px 3px 20px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-style: italic;
  }
</style>
