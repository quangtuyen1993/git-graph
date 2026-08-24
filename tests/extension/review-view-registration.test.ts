import { describe, expect, it, vi } from 'vitest';
import { registerReviewView } from '../../src/extension/providers/review-view-registration';

function harness(getRepoId: () => string | undefined = () => 'repo-a') {
  const disposables: unknown[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const tree = { refresh: vi.fn() };
  const runner = { cancel: vi.fn(() => true) };
  const store = { remove: vi.fn(async () => {}) };
  const deps = {
    tree: tree as never,
    runner: runner as never,
    store: store as never,
    getRepoId,
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

const commandIds = [
  'gitGraphPro.review.cancel',
  'gitGraphPro.review.delete',
  'gitGraphPro.review.open',
  'gitGraphPro.review.rerun',
];

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

  it.each(commandIds)('%s is a no-op when no repository is active', async (commandId) => {
    const { commands, runner, store, deps, tree } = harness(() => undefined);

    await expect(commands.get(commandId)?.(entry)).resolves.not.toThrow();

    expect(runner.cancel).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(deps.openBody).not.toHaveBeenCalled();
    expect(deps.rerun).not.toHaveBeenCalled();
    expect(tree.refresh).not.toHaveBeenCalled();
  });

  it.each(commandIds)('%s is a no-op when getRepoId throws', async (commandId) => {
    const getRepoId = () => {
      throw new Error('ENOENT: repo directory gone');
    };
    const { commands, runner, store, deps, tree } = harness(getRepoId);

    // Must resolve, not reject: VS Code invokes a tree item's command with no
    // .catch, so a rejection here would surface as an unhandled rejection on
    // a routine click.
    await expect(commands.get(commandId)?.(entry)).resolves.not.toThrow();

    expect(runner.cancel).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(deps.openBody).not.toHaveBeenCalled();
    expect(deps.rerun).not.toHaveBeenCalled();
    expect(tree.refresh).not.toHaveBeenCalled();
  });

  it('every registration is disposed with the extension', () => {
    const { disposables } = harness();

    expect(disposables.length).toBeGreaterThanOrEqual(5);
  });
});
