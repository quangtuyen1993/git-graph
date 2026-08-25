import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

function stubState(stored: Record<string, unknown> = {}) {
  const state = new Map<string, unknown>(Object.entries(stored));
  send.mockImplementation(async (method: string, params?: unknown) => {
    const p = (params ?? {}) as { key?: string; value?: unknown };
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [];
      case 'git.tags': return [];
      case 'git.stashList': return [];
      case 'git.worktreeList': return [];
      case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ui.getState': return state.get(p.key as string) ?? null;
      case 'ui.setState': state.set(p.key as string, p.value); return { success: true };
      default: return null;
    }
  });
  return state;
}

function panelStyle(container: HTMLElement): string {
  return (container.querySelector('.center-panel') as HTMLElement).getAttribute('style') ?? '';
}

function resizer(container: HTMLElement, label: string): HTMLElement {
  return container.querySelector(`[aria-label="Resize ${label} column"]`) as HTMLElement;
}

async function drag(handle: HTMLElement, byX: number) {
  await fireEvent.mouseDown(handle, { clientX: 200 });
  await fireEvent(document, new MouseEvent('mousemove', { clientX: 200 + byX, bubbles: true }));
  await fireEvent(document, new MouseEvent('mouseup', { bubbles: true }));
}

describe('App commit table columns', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
  });

  it('names every column in the header', async () => {
    stubState();
    const { container } = render(App);

    await waitFor(() => expect(container.querySelector('.table-header')).not.toBeNull());
    const titles = [...container.querySelectorAll('.table-header .col-title')].map(el => el.textContent);
    expect(titles).toEqual(['GRAPH', 'MESSAGE', 'DATE', 'SHA', 'AUTHOR']);
  });

  it('widens the date column when its divider is dragged left', async () => {
    stubState();
    const { container } = render(App);
    await waitFor(() => expect(resizer(container, 'DATE')).not.toBeNull());

    await drag(resizer(container, 'DATE'), -40);

    expect(panelStyle(container)).toContain('--date-col-width: 120px');
  });

  it('widens the graph column when its divider is dragged right', async () => {
    stubState();
    const { container } = render(App);
    await waitFor(() => expect(resizer(container, 'GRAPH')).not.toBeNull());

    await drag(resizer(container, 'GRAPH'), 60);

    expect(panelStyle(container)).toContain('--graph-col-width: 100px');
  });

  it('clamps a drag past the column bounds', async () => {
    stubState();
    const { container } = render(App);
    await waitFor(() => expect(resizer(container, 'SHA')).not.toBeNull());

    await drag(resizer(container, 'SHA'), 500);

    expect(panelStyle(container)).toContain('--sha-col-width: 44px');
  });

  it('double-click puts a column back to its default', async () => {
    stubState();
    const { container } = render(App);
    await waitFor(() => expect(resizer(container, 'AUTHOR')).not.toBeNull());

    await drag(resizer(container, 'AUTHOR'), -60);
    expect(panelStyle(container)).toContain('--author-col-width: 200px');

    await fireEvent.dblClick(resizer(container, 'AUTHOR'));
    expect(panelStyle(container)).toContain('--author-col-width: 140px');
  });

  it('remembers dragged widths across reloads', async () => {
    const state = stubState();
    const { container } = render(App);
    await waitFor(() => expect(resizer(container, 'DATE')).not.toBeNull());

    await drag(resizer(container, 'DATE'), -20);
    await waitFor(() => expect(state.get('layout.columnWidths')).toMatchObject({ date: 100 }));

    cleanup();
    stubState(Object.fromEntries(state));
    const reloaded = render(App);
    await waitFor(() => expect(panelStyle(reloaded.container)).toContain('--date-col-width: 100px'));
  });
});
