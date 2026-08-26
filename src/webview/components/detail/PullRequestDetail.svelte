<!-- The sibling of CommitDetail.svelte: shows one pull request in the right-hand panel. -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  interface ForgeUser { displayName: string; accountId: string }
  type ReviewStatus = 'approved' | 'changes_requested' | 'pending';
  interface Reviewer { user: ForgeUser; status: ReviewStatus }
  interface ForgeComment {
    id: string;
    author: ForgeUser;
    body: string;
    createdAt: string;
    parentId?: string;
    path?: string;
    line?: number;
  }
  interface ChangedFile {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }
  interface ForgeCapabilities {
    createPullRequest: boolean;
    approve: boolean;
    requestChanges: boolean;
    merge: boolean;
    mergeStrategies: string[];
  }
  export interface PullRequestDetailModel {
    id: string;
    number: number;
    title: string;
    state: string;
    sourceBranch: string;
    targetBranch: string;
    reviewers: Reviewer[];
    description: string;
    mergeable: string;
    webUrl: string;
  }

  export let pullRequest: PullRequestDetailModel | null = null;
  export let comments: ForgeComment[] = [];
  export let files: ChangedFile[] = [];
  export let capabilities: ForgeCapabilities;
  /*
   * No capability backs this yet — the design spec assigns AI review to a
   * later phase. Defaulting false, with no wiring from App.svelte, keeps the
   * button honest the same way the four `capabilities.*` gates below do:
   * absent until the thing it triggers actually exists.
   */
  export let reviewWithAiEnabled = false;

  const dispatch = createEventDispatcher<{
    openExternal: void;
    reviewWithAi: void;
    approve: void;
    requestChanges: void;
    merge: { strategy: string };
  }>();

  const STATUS_MARK: Record<ReviewStatus, string> = {
    approved: '✓',
    changes_requested: '✗',
    pending: '⧗',
  };

  /*
   * Deliberately not FileTreeList: that component's leaf rows are buttons
   * that dispatch `openFile` to open a diff editor against the local
   * repository. A pull request's head commit is usually not fetched locally
   * (see App.svelte's `scrollToPullRequestHead`), so that action would fail
   * for the common case. Until a later phase solves "open a diff for a
   * commit we may not have", this list is read-only — no button, no click
   * handler, no link styling — so it never promises what it cannot do.
   */
  function statusLetter(status: string): string {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    if (status === 'renamed') return 'R';
    return 'M';
  }

  /*
   * The indentation that shows a reply belongs to its thread is purely visual —
   * data-parent is invisible to assistive tech and CSS padding conveys nothing
   * to a screen reader. Naming who a reply answers, in real text, is what makes
   * the relationship available to someone who cannot see the indentation.
   */
  function replyTargetName(comment: ForgeComment): string | null {
    if (!comment.parentId) return null;
    const parent = comments.find((candidate) => candidate.id === comment.parentId);
    return parent ? parent.author.displayName : 'a previous comment';
  }
</script>

