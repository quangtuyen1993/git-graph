import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const TRANSIENT_MESSAGE_MS = 5000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // Nothing awaits a rejection that arrives later than the assertions, and an
  // unhandled rejection would fail the run on its own.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Drains pending microtasks. Timer-free, so it also works under fake timers. */
async function settle(iterations = 60): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

const branch = {
  name: 'main',
  current: true,
  hash: 'f'.repeat(40),
  remote: null,
  upstream: null,
  ahead: 0,
  behind: 0,
};

interface Fixtures {
  /** Message the next `repo.switch` rejects with. Mutated between switches. */
  switchFailure: string;
  /** Resolves the panel-state restore that finishes startup. */
  panelState: ReturnType<typeof deferred<unknown>>;
}

function bannerText(container: HTMLElement): string {
  return container.querySelector('.error-banner')?.textContent?.trim() ?? '';
}

/**
 * Renders with two repositories so the toolbar offers the repository picker —
 * a failed switch is the shortest route to a transient banner a test can fire
 * twice. Startup stays pending on `ui.getState` so the fatal path is still
 * reachable after the graph is on screen.
 */
async function renderApp() {
  const fixtures: Fixtures = { switchFailure: 'switch failed', panelState: deferred<unknown>() };

  send.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return {
        repos: [
          { name: 'repo', path: '/repo', active: true },
          { name: 'other', path: '/other', active: false },
        ],
        submodules: [],
      };
      case 'git.branches': return [branch];
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 1, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, totalRows: 1, maxLane: 0 };
      case 'ui.getState':
        return (params as { key: string }).key === 'layout.leftWidth'
          ? fixtures.panelState.promise
          : null;
      case 'repo.switch': throw new Error(fixtures.switchFailure);
      default: return null;
    }
  });
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));

  const rendered = render(App);
  await settle();
  const select = rendered.getByLabelText('Repository') as HTMLSelectElement;
  return { ...rendered, fixtures, select };
}

/** Fails a repository switch, which paints one transient banner. */
async function failSwitch(select: HTMLSelectElement, target: string) {
  await fireEvent.change(select, { target: { value: `repo:${target}` } });
  await settle();
}

describe('App transient banner timers', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives a second notice its full window instead of letting the first timer end it', async () => {
    const { container, fixtures, select } = await renderApp();
    vi.useFakeTimers();

    await failSwitch(select, '/other');
    expect(bannerText(container)).toBe('switch failed');

    // Four seconds in: the first timer is one second from firing.
    await vi.advanceTimersByTimeAsync(4000);
    fixtures.switchFailure = 'second failure';
    await failSwitch(select, '/repo');
    expect(bannerText(container)).toBe('second failure');

    // The first timer's moment passes. It must not take the newer message with it.
    await vi.advanceTimersByTimeAsync(1500);
    expect(bannerText(container)).toBe('second failure');

    // The second message still clears on its own schedule, measured from itself.
    await vi.advanceTimersByTimeAsync(TRANSIENT_MESSAGE_MS);
    expect(bannerText(container)).toBe('');
  });

  it('leaves a fatal startup error on screen when an earlier transient timer fires', async () => {
    const { container, select, fixtures } = await renderApp();
    vi.useFakeTimers();

    await failSwitch(select, '/other');
    expect(bannerText(container)).toBe('switch failed');

    // Startup fails after the graph is up: the banner turns fatal and must stay.
    fixtures.panelState.reject(new Error('The extension host connection was lost'));
    await settle();
    expect(bannerText(container)).toBe('The extension host connection was lost');

    await vi.advanceTimersByTimeAsync(TRANSIENT_MESSAGE_MS + 1000);
    expect(bannerText(container)).toBe('The extension host connection was lost');
    expect(container.querySelector('.status')?.textContent).toBe('Error');
  });
});
