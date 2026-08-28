<!--
  The third mode of the right-hand detail panel — the sibling of CommitDetail
  and PullRequestDetail — showing one AI code review.

  See docs/superpowers/specs/2026-08-28-review-in-graph-design.md, "One
  surface, two states": this component is what `review.compare` opens (no run
  yet — the diff-only state) and what a review shows before its run produces
  anything, so it is one component rather than two.
-->
<script context="module" lang="ts">
  // svelte-check: `export` of a type-only declaration is only valid in
  // `<script context="module">` — see PullRequestDetail.svelte's identical note.
  export type ReviewDetailKind = 'branch' | 'commit' | 'range' | 'pr';
  export type ReviewDetailStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

  /**
   * The resolved diff pair this panel shows — present whenever there is
   * something to diff, whether or not a review has ever run against it. Kept
   * separate from `ReviewDetailRun` below so the diff-only state needs no
   * placeholder run metadata (no id, no provider, no status). A caller
   * holding a full `ReviewEntry` (review-store.ts) passes it as both `target`
   * and `run` — a `ReviewEntry` is a strict superset of each.
   */
  export interface ReviewDetailTarget {
    kind: ReviewDetailKind;
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    subject?: string;
    prNumber?: number;
  }

  /** Run metadata that exists only once a review has actually started. */
  export interface ReviewDetailRun {
    id: string;
    provider: string;
    model: string;
    status: ReviewDetailStatus;
    startedAt: string;
    finishedAt?: string;
    error?: string;
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { reviewTargetLabel } from '../../lib/review-target-label';

  interface ChangedFile {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }

  // Named `reviewTarget` rather than `target`: the latter collides with
  // @testing-library/svelte's `render()` mount-target option, which rejects
  // any prop named `target` passed in the codebase's usual flat-props form.
  export let reviewTarget: ReviewDetailTarget | null = null;
  export let run: ReviewDetailRun | null = null;
  /**
   * The reviewed markdown. For a running review this is whatever the runner
   * has flushed so far (review-runner.ts's `BodyStream` writes to the same
   * file `review.body` reads, on a ~1s cadence) — re-rendering with a
   * growing `body` prop is this panel's progress indicator; see the note on
   * the running branch below for why there is no separate spinner.
   */
  export let body = '';
  export let files: ChangedFile[] | null = null;

  const dispatch = createEventDispatcher<{
    rerun: void;
    openAsFile: void;
    delete: void;
    openFile: ChangedFile;
  }>();

  function shortSha(sha: string): string {
    return sha ? sha.slice(0, 7) : '';
  }

  function statusLetter(status: string): string {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    if (status === 'renamed') return 'R';
    return 'M';
  }

  /** `2 minutes ago` — mirrors ReviewList.svelte's row timestamp. */
  function timeAgo(iso: string): string {
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  }
</script>

{#if reviewTarget}
  <div class="review-detail">
    <header class="review-header">
      <span class="review-title">Review · {reviewTargetLabel(reviewTarget)}</span>
      {#if run}
        <span class="review-actions">
          <button type="button" on:click={() => dispatch('rerun')}>Re-run</button>
          <button type="button" on:click={() => dispatch('openAsFile')}>Open as file</button>
          <button type="button" class="review-delete" on:click={() => dispatch('delete')}>Delete</button>
        </span>
      {/if}
    </header>

    {#if run}
      <div class="review-byline">
        {run.provider}{run.model ? ` · ${run.model}` : ''} · {timeAgo(run.finishedAt ?? run.startedAt)}
      </div>
    {/if}

    <!-- Requirement 2: the derived base is load-bearing — it is derived in
         three of five cases (a commit's parent, a pull request's target
         branch, the working tree's HEAD), exactly the cases the user did not
         choose, so it renders as plain text rather than behind a tab. -->
    <div class="review-endpoints">
      <div class="review-endpoint">
        <span class="endpoint-label">base</span>
        <code class="endpoint-sha">{shortSha(reviewTarget.baseSha)}</code>
        <span class="endpoint-name">{reviewTarget.baseRef}</span>
      </div>
      <div class="review-endpoint">
        <span class="endpoint-label">head</span>
        <code class="endpoint-sha">{shortSha(reviewTarget.headSha)}</code>
        <span class="endpoint-name">{reviewTarget.headRef}</span>
      </div>
    </div>

    {#if run}
      {#if run.status === 'failed'}
        <!-- Requirement 6: shown in full, here — not by opening the file. -->
        <div class="review-error" role="alert">{run.error || 'Review failed.'}</div>
      {:else if body}
        <!-- Requirement 3 (done) / Requirement 8 (running): the same block
             renders the finished body or the streamed-so-far text. No
             spinner: the growing text itself is the progress signal, per
             the design's "no push channel" ruling — the host polls
             review.body while status is 'running' and re-passes it here. -->
        <div class="review-body">{body}</div>
      {:else if run.status === 'running'}
        <div class="review-body review-body-pending">Waiting for the review's first output…</div>
      {/if}
    {/if}

    <!-- Requirement 4: the changed-file list, always flat like
         PullRequestDetail — see that component's comment on why. Rows open
         a diff whether this is a finished review or the diff-only state. -->
    <section class="review-files" aria-label="Changed files">
      <h3>Files ({files?.length ?? 0})</h3>
      <ul class="review-file-list">
        {#each files ?? [] as file, fileIndex (fileIndex + ':' + file.path)}
          <li>
            <button
              type="button"
              class="review-file-row"
              title={file.path}
              on:click={() => dispatch('openFile', file)}
            >
              <span class="review-file-path">{file.path}</span>
              <span class="review-file-meta">
                {#if file.binary}
                  <span class="file-binary">BIN</span>
                {:else}
                  {#if file.additions > 0}<span class="file-add">+{file.additions}</span>{/if}
                  {#if file.deletions > 0}<span class="file-del">-{file.deletions}</span>{/if}
                {/if}
                <span class="file-status file-status-{file.status}">{statusLetter(file.status)}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  </div>
{/if}

<style>
  .review-detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 16px;
    font-size: 12px;
    color: var(--vscode-foreground, #ccc);
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
  }

  .review-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .review-title {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .review-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .review-actions button {
    padding: 2px 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit);
    font-size: 11px;
    cursor: pointer;
  }

  .review-actions button:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
  }

  .review-delete {
    color: var(--vscode-errorForeground, #f44747);
  }

  .review-byline {
    color: var(--vscode-descriptionForeground, #888);
  }

  .review-endpoints {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 0;
    border-top: 1px solid var(--vscode-panel-border, #2b2b2b);
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .review-endpoint {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .endpoint-label {
    width: 32px;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground, #888);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
  }

  .endpoint-sha {
    color: var(--vscode-textLink-foreground, #3794ff);
  }

  .endpoint-name {
    color: var(--vscode-foreground, #ccc);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .review-error {
    padding: 8px;
    border-radius: 3px;
    background: var(--vscode-inputValidation-errorBackground, rgba(244, 71, 71, 0.1));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #f44747);
    color: var(--vscode-errorForeground, #f44747);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .review-body {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }

  .review-body-pending {
    color: var(--vscode-descriptionForeground, #888);
    font-style: italic;
  }

  h3 {
    margin: 0 0 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground, #888);
  }

  .review-file-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .review-file-row {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 8px;
    min-height: 22px;
    padding: 2px 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .review-file-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
  }

  .review-file-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .review-file-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-textLink-foreground, #3794ff);
  }

  .review-file-meta {
    margin-left: auto;
    padding-left: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    font-size: 11px;
  }

  .file-add { color: var(--vscode-gitDecoration-addedResourceForeground, #6a9955); }
  .file-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .file-binary { color: var(--vscode-descriptionForeground, #767676); }

  .file-status {
    width: 12px;
    text-align: center;
    font-weight: 600;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .file-status-added { color: var(--vscode-gitDecoration-addedResourceForeground, #6a9955); }
  .file-status-deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
</style>