{#if pullRequest}
  <div class="pr-detail">
    <header class="pr-header">
      <span class="pr-number">#{pullRequest.number}</span>
      <h2 class="pr-title">{pullRequest.title}</h2>
      <button type="button" class="pr-open-external" on:click={() => dispatch('openExternal')}>
        Open in browser
      </button>
    </header>

    <div class="pr-branches">
      <code>{pullRequest.sourceBranch}</code>
      <span aria-hidden="true">→</span>
      <code>{pullRequest.targetBranch}</code>
      <span class="pr-state">{pullRequest.state}</span>
      {#if pullRequest.mergeable === 'conflicted'}
        <span class="pr-conflict" role="status">⚠ conflicted</span>
      {/if}
    </div>

    {#if pullRequest.description}
      <p class="pr-description">{pullRequest.description}</p>
    {/if}

    <section class="pr-reviewers" aria-label="Reviewers">
      <h3>Reviewers</h3>
      {#each pullRequest.reviewers as reviewer (reviewer.user.accountId)}
        <span
          class="reviewer {reviewer.status}"
          aria-label="{reviewer.user.displayName} {reviewer.status}"
        >
          <span aria-hidden="true">{STATUS_MARK[reviewer.status]}</span>
          {reviewer.user.displayName}
        </span>
      {/each}
    </section>

    <section class="pr-files" aria-label="Changed files">
      <h3>Files ({files.length})</h3>
      <ul class="pr-file-list">
        {#each files as file (file.path)}
          <li class="pr-file-row" title={file.path}>
            <span class="pr-file-path">{file.path}</span>
            <span class="pr-file-meta">
              {#if file.binary}
                <span class="file-binary">BIN</span>
              {:else}
                {#if file.additions > 0}<span class="file-add">+{file.additions}</span>{/if}
                {#if file.deletions > 0}<span class="file-del">-{file.deletions}</span>{/if}
              {/if}
              <span class="file-status file-status-{file.status}">{statusLetter(file.status)}</span>
            </span>
          </li>
        {/each}
      </ul>
    </section>

    <section class="pr-comments" aria-label="Comments">
      <h3>Comments ({comments.length})</h3>
      {#each comments as comment (comment.id)}
        <article
          class="comment"
          class:reply={Boolean(comment.parentId)}
          data-testid="comment-{comment.id}"
          data-parent={comment.parentId ?? ''}
        >
          <span class="comment-author">{comment.author.displayName}</span>
          {#if comment.parentId}
            <span class="comment-reply-to">in reply to {replyTargetName(comment)}</span>
          {/if}
          {#if comment.path}
            <span class="comment-anchor">{comment.path}{comment.line ? `:${comment.line}` : ''}</span>
          {/if}
          <p class="comment-body">{comment.body}</p>
        </article>
      {/each}
    </section>

    <footer class="pr-actions">
      {#if reviewWithAiEnabled}
        <button type="button" on:click={() => dispatch('reviewWithAi')}>Review with AI</button>
      {/if}
      {#if capabilities.approve}
        <button type="button" on:click={() => dispatch('approve')}>Approve</button>
      {/if}
      {#if capabilities.requestChanges}
        <button type="button" on:click={() => dispatch('requestChanges')}>Request changes</button>
      {/if}
      {#if capabilities.merge}
        <button
          type="button"
          on:click={() => dispatch('merge', { strategy: capabilities.mergeStrategies[0] })}
        >
          Merge
        </button>
      {/if}
    </footer>
  </div>
{/if}

<style>
  .pr-detail {
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

  .pr-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .pr-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pr-number {
    color: var(--vscode-descriptionForeground, #888);
    flex-shrink: 0;
  }

  .pr-open-external {
    margin-left: auto;
    flex-shrink: 0;
    padding: 2px 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit);
    font-size: 11px;
    cursor: pointer;
  }

  .pr-branches {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--vscode-editor-font-family, monospace);
    flex-wrap: wrap;
  }

  .pr-state {
    text-transform: capitalize;
    color: var(--vscode-descriptionForeground, #888);
  }

  .pr-conflict {
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  .pr-description {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  h3 {
    margin: 0 0 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground, #888);
  }

  .pr-reviewers {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: baseline;
  }

  .reviewer.approved { color: var(--vscode-testing-iconPassed, #73c991); }
  .reviewer.changes_requested { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .reviewer.pending { color: var(--vscode-descriptionForeground, #888); }

  /* Display-only: no button, no hover affordance, no link colour on the path
     — this list cannot open a diff yet, so it must not look like it can. */
  .pr-file-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .pr-file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 22px;
    padding: 2px 0;
  }

  .pr-file-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .pr-file-meta {
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

  .comment {
    padding: 6px 0;
    border-top: 1px solid var(--vscode-panel-border, #2b2b2b);
  }

  .comment.reply {
    padding-left: 16px;
  }

  .comment-author {
    font-weight: 600;
  }

  .comment-reply-to {
    margin-left: 6px;
    color: var(--vscode-descriptionForeground, #888);
    font-style: italic;
    font-size: 11px;
  }

  .comment-anchor {
    margin-left: 6px;
    color: var(--vscode-descriptionForeground, #888);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .comment-body {
    margin: 4px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .pr-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    padding-top: 4px;
    border-top: 1px solid var(--vscode-panel-border, #2b2b2b);
  }

  .pr-actions button {
    padding: 4px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    font-size: 12px;
    cursor: pointer;
  }

  .pr-actions button:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
</style>
