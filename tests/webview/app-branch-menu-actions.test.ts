import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

interface TargetBranch {
  name: string;
  current: boolean;
  remote: string | null;
  upstream: string | null;
}

const currentBranch = {
  name: 'main',
  current: true,
  hash: 'a'.repeat(40),
  remote: null,
  upstream: 'origin/main' as string | null,
  ahead: 0,
  behind: 0,
};

/** Wait until the bridge stops being called, so a multi-step action is complete. */
async function settle() {
  let previous = -1;
  while (previous !== send.mock.calls.length) {
    previous = send.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface MenuOptions {
  /** Extra branches in the repo besides `main` and the target. */
  extraBranches?: TargetBranch[];
  /** Per-method bridge responses overriding the defaults below. */
  responses?: Record<string, unknown>;
}

/**
 * Render the app with `main` checked out plus the given branch, then right-click
 * that branch's row. A remote branch lives in a collapsed group, so it is
 * reached the way a user reaches it: search, then open the remote.
 */
async function openBranchContextMenu(target: TargetBranch, options: MenuOptions = {}) {
  const branches = [
    currentBranch,
    { ...target, hash: 'b'.repeat(40), ahead: 0, behind: 0 },
    ...(options.extraBranches ?? []).map((branch) => ({ ...branch, hash: 'c'.repeat(40), ahead: 0, behind: 0 })),
  ];

  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string) => {
    if (options.responses && method in options.responses) return options.responses[method];
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }], submodules: [] };
      case 'git.branches': return branches;
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ui.confirm': return true;
      case 'ui.inputBox': return 'feature/new-thing';
      case 'git.diffWorkingTree': return { files: [], raw: '' };
      default: return { success: true };
    }
  });

  vi.resetModules();
  const { default: App } = await import('../../src/webview/App.svelte');
  const rendered = render(App);
  const { container, getByRole, findByRole } = rendered;

  await waitFor(() => expect(getByRole('button', { name: 'main' })).toBeInTheDocument(), { timeout: 5000 });

  if (target.remote) {
    const search = container.querySelector('.sidebar-search input') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: target.name } });
    await fireEvent.click(await findByRole('button', { name: `Remote group ${target.remote}` }));
  }

  const row = await findByRole('button', { name: target.name });
  await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  await waitFor(() => expect(container.querySelector('[role="menu"]')).toBeTruthy());

  return rendered;
}

async function menuLabelsFor(target: TargetBranch): Promise<string[]> {
  const { container } = await openBranchContextMenu(target);
  return [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
}

async function runBranchAction(target: TargetBranch, label: string, options: MenuOptions = {}) {
  const { getByRole, container } = await openBranchContextMenu(target, options);
  send.mockClear();
  await fireEvent.click(getByRole('menuitem', { name: label }));
  await settle();
  return { send, container };
}

/** Every `ui.compareDiff` payload sent, in call order. */
function compareDiffCalls() {
  return send.mock.calls
    .filter(([method]) => method === 'ui.compareDiff')
    .map(([, params]) => params);
}

function bannerText(container: HTMLElement): string {
  return container.querySelector('.error-banner')?.textContent?.trim() ?? '';
}

function workingTreeDiff(fileCount: number) {
  return {
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `src/file-${index}.ts`,
      oldPath: null,
      status: 'modified',
      additions: 1,
      deletions: 0,
      binary: false,
    })),
    raw: 'diff --git ...',
  };
}

