import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

function branch(name: string) {
  return {
    name,
    current: true,
    hash: name.padEnd(40, '0'),
    remote: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
}

async function renderAppWithRow(node: { subject: string; refs: string[] }) {
  const hash = 'a'.repeat(40);
  send.mockImplementation((method: string) => {
    switch (method) {
      case 'repo.list': return Promise.resolve({ repos: [{ path: '/repo', name: 'repo', active: true }], submodules: [] });
      case 'git.branches': return Promise.resolve([branch('main')]);
      case 'git.status': return Promise.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
      case 'graph.build': return Promise.resolve({ totalRows: 1, maxLane: 0, layoutVersion: 1 });
      case 'graph.getWindow': return Promise.resolve({
        nodes: [{
          hash, abbreviatedHash: hash.slice(0, 7), subject: node.subject, refs: node.refs,
          author: 'A', authorEmail: 'a@example.test', authorDate: '2026-08-23T00:00:00Z',
          parents: [], lane: 0, row: 0, color: 0,
        }],
        edges: [], startRow: 0, endRow: 1, totalRows: 1,
      });
      default: return Promise.resolve([]);
    }
  });

  const rendered = render(App);
  await waitFor(() => expect(rendered.container.querySelector('.commit-row')).not.toBeNull());
  return rendered;
}

describe('commit row message layout', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  it('renders the subject before the right-aligned chip group', async () => {
    const { container } = await renderAppWithRow({
      subject: 'fix: login redirect loop',
      refs: ['origin/develop', 'HEAD -> develop', 'tag: v1.0.0'],
    });

    const message = container.querySelector('.commit-row .col-message')!;
    const children = Array.from(message.children);

    // Subject first in the DOM, chips last: matches the visual order and reads
    // correctly for screen readers.
    expect(children[0].classList.contains('commit-subject')).toBe(true);
    expect(children[1].classList.contains('ref-chips')).toBe(true);

    const chips = Array.from(message.querySelectorAll('.ref-badge')).map((el) => el.textContent?.trim());
    expect(chips).toEqual(['develop', 'v1.0.0', 'origin/develop']);
  });

  it('gives both the subject and every chip a title for the truncated case', async () => {
    const { container } = await renderAppWithRow({
      subject: 'a'.repeat(200),
      refs: ['origin/some/very/long/branch/name'],
    });

    expect(container.querySelector('.commit-subject')!.getAttribute('title')).toBe('a'.repeat(200));
    expect(container.querySelector('.ref-badge')!.getAttribute('title')).toBe('origin/some/very/long/branch/name');
  });
});
