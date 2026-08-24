import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const branch = {
  name: 'main',
  current: true,
  hash: 'a'.repeat(40),
  remote: null,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
};

function stubState() {
  const state = new Map<string, unknown>();
  send.mockImplementation(async (method: string, params?: unknown) => {
    const p = (params ?? {}) as { key?: string; value?: unknown };
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [branch];
      case 'git.tags': return [];
      case 'git.stashList': return [];
      case 'git.worktreeList': return [];
      case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ai.providers': return [];
      case 'ui.getState': return state.get(p.key as string) ?? null;
      case 'ui.setState': state.set(p.key as string, p.value); return { success: true };
      default: return null;
    }
  });
  return state;
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  fireEvent(window, new Event('resize'));
}

function setViewportHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
  fireEvent(window, new Event('resize'));
}

function leftPanelWidth(container: HTMLElement): number {
  const aside = container.querySelector('.left-sidebar') as HTMLElement;
  return Number.parseInt(aside.style.width, 10);
}

describe('App panel sizing', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  it('restores a dragged sidebar width after a transient viewport narrowing', async () => {
    stubState();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    setViewportWidth(1400);
    const { container, getByRole } = render(App);
    await waitFor(() => expect(leftPanelWidth(container)).toBeGreaterThan(0));

    const handle = getByRole('separator', { name: 'Resize left panel' });
    await fireEvent.mouseDown(handle, { clientX: 0 });
    await fireEvent.mouseMove(document, { clientX: 120 });
    await fireEvent.mouseUp(document);
    const draggedWidth = leftPanelWidth(container);
    expect(draggedWidth).toBeGreaterThan(300);

    // Narrowing the viewport (e.g. dragging the panel short) shrinks the column, then widening it restores.
    setViewportWidth(600);
    await waitFor(() => expect(leftPanelWidth(container)).toBeLessThan(draggedWidth));
    setViewportWidth(1400);

    await waitFor(() => expect(leftPanelWidth(container)).toBe(draggedWidth));
  });

  it('persists the dragged width so it survives a reload', async () => {
    const state = stubState();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    setViewportWidth(1400);
    const { container, getByRole } = render(App);
    await waitFor(() => expect(leftPanelWidth(container)).toBeGreaterThan(0));

    const handle = getByRole('separator', { name: 'Resize left panel' });
    await fireEvent.mouseDown(handle, { clientX: 0 });
    await fireEvent.mouseMove(document, { clientX: 120 });
    await fireEvent.mouseUp(document);
    const draggedWidth = leftPanelWidth(container);

    await waitFor(() => expect(state.get('layout.leftWidth')).toBe(draggedWidth));
  });

  it('returns a panel to its default width when its handle is double-clicked', async () => {
    stubState();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    setViewportWidth(1400);
    const { container, getByRole } = render(App);
    await waitFor(() => expect(leftPanelWidth(container)).toBe(260));

    const handle = getByRole('separator', { name: 'Resize left panel' });
    await fireEvent.mouseDown(handle, { clientX: 0 });
    await fireEvent.mouseMove(document, { clientX: 120 });
    await fireEvent.mouseUp(document);
    expect(leftPanelWidth(container)).toBe(380);

    await fireEvent.dblClick(handle);

    await waitFor(() => expect(leftPanelWidth(container)).toBe(260));
  });

  it('goes compact when the window is too short for full chrome', async () => {
    stubState();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    setViewportWidth(1400);
    setViewportHeight(260);
    const { container } = render(App);

    await waitFor(() => expect(container.querySelector('.container.compact')).not.toBeNull());

    setViewportHeight(800);

    await waitFor(() => expect(container.querySelector('.container.compact')).toBeNull());
  });
});
