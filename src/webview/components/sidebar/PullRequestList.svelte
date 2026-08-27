<script context="module" lang="ts">
  // svelte-check: `export` of a type-only declaration is only valid in
  // `<script context="module">` — see PullRequestDetail.svelte's identical
  // note. Reviewer and ForgeUser move here too, since PullRequestRow depends
  // on them and a module script's top-level scope is what the instance
  // script below can see, not the other way around.
  export interface ForgeUser { displayName: string; accountId: string }
  export interface Reviewer { user: ForgeUser; status: 'approved' | 'changes_requested' | 'pending' }
  export interface PullRequestRow {
    id: string;
    number: number;
    title: string;
    state: 'open' | 'merged' | 'closed' | 'draft';
    sourceBranch: string;
    reviewers: Reviewer[];
    commentCount: number;
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { matchesPullRequestQuery } from '../../lib/branch-pull-requests';

  export let pullRequests: PullRequestRow[] = [];
  export let stale = false;
  export let signedIn = false;
  export let query = '';
  /*
   * No provider vocabulary belongs above forge/bitbucket/. This defaults to
   * "your forge" rather than naming a provider, so the row still reads as a
   * sentence on the rare tick before `forge.status` has resolved a name.
   */
  export let providerName = 'your forge';

  const dispatch = createEventDispatcher<{ select: { id: string }; signIn: void }>();

  /* Number, title and source branch are the three things someone searches by. */
  $: needle = query.trim().toLowerCase();
  $: visible = needle
    ? pullRequests.filter((pr) => matchesPullRequestQuery(pr, needle))
    : pullRequests;

  const countBy = (pr: PullRequestRow, status: Reviewer['status']) =>
    pr.reviewers.filter((reviewer) => reviewer.status === status).length;
</script>

{#if !signedIn}
  <button type="button" class="pr-signin" on:click={() => dispatch('signIn')}>
    Sign in to {providerName}
  </button>
{:else}
  {#if stale}
    <div class="pr-stale">Showing cached pull requests — stale</div>
  {/if}

  {#if visible.length === 0}
    <div class="pr-empty">{needle ? 'No matching pull requests' : 'No open pull requests'}</div>
  {:else}
    {#each visible as pr (pr.id)}
      <button type="button" class="pr-row" on:click={() => dispatch('select', { id: pr.id })}>
        <span class="pr-state" class:draft={pr.state === 'draft'}
              aria-label={pr.state === 'draft' ? 'Draft' : 'Open'}>●</span>
        <span class="pr-number">#{pr.number}</span>
        <span class="pr-title">{pr.title}</span>

        {#if countBy(pr, 'approved') > 0}
          <span class="pr-chip approved" aria-label="{countBy(pr, 'approved')} approved">
            ✓{countBy(pr, 'approved')}
          </span>
        {/if}
        {#if countBy(pr, 'changes_requested') > 0}
          <span class="pr-chip changes" aria-label="{countBy(pr, 'changes_requested')} requested changes">
            ✗{countBy(pr, 'changes_requested')}
          </span>
        {/if}
      </button>
    {/each}
  {/if}
{/if}

<style>
  .pr-signin,
  .pr-row {
    display: flex;
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
  .pr-signin:hover,
  .pr-row:hover { background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04)); }
  .pr-signin { color: var(--vscode-textLink-foreground); }
  .pr-state { color: var(--vscode-gitDecoration-untrackedResourceForeground); font-size: 10px; }
  .pr-state.draft { opacity: 0.55; }
  .pr-number { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .pr-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-chip { margin-left: auto; flex-shrink: 0; font-size: 11px; }
  .pr-chip.approved { color: var(--vscode-testing-iconPassed); }
  .pr-chip.changes { color: var(--vscode-testing-iconFailed); }
  .pr-stale,
  .pr-empty {
    padding: 3px 8px 3px 20px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-style: italic;
  }
</style>
