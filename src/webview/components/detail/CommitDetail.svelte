<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../common/Icon.svelte';
  import ResizeHandle from '../layout/ResizeHandle.svelte';
  import FileTreeList from './FileTreeList.svelte';
  import { buildPathTree } from '../../lib/path-tree';

  /*
   * The files list takes the remaining space and the message sits below it at a
   * height the user can drag. Both keep a floor so neither can be collapsed to
   * nothing by accident.
   */
  const DEFAULT_MESSAGE_HEIGHT = 160;
  const MIN_MESSAGE_HEIGHT = 96;
  const MAX_MESSAGE_HEIGHT = 520;
  let messageHeight = DEFAULT_MESSAGE_HEIGHT;

  export let commit: {
    hash: string;
    abbreviatedHash: string;
    subject: string;
    message: string;
    author: string;
    authorEmail: string;
    authorDate: string;
    refs: string[];
  } | null = null;

  export let files: {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }[] | null = null;

  export let loading: boolean = false;

  const dispatch = createEventDispatcher();

  let filterText = '';

  /** Grouped by folder, or one flat row per file. */
  let viewMode: 'tree' | 'flat' = 'tree';
  let collapsedFolders: Record<string, boolean> = {};

  function toggleFolder(path: string): void {
    collapsedFolders = { ...collapsedFolders, [path]: !collapsedFolders[path] };
  }

  $: filteredFiles = files?.filter(f =>
    f.path.toLowerCase().includes(filterText.toLowerCase())
  ) ?? [];

  $: totalAdditions = files?.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  $: totalDeletions = files?.reduce((sum, f) => sum + f.deletions, 0) ?? 0;
  $: fileTree = buildPathTree(filteredFiles ?? [], (file) => file.path);
  $: bodyText = (commit?.message ?? '').slice((commit?.subject ?? '').length).trim();

  /** `d1ade48 black on 2026-05-25 16:03` — one line instead of an avatar block. */
  function formatMeta(hash: string, author: string, isoDate: string): string {
    const date = new Date(isoDate);
    const stamp = Number.isNaN(date.getTime())
      ? isoDate
      : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        + ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return `${hash} ${author} on ${stamp}`;
  }


  function getStatusLetter(status: string): string {
    switch (status) {
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'copied': return 'C';
      case 'modified': default: return 'M';
    }
  }

  function getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  function getFileDir(path: string): string {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/');
  }
</script>

