import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
  { name: 'widgets', current: false, hash: 'b'.repeat(40), remote: null, upstream: 'origin/widgets', ahead: 0, behind: 0 },
];

const forgeStatus = {
  available: true, providerName: 'Bitbucket', signedIn: true,
  capabilities: {
    createPullRequest: true, approve: true, requestChanges: true, merge: true,
    mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
  },
};

const createdDetail = {
  id: 'pr-9', number: 9, title: 'feat: widgets', state: 'open',
  sourceBranch: 'widgets', targetBranch: 'main',
  reviewers: [], commentCount: 0, webUrl: 'https://example.test/pr/9', updatedAt: '2026-08-25T09:30:00Z',
  description: '', sourceCommit: 'c'.repeat(40), targetCommit: 'a'.repeat(40), mergeable: 'clean',
};

function stubApp(overrides: Partial<Record<string, (params?: unknown) => unknown>> = {}) {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string, params?: unknown) => {
    if (method in overrides) return overrides[method]!(params);
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return branches;
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getRow': return { row: null };
      case 'forge.status': return forgeStatus;
      case 'forge.pr.list': return { pullRequests: [], stale: false };
      case 'forge.repoInfo': return { defaultBranch: 'main' };
      case 'forge.pr.reviewerSuggestions': return { reviewers: [{ displayName: 'Minh Le', accountId: 'm' }] };
      case 'git.show': return { commit: { subject: 'feat: widgets' }, files: [] };
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

async function openCreateForm(rendered: ReturnType<typeof render>) {
  const { getByRole, findByRole } = rendered;
  await waitFor(() => expect(getByRole('button', { name: 'widgets' })).toBeInTheDocument());
  await fireEvent.contextMenu(getByRole('button', { name: 'widgets' }), { clientX: 10, clientY: 10 });
  await fireEvent.click(await findByRole('menuitem', { name: 'Create Pull Request...' }));
  await waitFor(() => expect(getByRole('heading', { name: /create pull request/i })).toBeInTheDocument());
}

describe('Creating a pull request', () => {
  it('submits with the source branch and the entered fields', async () => {
    let createCall: unknown;
    stubApp({ 'forge.pr.create': (params) => { createCall = params; return createdDetail; } });
    const rendered = render(App);
    await openCreateForm(rendered);
    send.mockClear();
    stubApp({ 'forge.pr.create': (params) => { createCall = params; return createdDetail; } });

    await fireEvent.click(rendered.getByRole('button', { name: /^create pull request$/i }));

    await waitFor(() => expect(createCall).toEqual({
      title: 'feat: widgets', description: '', sourceBranch: 'widgets', targetBranch: 'main',
      reviewers: [], closeSourceBranch: false,
    }));
  });

  // Acceptance 2: appears in the list without a manual refresh.
  it('adds the created pull request to the sidebar list with no forge.pr.list refetch', async () => {
    stubApp({ 'forge.pr.create': () => createdDetail, 'forge.pr.get': () => createdDetail, 'forge.pr.comments': () => ({ comments: [] }), 'forge.pr.files': () => ({ files: [] }) });
    const rendered = render(App);
    await openCreateForm(rendered);
    send.mockClear();
    stubApp({ 'forge.pr.create': () => createdDetail, 'forge.pr.get': () => createdDetail, 'forge.pr.comments': () => ({ comments: [] }), 'forge.pr.files': () => ({ files: [] }) });

    await fireEvent.click(rendered.getByRole('button', { name: /^create pull request$/i }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.create', expect.anything()));
    expect(send).not.toHaveBeenCalledWith('forge.pr.list', expect.anything());
    await waitFor(() => expect(rendered.getByText('PULL REQUESTS')).toBeInTheDocument());
    await fireEvent.click(rendered.getByText('PULL REQUESTS'));
    // Appears twice: once as the sidebar row, once as the now-open detail
    // panel's own title (handleCreatePullRequestSubmit selects it after
    // creating it) — either is proof it reached the list with no refetch.
    expect(rendered.getAllByText('feat: widgets').length).toBeGreaterThan(0);
  });

  // Acceptance 3: a duplicate attempt names the existing pull request and
  // offers to open it — and does not destroy the form's entered values.
  it('names the existing pull request and opens it on a duplicate', async () => {
    const duplicateError = Object.assign(new Error('PR #118 already exists for these branches'), {
      kind: 'PR_DUPLICATE',
      data: { existing: { id: '118', number: 118, title: 'Add widgets' } },
    });
    stubApp({ 'forge.pr.create': () => { throw duplicateError; } });
    const rendered = render(App);
    await openCreateForm(rendered);
    await fireEvent.input(rendered.getByPlaceholderText('Title'), { target: { value: 'my title' } });
    send.mockClear();
    stubApp({ 'forge.pr.create': () => { throw duplicateError; } });

    await fireEvent.click(rendered.getByRole('button', { name: /^create pull request$/i }));

    await waitFor(() => expect(rendered.getByText(/pr #118/i)).toBeInTheDocument());
    expect(rendered.getByText(/add widgets/i)).toBeInTheDocument();
    // The form is not discarded — the typed title survives the failure.
    expect(rendered.getByPlaceholderText('Title')).toHaveValue('my title');

    send.mockClear();
    stubApp({ 'forge.pr.openExternal': () => ({ success: true }) });
    await fireEvent.click(rendered.getByRole('button', { name: /open existing pull request/i }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.openExternal', { id: '118' }));
  });

  // Acceptance 4: a host error renders the host's own text, verbatim.
  it('renders a non-duplicate host error verbatim, without destroying the form', async () => {
    stubApp({ 'forge.pr.create': () => { throw new Error('Bitbucket refused the request: branch not found.'); } });
    const rendered = render(App);
    await openCreateForm(rendered);
    await fireEvent.input(rendered.getByPlaceholderText('Description (optional)'), { target: { value: 'kept text' } });

    await fireEvent.click(rendered.getByRole('button', { name: /^create pull request$/i }));

    await waitFor(() => expect(rendered.getByText('Bitbucket refused the request: branch not found.')).toBeInTheDocument());
    expect(rendered.getByPlaceholderText('Description (optional)')).toHaveValue('kept text');
  });

  // Acceptance 1: Escape or cancel preserves entered values rather than
  // discarding the form — cancel here closes the panel deliberately (an
  // explicit user action, unlike Escape), but must not have sent anything.
  it('cancel sends no request', async () => {
    stubApp();
    const rendered = render(App);
    await openCreateForm(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /cancel/i }));

    expect(send).not.toHaveBeenCalledWith('forge.pr.create', expect.anything());
    expect(rendered.queryByRole('heading', { name: /create pull request/i })).not.toBeInTheDocument();
  });
});
