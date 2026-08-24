import { describe, expect, it, vi } from 'vitest';
import { registerReviewView } from '../../src/extension/providers/review-view-registration';

function harness() {
  const disposables: unknown[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const tree = { refresh: vi.fn() };
  const runner = { cancel: vi.fn(() => true) };
  const store = { remove: vi.fn(async () => {}) };
  const deps = {
    tree: tree as never,
    runner: runner as never,
    store: store as never,
    getRepoId: () => 'repo-a',
    openBody: vi.fn(async () => {}),
    rerun: vi.fn(async () => {}),
    registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
      commands.set(id, fn);
      return { dispose: vi.fn() };
    },
    registerTreeView: vi.fn(() => ({ dispose: vi.fn() })),
    subscribe: (d: unknown) => disposables.push(d),
  };
  registerReviewView(deps);
  return { commands, tree, runner, store, deps, disposables };
}

const entry = { id: 'rev-1', status: 'done' } as never;

describe('registerReviewView', () => {
  it('registers the tree view under the contributed id', () => {
    const { deps } = harness();

    expect(deps.registerTreeView).toHaveBeenCalledWith('gitGraphPro.reviews', deps.tree);
  });

  it('cancel routes to the runner and refreshes the tree', async () => {
    const { commands, runner, tree } = harness();

    await commands.get('gitGraphPro.review.cancel')?.({ ...entry, status: 'running' });

    expect(runner.cancel).toHaveBeenCalledWith('repo-a', 'rev-1');
    expect(tree.refresh).toHaveBeenCalled();
  });

  it('delete removes from the store and refreshes', async () => {
    const { commands, store, tree } = harness();

    await commands.get('gitGraphPro.review.delete')?.(entry);

    expect(store.remove).toHaveBeenCalledWith('repo-a', 'rev-1');
    expect(tree.refresh).toHaveBeenCalled();
  });

  it('open shows the body document', async () => {
    const { commands, deps } = harness();

    await commands.get('gitGraphPro.review.open')?.(entry);

    expect(deps.openBody).toHaveBeenCalledWith('repo-a', 'rev-1');
  });

  it('rerun delegates to the injected rerun callback', async () => {
    const { commands, deps, tree } = harness();

    await commands.get('gitGraphPro.review.rerun')?.(entry);

    expect(deps.rerun).toHaveBeenCalledWith(entry);
    expect(tree.refresh).toHaveBeenCalled();
  });

  it('commands are a no-op when no repository is active', async () => {
    const disposables: unknown[] = [];
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const tree = { refresh: vi.fn() };
    const runner = { cancel: vi.fn(() => true) };
    const store = { remove: vi.fn(async () => {}) };
    registerReviewView({
      tree: tree as never,
      runner: runner as never,
      store: store as never,
      getRepoId: () => undefined,
      openBody: vi.fn(async () => {}),
      rerun: vi.fn(async () => {}),
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
        commands.set(id, fn);
        return { dispose: vi.fn() };
      },
      registerTreeView: vi.fn(() => ({ dispose: vi.fn() })),
      subscribe: (d: unknown) => disposables.push(d),
    });

    await expect(commands.get('gitGraphPro.review.cancel')?.(entry)).resolves.not.toThrow();
    expect(runner.cancel).not.toHaveBeenCalled();
    expect(tree.refresh).not.toHaveBeenCalled();
  });

  it('every registration is disposed with the extension', () => {
    const { disposables } = harness();

    expect(disposables.length).toBeGreaterThanOrEqual(5);
  });
});
