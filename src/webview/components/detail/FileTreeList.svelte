<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../common/Icon.svelte';
  import { countLeaves, type PathTreeNode } from '../../lib/path-tree';

  interface ChangedFile {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }

  export let nodes: PathTreeNode<ChangedFile>[] = [];
  export let collapsedFolders: Record<string, boolean> = {};
  export let depth = 0;

  const dispatch = createEventDispatcher();

  function statusLetter(status: string): string {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    if (status === 'renamed') return 'R';
    return 'M';
  }
</script>

<ul class="file-tree">
  {#each nodes as node (node.path)}
    <li>
      {#if node.children.length > 0}
        <button
          type="button"
          class="folder-row"
          style={`--file-indent: ${depth * 16}px`}
          aria-label={`Folder ${node.path}`}
          aria-expanded={!collapsedFolders[node.path]}
          on:click={() => dispatch('folderToggle', { path: node.path })}
        >
          <span class="folder-chevron" class:collapsed={collapsedFolders[node.path]}>
            <Icon name="chevron-right" size={14} />
          </span>
          <span class="folder-icon">
            <Icon name={collapsedFolders[node.path] ? 'folder' : 'folder-opened'} size={14} />
          </span>
          <span class="folder-name">{node.label}</span>
          <span class="folder-count">
            {countLeaves(node)}
            {countLeaves(node) === 1 ? 'file' : 'files'}
          </span>
        </button>
      {/if}

      {#if node.item && node.children.length === 0}
        <button
          type="button"
          class="file-row"
          style={`--file-indent: ${depth * 16}px`}
          title={node.item.path}
          on:click={() => dispatch('openFile', node.item)}
        >
          <span class="file-icon"><Icon name="file" size={14} /></span>
          <span class="file-label">{node.label}</span>
          <span class="file-meta">
            {#if node.item.binary}
              <span class="file-binary">BIN</span>
            {:else}
              {#if node.item.additions > 0}<span class="file-add">+{node.item.additions}</span>{/if}
              {#if node.item.deletions > 0}<span class="file-del">-{node.item.deletions}</span>{/if}
            {/if}
            <span class="file-status file-status-{node.item.status}">{statusLetter(node.item.status)}</span>
          </span>
        </button>
      {/if}

      {#if node.children.length > 0 && !collapsedFolders[node.path]}
        <svelte:self
          nodes={node.children}
          {collapsedFolders}
          depth={depth + 1}
          on:openFile
          on:folderToggle
        />
      {/if}
    </li>
  {/each}
</ul>

<style>
  .file-tree {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .folder-row,
  .file-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 24px;
    padding: 2px 8px 2px calc(8px + var(--file-indent));
    border: none;
    border-radius: 3px;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .folder-row:hover,
  .file-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
  }

  .folder-row:focus-visible,
  .file-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .folder-chevron,
  .folder-icon,
  .file-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .folder-chevron {
    transform: rotate(90deg);
    transition: transform 0.15s ease;
  }

  .folder-chevron.collapsed {
    transform: rotate(0deg);
  }

  .folder-name {
    font-size: 13px;
    color: var(--vscode-foreground, #cccccc);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* File names are the actionable thing here, so they read as links. */
  .file-label {
    font-size: 13px;
    color: var(--vscode-textLink-foreground, #3794ff);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-count {
    margin-left: auto;
    padding-left: 8px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .file-meta {
    margin-left: auto;
    padding-left: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    font-size: 11px;
  }

  .file-add {
    color: var(--vscode-gitDecoration-addedResourceForeground, #6a9955);
  }

  .file-del {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
  }

  .file-binary {
    color: var(--vscode-descriptionForeground, #767676);
  }

  .file-status {
    width: 12px;
    text-align: center;
    font-weight: 600;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .file-status-added {
    color: var(--vscode-gitDecoration-addedResourceForeground, #6a9955);
  }

  .file-status-deleted {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
  }
</style>