describe('App branch context-menu actions', () => {
  afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

  it('offers the new actions on a local branch with an upstream', async () => {
    const labels = await menuLabelsFor({
      name: 'develop', current: false, remote: null, upstream: 'origin/develop',
    });

    expect(labels).toContain("New Branch from 'develop'...");
    expect(labels).toContain("Checkout and Rebase onto 'main'");
    expect(labels).toContain('Show Diff with Working Tree');
    expect(labels).toContain("Rebase 'main' onto 'develop'");
    expect(labels).toContain("Pull into 'main' Using Rebase");
    expect(labels).toContain("Pull into 'main' Using Merge");
  });

  it('omits the pull actions when the branch has no upstream', async () => {
    const labels = await menuLabelsFor({
      name: 'spike', current: false, remote: null, upstream: null,
    });

    expect(labels).toContain("New Branch from 'spike'...");
    expect(labels.some((label) => label.startsWith('Pull into'))).toBe(false);
  });

  it('creates a local tracking branch before rebasing a remote branch', async () => {
    // git checkout origin/x detaches HEAD, which would make the rebase meaningless.
    const { send } = await runBranchAction(
      { name: 'origin/bugfix/RMS2025-1027', current: false, remote: 'origin', upstream: null },
      "Checkout and Rebase onto 'main'",
    );

    expect(send).toHaveBeenCalledWith('git.createBranch', {
      name: 'bugfix/RMS2025-1027', startPoint: 'origin/bugfix/RMS2025-1027',
    });
    expect(send).toHaveBeenCalledWith('git.checkout', { ref: 'bugfix/RMS2025-1027' });
    expect(send).toHaveBeenCalledWith('git.rebase', { onto: 'main' });
  });

  it('splits the remote and ref when pulling into the current branch', async () => {
    const { send } = await runBranchAction(
      { name: 'origin/bugfix/RMS2025-1027', current: false, remote: 'origin', upstream: null },
      "Pull into 'main' Using Rebase",
    );

    expect(send).toHaveBeenCalledWith('git.pull', {
      remote: 'origin', branch: 'bugfix/RMS2025-1027', options: { rebase: true },
    });
  });

  it('requests a working-tree diff for the selected branch', async () => {
    const { send } = await runBranchAction(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      'Show Diff with Working Tree',
    );

    expect(send).toHaveBeenCalledWith('git.diffWorkingTree', { ref: 'develop' });
  });

  it('creates the new branch from the clicked branch', async () => {
    const { send } = await runBranchAction(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      "New Branch from 'develop'...",
    );

    expect(send).toHaveBeenCalledWith('git.createBranch', {
      name: 'feature/new-thing', startPoint: 'develop',
    });
  });

  it('merges rather than rebases for the merge variant of pull into current', async () => {
    const { send } = await runBranchAction(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      "Pull into 'main' Using Merge",
    );

    expect(send).toHaveBeenCalledWith('git.pull', {
      remote: 'origin', branch: 'develop', options: { rebase: false },
    });
  });

  it('says so instead of opening editors when nothing differs', async () => {
    const { container } = await runBranchAction(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      'Show Diff with Working Tree',
      { responses: { 'git.diffWorkingTree': { files: [], raw: '' } } },
    );

    expect(compareDiffCalls()).toHaveLength(0);
    await waitFor(() => expect(bannerText(container)).toContain("No differences between 'develop'"));
  });

  it('opens one diff per changed file, clicked branch versus the working tree', async () => {
    // targetBranch is the checked-out branch, which compare-diff resolves to the
    // file on disk — that is what makes this a working-tree comparison.
    const { container } = await runBranchAction(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      'Show Diff with Working Tree',
      {
        responses: {
          'git.diffWorkingTree': {
            files: [
              { path: 'src/a.ts', oldPath: null, status: 'modified' },
              { path: 'src/b.ts', oldPath: 'src/old-b.ts', status: 'renamed' },
            ],
            raw: 'diff --git ...',
          },
        },
      },
    );

    expect(compareDiffCalls()).toEqual([
      { path: 'src/a.ts', oldPath: null, status: 'modified', sourceBranch: 'develop', targetBranch: 'main' },
      { path: 'src/b.ts', oldPath: 'src/old-b.ts', status: 'renamed', sourceBranch: 'develop', targetBranch: 'main' },
    ]);
    expect(bannerText(container)).toBe('');
  });

  it('caps the diff at ten files and names how many differ', async () => {
    const { container } = await runBranchAction(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      'Show Diff with Working Tree',
      { responses: { 'git.diffWorkingTree': workingTreeDiff(12) } },
    );

    const calls = compareDiffCalls();
    expect(calls).toHaveLength(10);
    expect(calls.map((params) => params.path)).toEqual(
      Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`),
    );
    await waitFor(() => expect(bannerText(container)).toContain('12 files differ'));
  });

  it('reuses an existing local branch instead of creating it again', async () => {
    const { send } = await runBranchAction(
      { name: 'origin/bugfix/RMS2025-1027', current: false, remote: 'origin', upstream: null },
      "Checkout and Rebase onto 'main'",
      {
        extraBranches: [{
          name: 'bugfix/RMS2025-1027', current: false, remote: null, upstream: 'origin/bugfix/RMS2025-1027',
        }],
      },
    );

    expect(send).not.toHaveBeenCalledWith('git.createBranch', expect.anything());
    expect(send).toHaveBeenCalledWith('git.checkout', { ref: 'bugfix/RMS2025-1027' });
    expect(send).toHaveBeenCalledWith('git.rebase', { onto: 'main' });
  });

  it('sends no mutation when the checkout-and-rebase confirmation is declined', async () => {
    const { send } = await runBranchAction(
      { name: 'origin/bugfix/RMS2025-1027', current: false, remote: 'origin', upstream: null },
      "Checkout and Rebase onto 'main'",
      { responses: { 'ui.confirm': false } },
    );

    expect(send).toHaveBeenCalledWith('ui.confirm', expect.anything());
    expect(send).not.toHaveBeenCalledWith('git.createBranch', expect.anything());
    expect(send).not.toHaveBeenCalledWith('git.checkout', expect.anything());
    expect(send).not.toHaveBeenCalledWith('git.rebase', expect.anything());
  });
});
