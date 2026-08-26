import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIFF_TTL_MS, ForgeStore, PR_LIST_TTL_MS } from '../../src/extension/services/forge/forge-store';

describe('ForgeStore', () => {
  let now = 1_000_000;
  let store: ForgeStore;

  beforeEach(() => {
    now = 1_000_000;
    store = new ForgeStore(() => now);
  });

  it('calls the loader once inside the TTL', async () => {
    const loader = vi.fn().mockResolvedValue('v1');
    expect((await store.fetch('k', PR_LIST_TTL_MS, loader)).value).toBe('v1');
    now += 59_000;
    const second = await store.fetch('k', PR_LIST_TTL_MS, loader);
    expect(second).toMatchObject({ value: 'v1', stale: false });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reloads once the TTL has passed', async () => {
    const loader = vi.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');
    await store.fetch('k', PR_LIST_TTL_MS, loader);
    now += 61_000;
    expect((await store.fetch('k', PR_LIST_TTL_MS, loader)).value).toBe('v2');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('never reloads an infinite TTL', async () => {
    const loader = vi.fn().mockResolvedValue('diff');
    await store.fetch('d', DIFF_TTL_MS, loader);
    now += 10 ** 9;
    await store.fetch('d', DIFF_TTL_MS, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // The screen must not empty out because the network blinked.
  it('returns the previous value marked stale when the loader fails', async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce('v1')
      .mockRejectedValueOnce(new Error('offline'));
    await store.fetch('k', PR_LIST_TTL_MS, loader);
    now += 61_000;
    const result = await store.fetch('k', PR_LIST_TTL_MS, loader);
    expect(result).toMatchObject({ value: 'v1', stale: true, fetchedAt: 1_000_000 });
  });

  it('propagates the failure when nothing is cached', async () => {
    await expect(store.fetch('k', PR_LIST_TTL_MS, () => Promise.reject(new Error('offline'))))
      .rejects.toThrow('offline');
  });

  it('invalidates by key prefix', async () => {
    const loader = vi.fn().mockResolvedValue('v');
    await store.fetch('bb:acme/mpos:open', PR_LIST_TTL_MS, loader);
    await store.fetch('bb:other/repo:open', PR_LIST_TTL_MS, loader);
    store.invalidate('bb:acme/mpos');
    await store.fetch('bb:acme/mpos:open', PR_LIST_TTL_MS, loader);
    await store.fetch('bb:other/repo:open', PR_LIST_TTL_MS, loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const loader = vi.fn().mockResolvedValue('v');
    await Promise.all([
      store.fetch('k', PR_LIST_TTL_MS, loader),
      store.fetch('k', PR_LIST_TTL_MS, loader),
      store.fetch('k', PR_LIST_TTL_MS, loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // Fix #1: followers share the stale-fallback logic with the leader
  it('gives all concurrent callers the stale value when the shared load fails with a prior value', async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce('v1')
      .mockRejectedValueOnce(new Error('offline'));
    await store.fetch('k', PR_LIST_TTL_MS, loader);
    now += 61_000;
    const results = await Promise.all([
      store.fetch('k', PR_LIST_TTL_MS, loader),
      store.fetch('k', PR_LIST_TTL_MS, loader),
      store.fetch('k', PR_LIST_TTL_MS, loader),
    ]);
    expect(results).toEqual([
      { value: 'v1', stale: true, fetchedAt: 1_000_000 },
      { value: 'v1', stale: true, fetchedAt: 1_000_000 },
      { value: 'v1', stale: true, fetchedAt: 1_000_000 },
    ]);
  });

  // Fix #1: followers propagate the error when nothing is cached
  it('gives all concurrent callers the error when the shared load fails and nothing is cached', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('offline'));
    const results = await Promise.allSettled([
      store.fetch('k', PR_LIST_TTL_MS, loader),
      store.fetch('k', PR_LIST_TTL_MS, loader),
      store.fetch('k', PR_LIST_TTL_MS, loader),
    ]);
    expect(results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'offline' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'offline' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'offline' }) },
    ]);
  });

  // Fix #2: invalidate() does not resurrect the entry when a load settles
  it('does not resurrect a cache entry when a load completes after invalidate', async () => {
    let resolveLoader: (value: string) => void;
    const delayedLoader = vi.fn(
      () => new Promise<string>(resolve => { resolveLoader = resolve; })
    );

    // Start a load
    const fetchPromise = store.fetch('k', PR_LIST_TTL_MS, delayedLoader);

    // Invalidate before it settles
    store.invalidate('k');

    // Resolve the loader after invalidation
    resolveLoader!('v');
    await fetchPromise;

    // The entry should not be resurrected, so the next fetch should call loader again
    const secondLoader = vi.fn().mockResolvedValue('v2');
    const result = await store.fetch('k', PR_LIST_TTL_MS, secondLoader);
    expect(result.value).toBe('v2');
    expect(secondLoader).toHaveBeenCalledTimes(1);
  });

  // Fix #2: Regression test for the case where an invalidated load rejects after a new load starts
  it('preserves a subsequent load\'s result even when a rejected invalidated load tries to restore stale', async () => {
    // Cache initial value
    const initialLoader = vi.fn().mockResolvedValue('cached');
    await store.fetch('k', PR_LIST_TTL_MS, initialLoader);

    // Expire the cache
    now += 61_000;

    let rejectA: (reason: unknown) => void;
    let resolveB: (value: string) => void;

    const loaderA = vi.fn(() => new Promise<string>((_, reject) => { rejectA = reject; }));
    const loaderB = vi.fn(() => new Promise<string>(resolve => { resolveB = resolve; }));

    // Start load A
    const fetchA = store.fetch('k', PR_LIST_TTL_MS, loaderA);

    // Invalidate before A settles
    store.invalidate('k');

    // Start load B (legitimate load after invalidation)
    const fetchB = store.fetch('k', PR_LIST_TTL_MS, loaderB);

    // A rejects before B resolves
    rejectA!(new Error('network error'));

    // B resolves successfully
    resolveB!('newvalue');

    // Wait for both to settle (A will throw, B will succeed)
    await fetchA.catch(() => {}); // Ignore A's error
    await fetchB;

    // The key assertion: B's result should be cached, not deleted by A's error handler
    const verifyLoader = vi.fn().mockResolvedValue('verify');
    const result = await store.fetch('k', PR_LIST_TTL_MS, verifyLoader);
    expect(result.value).toBe('newvalue');
    expect(result.stale).toBe(false);
    expect(verifyLoader).not.toHaveBeenCalled();
  });

  // Finding 4: the immutability argument for DIFF_TTL_MS = Infinity is
  // sound, but nothing bounded the memory — browsing enough pull requests in
  // one session held every one of their diffs forever.
  describe('immutable-entry cap', () => {
    it('evicts the oldest infinite-TTL entry once the cap is exceeded', async () => {
      const loader = (value: string) => vi.fn().mockResolvedValue(value);

      // Fill the cache to the cap (20) with distinct keys.
      for (let i = 0; i < 20; i += 1) {
        await store.fetch(`diff:${i}`, DIFF_TTL_MS, loader(`v${i}`));
      }
      // One more pushes it over — the oldest (diff:0) must be evicted.
      await store.fetch('diff:20', DIFF_TTL_MS, loader('v20'));

      const reloadOldest = vi.fn().mockResolvedValue('reloaded');
      const oldest = await store.fetch('diff:0', DIFF_TTL_MS, reloadOldest);
      expect(reloadOldest).toHaveBeenCalledTimes(1);
      expect(oldest.value).toBe('reloaded');

      // The most recently added entry is still cached.
      const stillCachedLoader = vi.fn().mockResolvedValue('should not be called');
      const newest = await store.fetch('diff:20', DIFF_TTL_MS, stillCachedLoader);
      expect(stillCachedLoader).not.toHaveBeenCalled();
      expect(newest.value).toBe('v20');
    });

    it('reading an entry again keeps it out of eviction (true LRU, not FIFO)', async () => {
      const loader = (value: string) => vi.fn().mockResolvedValue(value);

      for (let i = 0; i < 20; i += 1) {
        await store.fetch(`diff:${i}`, DIFF_TTL_MS, loader(`v${i}`));
      }
      // Re-read the oldest entry, moving it to most-recently-used.
      await store.fetch('diff:0', DIFF_TTL_MS, vi.fn());
      // Adding one more should now evict diff:1 (the new oldest), not diff:0.
      await store.fetch('diff:20', DIFF_TTL_MS, loader('v20'));

      const reloadZero = vi.fn().mockResolvedValue('should not be called');
      const stillThere = await store.fetch('diff:0', DIFF_TTL_MS, reloadZero);
      expect(reloadZero).not.toHaveBeenCalled();
      expect(stillThere.value).toBe('v0');

      const reloadOne = vi.fn().mockResolvedValue('reloaded');
      const evicted = await store.fetch('diff:1', DIFF_TTL_MS, reloadOne);
      expect(reloadOne).toHaveBeenCalledTimes(1);
      expect(evicted.value).toBe('reloaded');
    });

    it('does not cap TTL-bounded entries', async () => {
      const loader = (value: string) => vi.fn().mockResolvedValue(value);
      for (let i = 0; i < 25; i += 1) {
        await store.fetch(`list:${i}`, PR_LIST_TTL_MS, loader(`v${i}`));
      }
      const reload = vi.fn().mockResolvedValue('should not be called');
      const first = await store.fetch('list:0', PR_LIST_TTL_MS, reload);
      expect(reload).not.toHaveBeenCalled();
      expect(first.value).toBe('v0');
    });
  });

  // Note: "gives all concurrent callers the error when the shared load fails and nothing is cached"
  // test is documentation of the behavior but does not distinguish between buggy and fixed implementations,
  // as both throw errors in similar ways. The test is retained to ensure the behavior is tested.
});
