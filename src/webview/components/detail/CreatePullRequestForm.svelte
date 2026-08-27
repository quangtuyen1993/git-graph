<!--
  The first multi-field, validating, submitting surface in this webview.
  Opens in the detail panel — replacing a chain of `ui.inputBox` prompts,
  which loses every earlier answer to a single Escape — so this component
  keeps its field values in local component state for as long as it stays
  mounted. Nothing here reacts to the Escape key: unlike a VS Code quick
  input, pressing it (in a field, or anywhere else) does nothing destructive.
  Only the explicit Cancel button ends the flow.
-->
<script context="module" lang="ts">
  // svelte-check: `export` of a type-only declaration is only valid in
  // `<script context="module">` — see PullRequestDetail.svelte's identical
  // note.
  export interface CreatePullRequestSubmitDetail {
    title: string;
    description: string;
    targetBranch: string;
    reviewers: string[];
    closeSourceBranch: boolean;
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Combobox from '../Combobox.svelte';

  interface ReviewerCandidate {
    displayName: string;
    accountId: string;
  }

  export let sourceBranch: string;
  export let initialTitle = '';
  /** Every other local branch, offered as the target-branch combobox's items. */
  export let targetBranchOptions: string[] = [];
  export let defaultTargetBranch = '';
  /**
   * Reviewer *suggestions*, never a complete member directory — see
   * `ForgeProvider.listReviewerCandidates`. The UI must stay honest about
   * that, hence the label below rather than a plain "Reviewers" heading.
   */
  export let reviewerSuggestions: ReviewerCandidate[] = [];
  export let submitting = false;
  /** The host's own message, rendered verbatim — never rewritten here. */
  export let errorMessage: string | null = null;
  /** Set when the host reports this exact pull request already exists. */
  export let duplicate: { id: string; number: number; title: string } | null = null;

  const dispatch = createEventDispatcher<{
    submit: CreatePullRequestSubmitDetail;
    cancel: void;
    openDuplicate: void;
  }>();

  // Local state only — never reassigned from a prop after mount, which is
  // what lets a resubmit-after-duplicate (or any other failure) leave every
  // typed value exactly as the user left it.
  let title = initialTitle;
  let description = '';
  let targetBranch = defaultTargetBranch;
  let closeSourceBranch = false;
  let selectedReviewerIds: string[] = [];

  const targetBranchItems = targetBranchOptions.map((name) => ({ label: name, value: name }));

  $: titleError = title.trim().length === 0 ? 'Title is required.' : null;
  $: targetBranchError = targetBranch.trim().length === 0
    ? 'Target branch is required.'
    : targetBranch === sourceBranch
      ? 'Target branch must differ from the source branch.'
      : null;
  $: canSubmit = !titleError && !targetBranchError && !submitting;

  function handleSubmit(event: Event): void {
    event.preventDefault();
    if (!canSubmit) return;
    dispatch('submit', {
      title: title.trim(),
      description,
      targetBranch,
      reviewers: selectedReviewerIds,
      closeSourceBranch,
    });
  }
</script>

<form class="pr-create" on:submit={handleSubmit}>
  <header class="pr-create-header">
    <h2>Create Pull Request</h2>
  </header>

  <div class="pr-create-branches">
    <code>{sourceBranch}</code>
    <span aria-hidden="true">→</span>
    <Combobox
      items={targetBranchItems}
      bind:value={targetBranch}
      placeholder="Target branch…"
      aria-label="Target branch"
    />
  </div>
  {#if targetBranchError}
    <p class="pr-create-field-error">{targetBranchError}</p>
  {/if}

  <label class="pr-create-field">
    <span>Title</span>
    <input type="text" bind:value={title} placeholder="Title" />
  </label>
  {#if titleError}
    <p class="pr-create-field-error">{titleError}</p>
  {/if}

  <label class="pr-create-field">
    <span>Description</span>
    <textarea bind:value={description} rows="4" placeholder="Description (optional)"></textarea>
  </label>

  <fieldset class="pr-create-reviewers">
    <legend>Suggested reviewers</legend>
    {#if reviewerSuggestions.length === 0}
      <p class="pr-create-reviewers-empty">No suggestions available.</p>
    {:else}
      <!--
        "Suggested" in the legend, not "Reviewers" — Bitbucket's
        default-reviewers endpoint and GitHub's collaborators endpoint are
        both suggestion lists, never a complete workspace directory, and
        this list must not read as one.
      -->
      {#each reviewerSuggestions as candidate (candidate.accountId)}
        <label class="pr-create-reviewer">
          <input type="checkbox" bind:group={selectedReviewerIds} value={candidate.accountId} />
          {candidate.displayName}
        </label>
      {/each}
    {/if}
  </fieldset>

  <label class="pr-create-checkbox">
    <input type="checkbox" bind:checked={closeSourceBranch} />
    Close source branch after merging
  </label>

  {#if duplicate}
    <div class="pr-create-duplicate" role="alert">
      <p>PR #{duplicate.number} "{duplicate.title}" already exists for these branches.</p>
      <button type="button" on:click={() => dispatch('openDuplicate')}>Open existing pull request</button>
    </div>
  {:else if errorMessage}
    <p class="pr-create-error" role="alert">{errorMessage}</p>
  {/if}

  <footer class="pr-create-actions">
    <button type="button" class="pr-create-cancel" on:click={() => dispatch('cancel')} disabled={submitting}>
      Cancel
    </button>
    <button type="submit" class="pr-create-submit" disabled={!canSubmit}>
      {submitting ? 'Creating…' : 'Create Pull Request'}
    </button>
  </footer>
</form>

<style>
  .pr-create {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px;
    font-size: 12px;
    color: var(--vscode-foreground, #ccc);
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
  }

  .pr-create-header h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .pr-create-branches {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .pr-create-branches code {
    flex-shrink: 0;
  }

  .pr-create-branches :global(.combobox-wrapper) {
    flex: 1;
  }

  .pr-create-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pr-create-field span {
    color: var(--vscode-descriptionForeground, #888);
  }

  .pr-create-field input[type='text'],
  .pr-create-field textarea {
    box-sizing: border-box;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    font-family: inherit;
    font-size: inherit;
    resize: vertical;
  }

  .pr-create-field-error {
    margin: -4px 0 0;
    color: var(--vscode-errorForeground, #f14c4c);
    font-size: 11px;
  }

  .pr-create-reviewers {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--vscode-panel-border, #2b2b2b);
    border-radius: 3px;
    padding: 6px 8px;
    margin: 0;
  }

  .pr-create-reviewers legend {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 0 4px;
  }

  .pr-create-reviewers-empty {
    margin: 0;
    color: var(--vscode-descriptionForeground, #888);
  }

  .pr-create-reviewer {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pr-create-checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pr-create-duplicate {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
    border-radius: 3px;
  }

  .pr-create-duplicate p {
    margin: 0;
  }

  .pr-create-duplicate button {
    align-self: flex-start;
  }

  .pr-create-error {
    margin: 0;
    color: var(--vscode-errorForeground, #f14c4c);
    white-space: pre-wrap;
  }

  .pr-create-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding-top: 4px;
    border-top: 1px solid var(--vscode-panel-border, #2b2b2b);
  }

  .pr-create-actions button {
    padding: 4px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    font-size: 12px;
    cursor: pointer;
  }

  .pr-create-submit {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }

  .pr-create-submit:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  .pr-create-submit:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .pr-create-cancel {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit);
  }
</style>
