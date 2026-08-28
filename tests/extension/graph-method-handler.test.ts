import { describe, expect, it, vi } from 'vitest';
import { GraphMethodHandler } from '../../src/extension/controllers/graph-method-handler';
import { GraphService } from '../../src/extension/services/graph.service';
import type { Commit, GitLogOptions, ShortStat } from '../../src/extension/types/git.types';

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

function graphSource(
  repoPath: string,
  log: (options: GitLogOptions) => Promise<Commit[]>,
  shortStats: (hashes: string[]) => Promise<Map<string, ShortStat>> = async () => new Map(),
) {
  return {
    getRepoPath: () => repoPath,
    snapshotLogOptions: vi.fn(async (options: GitLogOptions) => ({
      ...options,
      all: false,
      revisions: [`${repoPath}-snapshot`],
    })),
    log: vi.fn(log),
    shortStatsFor: vi.fn(shortStats),
  };
}

const STAT: ShortStat = { filesChanged: 2, additions: 9, deletions: 3 };

/**
 * Answers every requested hash except the ones named. A named hash stands for
 * one git never listed at all — an unresolvable or garbage-collected revision.
 * A merge is *not* such a hash: git lists it and prints no stat line, which
 * `parseShortStats` reports as `{0, 0, 0}`.
 */
