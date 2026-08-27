<!-- The sibling of CommitDetail.svelte: shows one pull request in the right-hand panel. -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../common/Icon.svelte';

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
   * App.svelte now always passes true — the review panel handoff (Phase 4
   * task 3) exists. Kept as its own prop rather than folded into
   * `capabilities` because it isn't a provider capability: every pull
   * request can be reviewed, regardless of what the forge provider supports.
   * Defaults false only so a caller that forgets to pass it gets the same
   * honest behaviour the four `capabilities.*` gates below have: absent
   * unless the thing it triggers actually exists.
   */
  export let reviewWithAiEnabled = false;

  const dispatch = createEventDispatcher<{
    openExternal: void;
    reviewWithAi: void;
    openFile: ChangedFile;
    approve: void;
    requestChanges: void;
    /*
     * No strategy in the payload: unlike approve/requestChanges, merging
     * cannot be undone, so the parent confirms first — naming the pull
     * request, the target branch and (one button per option) the strategy —
     * and only then calls forge.pr.merge with whichever the user picked.
     * This panel has no opinion on which strategy that is.
     */
    merge: void;
    close: void;
  }>();

  const STATUS_MARK: Record<ReviewStatus, string> = {
    approved: '✓',
    changes_requested: '✗',
    pending: '⧗',
  };

  /*
   * Deliberately not FileTreeList: this list is always flat (no folders), and
   * its rows dispatch the file object itself rather than a `PathTreeNode`.
   * A file row now opens a real diff: the parent renders it from
   * `forge.pr.diff`'s text via `extractFileDiffContent`, so no locally
   * fetched commit is required — see App.svelte's `handlePullRequestOpenFile`.
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
      {#each pullRequest.reviewers as reviewer, reviewerIndex (reviewer.user.accountId || reviewerIndex)}
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
        {#each files as file, fileIndex (fileIndex + ':' + file.path)}
          <li>
            <button
              type="button"
              class="pr-file-row"
              title={file.path}
              on:click={() => dispatch('openFile', file)}
            >
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
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <section class="pr-comments" aria-label="Comments">
      <h3>Comments ({comments.length})</h3>
      {#each comments as comment, commentIndex (comment.id || commentIndex)}
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
        <button type="button" on:click={() => dispatch('merge')}>
          Merge
        </button>
      {/if}
    </footer>
  </div>
{:else}
  <!--
    A failed forge.pr.get leaves this panel with nothing to show, but the
    panel itself is still open — unlike an `{#if}` with no `{:else}`, which
    would render nothing and leave the user staring at an empty pane with no
    way to dismiss it. CommitDetail always owns a close button; this is its
    sibling's equivalent for the one state it previously had none for.
  -->
  <div class="pr-detail pr-detail-error">
    <p class="pr-error-message">Couldn't load this pull request.</p>
    <button type="button" class="pr-error-close" on:click={() => dispatch('close')}>
      <Icon name="close" /> Close
    </button>
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

  .pr-file-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* A real button now: clicking a row opens that file's diff. */
  .pr-file-row {
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

  .pr-file-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
  }

  .pr-file-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .pr-file-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-textLink-foreground, #3794ff);
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

  .pr-detail-error {
    align-items: flex-start;
    justify-content: flex-start;
  }

  .pr-error-message {
    margin: 0;
    color: var(--vscode-descriptionForeground, #888);
  }

  .pr-error-close {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit);
    font-size: 12px;
    cursor: pointer;
  }

  .pr-error-close:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
  }
</style>
