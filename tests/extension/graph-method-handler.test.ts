import { describe, expect, it, vi } from 'vitest';
import { GraphMethodHandler } from '../../src/extension/controllers/graph-method-handler';
import { GraphService } from '../../src/extension/services/graph.service';
import type { Commit, GitLogOptions } from '../../src/extension/types/git.types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function commit(subject: string): Commit {
  const hash = subject.toLowerCase().padEnd(40, '0');
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    parents: [],
    author: 'A',
    authorEmail: 'a@example.test',
    authorDate: '2026-08-23T00:00:00Z',
    committer: 'A',
    committerEmail: 'a@example.test',
    committerDate: '2026-08-23T00:00:00Z',
    message: subject,
    subject,
    refs: [],
  };
}

function graphSource(repoPath: string, log: (options: GitLogOptions) => Promise<Commit[]>) {
  return {
    getRepoPath: () => repoPath,
    snapshotLogOptions: vi.fn(async (options: GitLogOptions) => ({
      ...options,
      all: false,
      revisions: [`${repoPath}-snapshot`],
    })),
    log: vi.fn(log),
  };
}

describe('GraphMethodHandler', () => {
  it('publishes only the latest repository build and rejects mismatched window versions', async () => {
    const oldLog = deferred<Commit[]>();
    const oldSource = graphSource('/old', () => oldLog.promise);
    const newSource = graphSource('/new', async () => [commit('new')]);
    let currentSource = oldSource;
    const handler = new GraphMethodHandler(
      new GraphService(),
      () => currentSource,
    );

    const oldBuild = handler.handle('graph.build', { all: true });
    await Promise.resolve();
    currentSource = newSource;
    handler.invalidate();

    const newBuild = await handler.handle('graph.build', { all: true }) as {
      totalRows: number;
      layoutVersion: number;
    };
    expect(newBuild.totalRows).toBe(1);

    const newWindow = await handler.handle('graph.getWindow', {
      startRow: 0,
      count: 20,
      layoutVersion: newBuild.layoutVersion,
    }) as { nodes: Commit[] };
    expect(newWindow.nodes[0].subject).toBe('new');
    await expect(handler.handle('graph.getRow', {
      hash: commit('new').hash,
      layoutVersion: newBuild.layoutVersion,
    })).resolves.toEqual({ row: 0 });
    await expect(handler.handle('graph.getRow', {
      hash: 'missing',
      layoutVersion: newBuild.layoutVersion,
    })).resolves.toEqual({ row: null });

    oldLog.resolve([commit('old')]);
    await expect(oldBuild).rejects.toThrow('Graph build superseded');

    const stillNewWindow = await handler.handle('graph.getWindow', {
      startRow: 0,
      count: 20,
      layoutVersion: newBuild.layoutVersion,
    }) as { nodes: Commit[] };
    expect(stillNewWindow.nodes[0].subject).toBe('new');
    await expect(handler.handle('graph.getWindow', {
      startRow: 0,
      count: 20,
      layoutVersion: newBuild.layoutVersion + 1,
    })).rejects.toThrow('Graph layout version mismatch');
    await expect(handler.handle('graph.getWindow', {
      startRow: 0,
      count: 20,
    })).rejects.toThrow('layoutVersion is required');
    await expect(handler.handle('graph.getRow', {
      hash: commit('new').hash,
      layoutVersion: newBuild.layoutVersion + 1,
    })).rejects.toThrow('Graph layout version mismatch');
  });

  it('invalidates the published layout version as soon as repository identity changes', async () => {
    const oldSource = graphSource('/old', async () => [commit('old')]);
    const newSource = graphSource('/new', async () => [commit('new')]);
    let currentSource = oldSource;
    const handler = new GraphMethodHandler(
      new GraphService(),
      () => currentSource,
    );
    const oldBuild = await handler.handle('graph.build', { all: true }) as {
      layoutVersion: number;
    };

    currentSource = newSource;
    handler.invalidate();

    await expect(handler.handle('graph.getWindow', {
      startRow: 0,
      count: 20,
      layoutVersion: oldBuild.layoutVersion,
    })).rejects.toThrow('Graph layout version mismatch');
  });

  it('tags a superseded build with a stable error code', async () => {
    // invalidate() bumps the generation before the event goes out, so the
    // in-flight build is expected to lose. The webview must recognise that
    // from a code, not from the message text.
    const pendingLog = deferred<Commit[]>();
    const source = graphSource('/repo', () => pendingLog.promise);
    const handler = new GraphMethodHandler(new GraphService(), () => source);

    const inFlight = handler.handle('graph.build', { all: true });
    await Promise.resolve();
    handler.invalidate();
    pendingLog.resolve([commit('old')]);

    await expect(inFlight).rejects.toMatchObject({
      message: 'Graph build superseded',
      code: 'GRAPH_BUILD_SUPERSEDED',
    });
  });
});
