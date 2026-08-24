import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    public event = vi.fn();
    public fire = vi.fn();
    public dispose = vi.fn();
  },
  ThemeIcon: class { constructor(public readonly id: string) {} },
  TreeItem: class { constructor(public readonly label: string) {} },
  TreeItemCollapsibleState: { None: 0 },
}));

import {
  ReviewTreeProvider, formatDescription, statusIcon,
} from '../../src/extension/providers/review-tree-provider';
import type { ReviewEntry } from '../../src/extension/services/review-store';

function entry(over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    id: 'aaaaaaa..bbbbbbb.claude.sonnet',
    sourceBranch: 'main',
    sourceSha: 'a'.repeat(40),
    targetBranch: 'feat/graph',
    targetSha: 'b'.repeat(40),
    provider: 'claude',
    model: 'sonnet',
    status: 'done',
    startedAt: new Date('2026-08-24T10:00:00Z').toISOString(),
    finishedAt: new Date('2026-08-24T10:05:00Z').toISOString(),
    ...over,
  };
}

describe('formatDescription', () => {
  it('counts elapsed time while a review runs', () => {
    const now = new Date('2026-08-24T10:02:14Z').getTime();

    expect(formatDescription(entry({ status: 'running', finishedAt: undefined }), now))
      .toBe('2m14s');
  });

  it('shows seconds only for a young run', () => {
    const now = new Date('2026-08-24T10:00:09Z').getTime();

    expect(formatDescription(entry({ status: 'running', finishedAt: undefined }), now))
      .toBe('9s');
  });

  it('shows a relative time once finished', () => {
    const now = new Date('2026-08-24T10:13:00Z').getTime();

    expect(formatDescription(entry(), now)).toBe('8m ago');
  });

  it('labels a failure rather than a time', () => {
    const now = new Date('2026-08-24T10:13:00Z').getTime();

    expect(formatDescription(entry({ status: 'failed' }), now)).toBe('failed · 8m ago');
  });

  it('labels an interrupted run', () => {
    const now = new Date('2026-08-24T10:13:00Z').getTime();

    expect(formatDescription(entry({ status: 'interrupted' }), now)).toBe('interrupted · 8m ago');
  });

  it('says nothing about when for an entry recovered without timestamps', () => {
    // M1: rebuildIndex() stamps recovered entries with the epoch, which read as
    // "interrupted · 20000d ago" — noise dressed up as fact.
    const now = new Date('2026-08-24T10:13:00Z').getTime();
    const recovered = entry({
      status: 'interrupted',
      sourceSha: '',
      targetSha: '',
      startedAt: new Date(0).toISOString(),
      finishedAt: undefined,
    });

    expect(formatDescription(recovered, now)).toBe('interrupted');
  });

  it('says nothing about when for an unparseable timestamp', () => {
    const now = new Date('2026-08-24T10:13:00Z').getTime();

    expect(formatDescription(entry({ finishedAt: 'not a date' }), now)).toBe('');
  });
});

describe('statusIcon', () => {
  it('spins only while running', () => {
    expect(statusIcon('running')).toBe('loading~spin');
    expect(statusIcon('done')).toBe('check');
    expect(statusIcon('failed')).toBe('error');
    expect(statusIcon('cancelled')).toBe('circle-slash');
    expect(statusIcon('interrupted')).toBe('warning');
  });
});

describe('ReviewTreeProvider', () => {
  it('labels a row base-arrow-head so the direction is unambiguous', async () => {
    const store = { list: vi.fn(async () => [entry()]) };
    const provider = new ReviewTreeProvider(store as never, () => 'repo-a');

    const item = provider.getTreeItem(entry());
    expect(item.label).toBe('main ← feat/graph');
  });

  it('puts the status in contextValue so menu when-clauses can bind to it', () => {
    const store = { list: vi.fn(async () => []) };
    const provider = new ReviewTreeProvider(store as never, () => 'repo-a');

    expect(provider.getTreeItem(entry({ status: 'running' })).contextValue).toBe('running');
    expect(provider.getTreeItem(entry({ status: 'done' })).contextValue).toBe('done');
  });

  it('returns nothing when no repository is active', async () => {
    const store = { list: vi.fn(async () => [entry()]) };
    const provider = new ReviewTreeProvider(store as never, () => undefined);

    expect(await provider.getChildren()).toEqual([]);
    expect(store.list).not.toHaveBeenCalled();
  });

  it('lists the active repo entries', async () => {
    const store = { list: vi.fn(async () => [entry()]) };
    const provider = new ReviewTreeProvider(store as never, () => 'repo-a');

    expect(await provider.getChildren()).toHaveLength(1);
    expect(store.list).toHaveBeenCalledWith('repo-a');
  });

  it('shows an empty list, not a tree error, when getRepoId throws', async () => {
    // I3: the row commands guard the realpathSync ENOENT; getChildren did not,
    // so a repo unmounted while rows were on screen took the whole view down.
    const store = { list: vi.fn(async () => [entry()]) };
    const provider = new ReviewTreeProvider(store as never, () => {
      throw new Error('ENOENT: repo directory gone');
    });

    await expect(provider.getChildren()).resolves.toEqual([]);
    expect(store.list).not.toHaveBeenCalled();
  });

  it('disposes its event emitter', () => {
    // M2: the provider is pushed into context.subscriptions, so this is what
    // releases the emitter when the extension shuts down.
    const store = { list: vi.fn(async () => []) };
    const provider = new ReviewTreeProvider(store as never, () => 'repo-a');

    provider.dispose();

    expect((provider as never as { changed: { dispose: () => void } }).changed.dispose)
      .toHaveBeenCalled();
  });
});