function statsExcept(...silent: string[]) {
  return async (hashes: string[]) => new Map(
    hashes.filter((hash) => !silent.includes(hash)).map((hash) => [hash, STAT] as const),
  );
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

describe('GraphMethodHandler stats cache', () => {
  const A = commit('a').hash;
  const B = commit('b').hash;
  const UNLISTED = commit('gone').hash;

  async function built(source: ReturnType<typeof graphSource>) {
    const handler = new GraphMethodHandler(new GraphService(), () => source);
    const build = await handler.handle('graph.build', { all: true }) as { layoutVersion: number };
    return { handler, layoutVersion: build.layoutVersion };
  }

  it('builds the graph without asking git for any shortstat', async () => {
    const source = graphSource('/repo', async () => [commit('a'), commit('b')]);
    const { handler, layoutVersion } = await built(source);

    expect(source.log).toHaveBeenCalled();
    expect(source.snapshotLogOptions).toHaveBeenCalled();
    expect(source.shortStatsFor).not.toHaveBeenCalled();

    // A window is served straight from the layout: stats unknown, no git call.
    const window = await handler.handle('graph.getWindow', {
      startRow: 0, count: 20, layoutVersion,
    }) as { nodes: { filesChanged: number | null; additions: number | null; deletions: number | null }[] };
    expect(window.nodes[0]).toMatchObject({ filesChanged: null, additions: null, deletions: null });
    expect(source.shortStatsFor).not.toHaveBeenCalled();
  });

  it('fetches a hash set once and serves the repeat from cache', async () => {
    const source = graphSource('/repo', async () => [commit('a')], statsExcept());
    const { handler } = await built(source);

    const first = await handler.handle('graph.getStats', { hashes: [A, B] });
    expect(first).toEqual({ [A]: STAT, [B]: STAT });
    expect(source.shortStatsFor).toHaveBeenCalledTimes(1);

    const second = await handler.handle('graph.getStats', { hashes: [A, B] });
    expect(second).toEqual({ [A]: STAT, [B]: STAT });
    expect(source.shortStatsFor).toHaveBeenCalledTimes(1);
  });

  it('fetches only the uncached hashes of a mixed request, answering both together', async () => {
    const source = graphSource('/repo', async () => [commit('a')], statsExcept());
    const { handler } = await built(source);

    await handler.handle('graph.getStats', { hashes: [A] });
    const mixed = await handler.handle('graph.getStats', { hashes: [A, B] });

    expect(mixed).toEqual({ [A]: STAT, [B]: STAT });
    expect(source.shortStatsFor).toHaveBeenCalledTimes(2);
    expect(source.shortStatsFor.mock.calls[1][0]).toEqual([B]);
  });

  it('caches a hash git never lists negatively so it is never requested twice', async () => {
    // A revision git cannot resolve is absent from the map, not zeroed — that
    // is the state the dim rule's error contract rests on. Caching only what
    // git answered for would re-ask for such a hash on every window, forever.
    // (A merge is not this case: git lists it, so it comes back as {0,0,0} and
    // the webview excludes it by parent count instead.)
    const source = graphSource('/repo', async () => [commit('a')], statsExcept(UNLISTED));
    const { handler } = await built(source);

    expect(await handler.handle('graph.getStats', { hashes: [UNLISTED] })).toEqual({ [UNLISTED]: null });
    expect(source.shortStatsFor).toHaveBeenCalledTimes(1);

    expect(await handler.handle('graph.getStats', { hashes: [UNLISTED] })).toEqual({ [UNLISTED]: null });
    expect(source.shortStatsFor).toHaveBeenCalledTimes(1);
  });

  it('keeps the cache across an ordinary invalidate(), which is not a repo switch', async () => {
    // invalidate() runs on the 500ms-debounced git file watcher — on every
    // commit, checkout and index change. A commit's shortstat is immutable, so
    // dropping the cache here would leave it worthless.
    const source = graphSource('/repo', async () => [commit('a')], statsExcept());
    const { handler } = await built(source);

    await handler.handle('graph.getStats', { hashes: [A] });
    handler.invalidate();
    await handler.handle('graph.build', { all: true });

    expect(await handler.handle('graph.getStats', { hashes: [A] })).toEqual({ [A]: STAT });
    expect(source.shortStatsFor).toHaveBeenCalledTimes(1);
  });

  it('drops the cache when the repository identity behind it changes', async () => {
    const oldSource = graphSource('/old', async () => [commit('a')], statsExcept());
    const newSource = graphSource('/new', async () => [commit('a')], statsExcept());
    let currentSource = oldSource;
    const handler = new GraphMethodHandler(new GraphService(), () => currentSource);
    await handler.handle('graph.build', { all: true });

    await handler.handle('graph.getStats', { hashes: [A] });
    expect(oldSource.shortStatsFor).toHaveBeenCalledTimes(1);

    // What repo.switch does: invalidate(), then swap the git service.
    handler.invalidate();
    currentSource = newSource;

    expect(await handler.handle('graph.getStats', { hashes: [A] })).toEqual({ [A]: STAT });
    expect(newSource.shortStatsFor).toHaveBeenCalledTimes(1);
    expect(oldSource.shortStatsFor).toHaveBeenCalledTimes(1);
  });

  it('discards stats that arrive after the repository they belong to is gone', async () => {
    // The switch lands *during* the fetch, not between two calls. Writing the
    // old repository's answer into a cache that has since been re-keyed to the
    // new one would serve repo A's numbers for hash X under repo B for the
    // rest of the session — a cache hit, so nothing ever re-asks.
    const OLD_STAT: ShortStat = { filesChanged: 99, additions: 99, deletions: 99 };
    const oldStats = deferred<Map<string, ShortStat>>();
    const oldSource = graphSource('/old', async () => [commit('a')], () => oldStats.promise);
    const newSource = graphSource('/new', async () => [commit('a')], statsExcept());
    let currentSource = oldSource;
    const handler = new GraphMethodHandler(new GraphService(), () => currentSource);
    await handler.handle('graph.build', { all: true });

    const inFlight = handler.handle('graph.getStats', { hashes: [A] });
    await Promise.resolve();

    // What repo.switch does, while the fetch above is still outstanding.
    handler.invalidate();
    currentSource = newSource;
    // A call on the new repository re-keys the cache to the new identity.
    await handler.handle('graph.getStats', { hashes: [B] });

    oldStats.resolve(new Map([[A, OLD_STAT]]));
    await inFlight;

    expect(await handler.handle('graph.getStats', { hashes: [A] })).toEqual({ [A]: STAT });
    expect(newSource.shortStatsFor.mock.calls.map((call) => call[0])).toEqual([[B], [A]]);
  });

  it('leaves rows unknown when the stats call fails, and retries them later', async () => {
    // Stats are decoration; the graph is the feature. A failure surfaces
    // nothing — and must not be cached as null, which would mean "known
    // empty" forever.
    let fail = true;
    const source = graphSource('/repo', async () => [commit('a')], async (hashes) => {
      if (fail) throw new Error('git exploded');
      return new Map(hashes.map((hash) => [hash, STAT] as const));
    });
    const { handler } = await built(source);

    expect(await handler.handle('graph.getStats', { hashes: [A] })).toEqual({ [A]: null });

    fail = false;
    expect(await handler.handle('graph.getStats', { hashes: [A] })).toEqual({ [A]: STAT });
    expect(source.shortStatsFor).toHaveBeenCalledTimes(2);
  });
});
