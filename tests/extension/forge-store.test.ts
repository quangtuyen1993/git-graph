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
});
