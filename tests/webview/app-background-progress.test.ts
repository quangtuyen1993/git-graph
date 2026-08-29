import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

type Build = { totalRows: number; maxLane: number; layoutVersion: number };

/**
 * The first `graph.build` is held open so a test can keep the app "working"
 * for as long as it needs; every later build resolves immediately.
 */
function stubApp(graphBuild = deferred<Build>()) {
  let buildCount = 0;
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [];
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': {
        buildCount += 1;
        if (buildCount === 1) return graphBuild.promise;
        return { totalRows: 1, maxLane: 0, layoutVersion: buildCount };
      }
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0 };
      case 'forge.status': return { available: false, providerName: '', signedIn: false, capabilities: {} };
      default: return null;
    }
  });
  return graphBuild;
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

function bar(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.background-progress-bar');
}

function track(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.background-progress');
}

describe('Ambient background-work bar', () => {
  it('shows while a graph build is in flight and goes away when it settles', async () => {
    const graphBuild = stubApp();
    const { container } = render(App);

    await waitFor(() => expect(bar(container)).not.toBeNull());

    graphBuild.resolve({ totalRows: 1, maxLane: 0, layoutVersion: 1 });

    await waitFor(() => expect(bar(container)).toBeNull());
  });

  it('is unlabelled and ambient, not the labelled mutation banner', async () => {
    const graphBuild = stubApp();
    const { container } = render(App);

    await waitFor(() => expect(bar(container)).not.toBeNull());
    // The mutation banner names an operation; this one says nothing.
    expect(bar(container)!.textContent).toBe('');
    expect(container.querySelector('.mutation-progress')).toBeNull();

    graphBuild.resolve({ totalRows: 1, maxLane: 0, layoutVersion: 1 });
  });

  it('reserves its space, so appearing and disappearing never moves the rows below', async () => {
    const graphBuild = stubApp();
    const { container } = render(App);

    // The track that holds the bar sits directly under the toolbar and is
    // present in every state, so nothing below it is ever pushed down.
    const header = await waitFor(() => {
      const found = container.querySelector('header.toolbar');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const reserved = track(container);
    expect(reserved).not.toBeNull();
    expect(header.nextElementSibling).toBe(reserved);
    await waitFor(() => expect(bar(container)).not.toBeNull());

    graphBuild.resolve({ totalRows: 1, maxLane: 0, layoutVersion: 1 });
    await waitFor(() => expect(bar(container)).toBeNull());

    // Same node, same position: only the bar inside it came and went.
    expect(track(container)).toBe(reserved);
    expect(header.nextElementSibling).toBe(reserved);
  });
});
