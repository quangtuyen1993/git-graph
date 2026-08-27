export const PR_LIST_TTL_MS = 60_000;
export const PR_DETAIL_TTL_MS = 300_000;
/**
 * Repository metadata (the default branch) and reviewer suggestions both
 * change rarely — nowhere near as often as a pull request list — so they
 * get a longer TTL than PR_DETAIL_TTL_MS rather than being re-fetched on
 * every create-pull-request form open.
 */
export const REPO_INFO_TTL_MS = 600_000;
/** A diff is keyed by its sha pair, so its content can never change. */
export const DIFF_TTL_MS = Number.POSITIVE_INFINITY;

/**
 * Cap on how many never-expiring entries (diffs, diffstat file lists) the
 * store holds at once. The immutability argument for DIFF_TTL_MS being
 * infinite is sound — the content genuinely never changes — but nothing
 * bounded the memory: browsing twenty pull requests across a few
 * repositories in one session held every one of their diffs forever. An
 * entry with a finite TTL ages out on its own and needs no such cap.
 */
const MAX_IMMUTABLE_ENTRIES = 20;

export interface CacheResult<T> {
  value: T;
  /** True when the loader failed and this is the previous value. */
  stale: boolean;
  fetchedAt: number;
}

interface Entry {
  value: unknown;
  fetchedAt?: number;
  inFlight?: Promise<unknown>;
}

/**
 * A small TTL cache with two behaviours the UI depends on:
 *
 *  - concurrent callers for the same key share one load, so opening the PR
 *    section does not fan out into duplicate requests against an hourly quota
 *  - a failed reload resolves with the last good value marked stale, so a
 *    network blink annotates the list instead of emptying it
 */
export class ForgeStore {
  private readonly entries = new Map<string, Entry>();
  /** Recency order (oldest first) for entries fetched with an infinite TTL. */
  private readonly immutableOrder: string[] = [];

  constructor(private readonly clock: () => number = Date.now) {}

  public async fetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const existing = this.entries.get(key);

    if (existing?.inFlight) {
      try {
        const value = (await existing.inFlight) as T;
        return { value, stale: false, fetchedAt: this.entries.get(key)?.fetchedAt ?? this.clock() };
      } catch (error) {
        // Fix #1: followers share the same stale-fallback logic as the leader
        const current = this.entries.get(key);
        if (current && current.fetchedAt !== undefined) {
          return { value: current.value as T, stale: true, fetchedAt: current.fetchedAt };
        }
        throw error;
      }
    }

    if (existing && existing.fetchedAt !== undefined && this.clock() - existing.fetchedAt < ttlMs) {
      if (ttlMs === Number.POSITIVE_INFINITY) this.touchImmutable(key);
      return { value: existing.value as T, stale: false, fetchedAt: existing.fetchedAt };
    }

    const inFlight = loader();
    this.entries.set(key, { value: existing?.value, fetchedAt: existing?.fetchedAt, inFlight });

    try {
      const value = await inFlight;
      const fetchedAt = this.clock();
      // Fix #2: only update cache if this load is still valid (wasn't invalidated)
      if (this.entries.get(key)?.inFlight === inFlight) {
        this.entries.set(key, { value, fetchedAt });
        if (ttlMs === Number.POSITIVE_INFINITY) this.touchImmutable(key);
      }
      return { value, stale: false, fetchedAt };
    } catch (error) {
      const current = this.entries.get(key);
      // Fix #2: only handle stale fallback if this load is still valid (wasn't invalidated)
      if (current?.inFlight !== inFlight) {
        // Entry was invalidated or superseded by another load, don't touch the map
        throw error;
      }
      if (current && current.fetchedAt !== undefined) {
        this.entries.set(key, { value: current.value, fetchedAt: current.fetchedAt });
        return { value: current.value as T, stale: true, fetchedAt: current.fetchedAt };
      }
      this.entries.delete(key);
      throw error;
    }
  }

  /**
   * Marks `key` most-recently-used among the infinite-TTL entries, then
   * evicts the least-recently-used ones down to the cap. Those entries never
   * age out on their own — TTL-bounded entries need no such cap, since they
   * expire and get replaced regardless.
   */
  private touchImmutable(key: string): void {
    const idx = this.immutableOrder.indexOf(key);
    if (idx !== -1) this.immutableOrder.splice(idx, 1);
    this.immutableOrder.push(key);

    while (this.immutableOrder.length > MAX_IMMUTABLE_ENTRIES) {
      const oldest = this.immutableOrder.shift();
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Drops every entry whose key starts with `prefix`. */
  public invalidate(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    for (let i = this.immutableOrder.length - 1; i >= 0; i -= 1) {
      if (this.immutableOrder[i].startsWith(prefix)) this.immutableOrder.splice(i, 1);
    }
  }

  public clear(): void {
    this.entries.clear();
    this.immutableOrder.length = 0;
  }
}
