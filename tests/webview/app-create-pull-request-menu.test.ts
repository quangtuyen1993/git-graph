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
  name: 'main', current: true, hash: 'a'.repeat(40),
  remote: null, upstream: 'origin/main' as string | null, ahead: 0, behind: 0,
};

const forgeStatusAvailable = {
  available: true, providerName: 'Bitbucket', signedIn: true,
  capabilities: {
    createPullRequest: true, approve: true, requestChanges: true, merge: true,
    mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
  },
};

interface MenuOptions {
  forgeStatus?: unknown;
}

async function openBranchContextMenu(target: TargetBranch, options: MenuOptions = {}) {
  const branches = [currentBranch, { ...target, hash: 'b'.repeat(40), ahead: 0, behind: 0 }];

  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }], submodules: [] };
      case 'git.branches': return branches;
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'forge.status': return 'forgeStatus' in options ? options.forgeStatus : forgeStatusAvailable;
      case 'forge.pr.list': return { pullRequests: [], stale: false };
      default: return { success: true };
    }
  });

  vi.resetModules();
  const { default: App } = await import('../../src/webview/App.svelte');
  const rendered = render(App);
  const { container, getByRole, findByRole } = rendered;

  await waitFor(() => expect(getByRole('button', { name: 'main' })).toBeInTheDocument(), { timeout: 5000 });
  const row = await findByRole('button', { name: target.name });
  await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  await waitFor(() => expect(container.querySelector('[role="menu"]')).toBeTruthy());

  return rendered;
}

async function menuLabelsFor(target: TargetBranch, options: MenuOptions = {}): Promise<string[]> {
  const { container } = await openBranchContextMenu(target, options);
  return [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
}

describe('Create Pull Request context menu item', () => {
  afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

  it('is present for a local branch with an upstream, when the provider supports it', async () => {
    const labels = await menuLabelsFor({ name: 'develop', current: false, remote: null, upstream: 'origin/develop' });
    expect(labels).toContain('Create Pull Request...');
  });

  it('is present for the current branch, when it has an upstream', async () => {
    // currentBranch above already has an upstream ('origin/main'); right-click
    // its own row rather than a second branch's.
    const { container, getByRole } = await openBranchContextMenu(
      { name: 'develop', current: false, remote: null, upstream: null },
    );
    await fireEvent.contextMenu(getByRole('button', { name: 'main' }), { clientX: 10, clientY: 10 });
    await waitFor(() => expect(container.querySelector('[role="menu"]')).toBeTruthy());
    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
    expect(labels).toContain('Create Pull Request...');
  });

  // An unpushed branch has nothing to open a pull request from — absent,
  // never disabled.
  it('is absent for a branch with no upstream', async () => {
    const labels = await menuLabelsFor({ name: 'spike', current: false, remote: null, upstream: null });
    expect(labels).not.toContain('Create Pull Request...');
  });

  // Global constraint: a repository with no forge provider behaves exactly
  // as it does today — no menu item, same as no sidebar section.
  it('is absent when the repository has no forge provider', async () => {
    const labels = await menuLabelsFor(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      { forgeStatus: { available: false } },
    );
    expect(labels).not.toContain('Create Pull Request...');
  });

  // The capability mechanism: absent, not disabled, when the provider
  // doesn't (yet) support creating pull requests.
  it('is absent when the provider does not declare createPullRequest', async () => {
    const labels = await menuLabelsFor(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      {
        forgeStatus: {
          available: true, providerName: 'Bitbucket', signedIn: true,
          capabilities: { createPullRequest: false, approve: false, requestChanges: false, merge: false, mergeStrategies: [] },
        },
      },
    );
    expect(labels).not.toContain('Create Pull Request...');
  });

  it('opens the create-pull-request form on click, fetching defaults from the host', async () => {
    const { getByRole } = await openBranchContextMenu({
      name: 'develop', current: false, remote: null, upstream: 'origin/develop',
    });
    send.mockClear();
    send.mockImplementation(async (method: string) => {
      switch (method) {
        case 'forge.repoInfo': return { defaultBranch: 'main' };
        case 'forge.pr.reviewerSuggestions': return { reviewers: [{ displayName: 'Minh Le', accountId: 'm' }] };
        case 'git.show': return { commit: { subject: 'feat: widgets' }, files: [] };
        case 'git.branches': return branches;
        default: return { success: true };
      }
    });

    await fireEvent.click(getByRole('menuitem', { name: 'Create Pull Request...' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.repoInfo'));
    expect(send).toHaveBeenCalledWith('forge.pr.reviewerSuggestions');
    expect(send).toHaveBeenCalledWith('git.show', { hash: 'b'.repeat(40) });
    await waitFor(() => expect(getByRole('heading', { name: /create pull request/i })).toBeInTheDocument());
    expect(getByRole('textbox', { name: /title/i }) as HTMLInputElement).toHaveValue('feat: widgets');
  });
});
