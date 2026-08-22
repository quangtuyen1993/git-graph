<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onMount } from 'svelte';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
  }

  interface Commit {
    abbreviatedHash: string;
    subject: string;
    author: string;
    authorDate: string;
    refs: string[];
  }

  let status = 'Connecting...';
  let branches: Branch[] = [];
  let commits: Commit[] = [];
  let error = '';

  onMount(async () => {
    try {
      // Test connection
      await bridge.send('ping.hello');
      status = 'Connected';

      // Load git data
      const [branchData, logData] = await Promise.all([
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('git.log', { maxCount: 20, all: true }) as Promise<Commit[]>
      ]);

      branches = branchData;
      commits = logData;
      status = `Connected — ${branches.length} branches, ${commits.length} commits loaded`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'Error';
    }
  });
</script>

<div class="container">
  <header class="toolbar">
    <h1>Git Graph Pro</h1>
    <span class="status">{status}</span>
  </header>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <main class="content">
    <aside class="sidebar">
      <h2>Branches ({branches.length})</h2>
      <ul class="branch-list">
        {#each branches as branch}
          <li class:current={branch.current}>
            {#if branch.current}<span class="indicator">●</span>{/if}
            {branch.name}
          </li>
        {/each}
      </ul>
    </aside>

    <section class="graph-area">
      <h2>Recent Commits</h2>
      <table class="commit-table">
        <thead>
          <tr>
            <th>Hash</th>
            <th>Message</th>
            <th>Author</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {#each commits as commit}
            <tr>
              <td class="hash">{commit.abbreviatedHash}</td>
              <td class="message">
                {#each commit.refs as ref}
                  <span class="ref-badge">{ref}</span>
                {/each}
                {commit.subject}
              </td>
              <td class="author">{commit.author}</td>
              <td class="date">{new Date(commit.authorDate).toLocaleDateString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  </main>
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .toolbar h1 {
    font-size: 14px;
    font-weight: 600;
  }

  .status {
    font-size: 12px;
    opacity: 0.7;
  }

  .error-banner {
    padding: 8px 16px;
    background: var(--error);
    color: var(--bg);
    font-size: 12px;
  }

  .content {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .sidebar {
    width: 200px;
    border-right: 1px solid var(--border);
    padding: 8px;
    overflow-y: auto;
  }

  .sidebar h2 {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
    text-transform: uppercase;
    opacity: 0.7;
  }

  .branch-list {
    list-style: none;
    font-size: 13px;
  }

  .branch-list li {
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }

  .branch-list li:hover {
    background: var(--hover-bg);
  }

  .branch-list li.current {
    font-weight: 600;
  }

  .indicator {
    color: var(--success);
    margin-right: 4px;
  }

  .graph-area {
    flex: 1;
    padding: 8px 16px;
    overflow: auto;
  }

  .graph-area h2 {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
    text-transform: uppercase;
    opacity: 0.7;
  }

  .commit-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .commit-table th {
    text-align: left;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    opacity: 0.7;
  }

  .commit-table td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hash {
    font-family: monospace;
    color: var(--accent);
    width: 70px;
  }

  .message {
    max-width: 400px;
  }

  .author {
    opacity: 0.7;
    width: 120px;
  }

  .date {
    opacity: 0.5;
    width: 90px;
  }

  .ref-badge {
    display: inline-block;
    background: var(--accent);
    color: var(--bg);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    margin-right: 4px;
  }
</style>