<div class="detail-panel">
  <!-- This row IS the panel title: there is no separate "COMMIT" bar above it -->
  <div class="detail-files-header">
      <span class="files-title">CHANGED FILES</span>
      <span class="files-count-badge">{files?.length ?? 0}</span>
      <span class="files-total-stats">
        {#if totalAdditions > 0}<span class="total-add">+{totalAdditions}</span>{/if}
        {#if totalDeletions > 0}<span class="total-del">-{totalDeletions}</span>{/if}
      </span>
      <span class="view-toggle">
        <button
          type="button"
          class="view-button"
          class:active={viewMode === 'tree'}
          aria-label="Group files by folder"
          aria-pressed={viewMode === 'tree'}
          title="Group by folder"
          on:click={() => { viewMode = 'tree'; }}
        ><Icon name="list-tree" /></button>
        <button
          type="button"
          class="view-button"
          class:active={viewMode === 'flat'}
          aria-label="Show files as a flat list"
          aria-pressed={viewMode === 'flat'}
          title="Flat list"
          on:click={() => { viewMode = 'flat'; }}
        ><Icon name="list-flat" /></button>
      </span>
      <button
        type="button"
        class="detail-close"
        aria-label="Close panel"
        title="Close panel"
        on:click={() => dispatch('close')}
      ><Icon name="close" /></button>
    </div>

  {#if !commit}
    <div class="detail-empty">
      <p>Select a commit to view details</p>
    </div>
  {:else}
    <!-- Filter -->
    <div class="detail-filter">
      <input
        type="text"
        placeholder="Filter files..."
        bind:value={filterText}
        class="filter-input"
      />
    </div>

    <!-- File list -->
    {#if loading}
      <div class="files-loading">Loading file changes...</div>
    {:else}
      <div class="file-list">
        {#if viewMode === 'tree'}
          <FileTreeList
            nodes={fileTree}
            {collapsedFolders}
            on:folderToggle={(event) => toggleFolder(event.detail.path)}
            on:openFile={(event) => dispatch('openFile', {
              path: event.detail.path,
              oldPath: event.detail.oldPath,
              hash: commit.hash,
              status: event.detail.status,
            })}
          />
        {:else}
        {#each filteredFiles as file}
          <button
            class="file-entry"
            on:click={() => dispatch('openFile', { path: file.path, oldPath: file.oldPath, hash: commit.hash, status: file.status })}
            type="button"
          >
            <span class="file-status file-status-{file.status}">{getStatusLetter(file.status)}</span>
            <span class="file-name">{getFileName(file.path)}</span>
            <span class="file-dir">{getFileDir(file.path)}</span>
            <span class="file-stats">
              {#if !file.binary}
                {#if file.additions > 0}<span class="file-add">+{file.additions}</span>{/if}
                {#if file.deletions > 0}<span class="file-del">-{file.deletions}</span>{/if}
              {:else}
                <span class="file-binary">BIN</span>
              {/if}
            </span>
          </button>
        {/each}
        {/if}
      </div>
    {/if}

    <ResizeHandle
      axis="y"
      side="bottom"
      currentWidth={messageHeight}
      minWidth={MIN_MESSAGE_HEIGHT}
      maxWidth={MAX_MESSAGE_HEIGHT}
      on:resize={(event) => { messageHeight = event.detail.width; }}
      on:reset={() => { messageHeight = DEFAULT_MESSAGE_HEIGHT; }}
    />

    <!-- Subject, then one line of who and when -->
    <div class="detail-meta" style="height: {messageHeight}px">
      <div class="detail-subject">{commit.subject}</div>
      <div class="detail-byline">{formatMeta(commit.abbreviatedHash, commit.author, commit.authorDate)}</div>
      {#if bodyText}
        <div class="detail-message">{bodyText}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .detail-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 13px;
  }

  .detail-panel {
    --detail-gutter: 16px;
    display: flex;
    flex-direction: column;
    padding: 0;
    height: 100%;
    overflow: hidden;
    color: var(--vscode-foreground, #ccc);
  }

  /* Author section */
  .detail-author {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .author-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .author-name {
    font-weight: 600;
    font-size: 14px;
    color: var(--vscode-foreground, #eee);
  }

  .author-date {
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #888);
  }

  /* SHA + refs */
  .detail-refs {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .detail-sha {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
  }

  .detail-sha:hover {
    text-decoration: underline;
  }

  .detail-ref-badge {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }

  /* Commit message */
  /* Height is driven by the splitter; the pane scrolls as one block. */
  .detail-meta {
    flex-shrink: 0;
    overflow-y: auto;
    padding: 12px var(--detail-gutter) 0;
  }

  .detail-subject {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.4;
    color: var(--vscode-foreground, #cccccc);
    word-break: break-word;
  }

  /* `d1ade48 black on 2026-05-25 16:03` */
  .detail-byline {
    margin-top: 4px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .detail-message {
    margin-top: 12px;
    padding-bottom: 16px;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--vscode-foreground, #ccc);
  }

  .detail-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--vscode-icon-foreground, #cccccc);
    cursor: pointer;
    opacity: 0.7;
    flex-shrink: 0;
  }

  .detail-close:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
  }

  .detail-close:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .view-toggle {
    margin-left: auto;
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }

  .view-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--vscode-icon-foreground, #cccccc);
    cursor: pointer;
    opacity: 0.75;
  }

  .view-button:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
  }

  .view-button.active {
    opacity: 1;
    background: var(--vscode-inputOption-activeBackground, rgba(0, 122, 204, 0.25));
    color: var(--vscode-inputOption-activeForeground, inherit);
  }

  .view-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  /* Files header — now the first row in the panel */
  /* The panel's title bar: same metrics as the review panel's, so the two
     modes line up when you switch between them. */
  .detail-files-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--panel-header-height, 32px);
    padding: 0 6px 0 var(--detail-gutter);
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .files-title {
    color: var(--vscode-descriptionForeground, #888);
  }

  .files-count-badge {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
    min-width: 16px;
    text-align: center;
  }

  .files-total-stats {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }

  .total-add {
    color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
    font-size: 11px;
  }

  .total-del {
    color: var(--vscode-errorForeground, #f44747);
    font-size: 11px;
  }

  /* Filter */
  .detail-filter {
    margin: 8px 0;
    padding: 0 var(--detail-gutter);
  }

  .filter-input {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    background: var(--vscode-input-background, #1e1e1e);
    color: var(--vscode-input-foreground, #ccc);
    font-size: 12px;
    border-radius: 3px;
    outline: none;
    box-sizing: border-box;
  }

  .filter-input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .filter-input::placeholder {
    color: var(--vscode-input-placeholderForeground, #666);
  }

  /* Loading state */
  .files-loading {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 12px;
    padding: 12px 8px;
    text-align: center;
  }

  /* File list */
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 0;
    min-height: 160px;
    overflow-y: auto;
  }

  .file-entry {
    padding-left: var(--detail-gutter);
    padding-right: var(--detail-gutter);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 13px;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    width: 100%;
    font-family: inherit;
  }

  .file-entry:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .file-entry:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  /* File status letter (colored) */
  .file-status {
    width: 16px;
    text-align: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .file-status-added {
    color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
  }

  .file-status-deleted {
    color: var(--vscode-errorForeground, #f44747);
  }

  .file-status-modified {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
  }

  .file-status-renamed {
    color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991);
  }

  .file-name {
    font-weight: 500;
    white-space: nowrap;
    color: var(--vscode-foreground, #ccc);
  }

  .file-dir {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .file-stats {
    display: flex;
    gap: 4px;
    margin-left: auto;
    font-size: 11px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .file-add {
    color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
  }

  .file-del {
    color: var(--vscode-errorForeground, #f44747);
  }

  .file-binary {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 10px;
    font-weight: 600;
  }
</style>
