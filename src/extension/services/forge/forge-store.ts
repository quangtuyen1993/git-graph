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
 * Byte budget for the never-expiring entries (diffs, diffstat file lists).
 * The immutability argument for DIFF_TTL_MS being infinite is sound — the
 * content genuinely never changes — but nothing bounded the memory:
 * browsing pull requests across a few repositories in one session held
 * every one of their diffs forever. An entry with a finite TTL ages out on
 * its own and needs no such cap.
 *
 * A byte cap rather than a count cap: an earlier version capped the entry
 * *count* at 20, but that treats one huge pull request's diff and one tiny
 * one as equally "one entry" — a handful of large diffs (easily several MB
 * each on a real repository) could still blow well past a sane memory
 * budget while comfortably under a count limit. 20MB comfortably holds
 * several dozen typical diffs while bounding the worst case.
 */
const MAX_IMMUTABLE_BYTES = 20 * 1024 * 1024;

/**
 * Rough byte-size estimate for a cache value, used only to weigh entries
 * against MAX_IMMUTABLE_BYTES — not an exact measurement (V8's real object
 * overhead varies), close enough to bound memory. Diff text, the dominant
 * case by far, is measured directly by its string length; anything else
 * (the diffstat file list) falls back to its JSON size.
 */
function estimateBytes(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

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
  /** Each immutable entry's estimated size, kept in step with immutableOrder. */
  private readonly immutableSizes = new Map<string, number>();
  /** Running total of immutableSizes' values — avoids resumming on every touch. */
  private immutableBytes = 0;

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
      if (ttlMs === Number.POSITIVE_INFINITY) this.touchImmutable(key, existing.value);
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
        if (ttlMs === Number.POSITIVE_INFINITY) this.touchImmutable(key, value);
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
   * evicts the least-recently-used ones until the running byte total is
   * back under MAX_IMMUTABLE_BYTES. Those entries never age out on their
   * own — TTL-bounded entries need no such cap, since they expire and get
   * replaced regardless.
   */
  private touchImmutable(key: string, value: unknown): void {
    this.dropImmutable(key);

    const size = estimateBytes(value);
    this.immutableOrder.push(key);
    this.immutableSizes.set(key, size);
    this.immutableBytes += size;

    while (this.immutableBytes > MAX_IMMUTABLE_BYTES && this.immutableOrder.length > 0) {
      const oldest = this.immutableOrder.shift();
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.dropImmutableSize(oldest);
      }
    }
  }

  /** Removes `key` from the LRU order and unwinds its tracked size, if present. */
  private dropImmutable(key: string): void {
    const idx = this.immutableOrder.indexOf(key);
    if (idx !== -1) {
      this.immutableOrder.splice(idx, 1);
      this.dropImmutableSize(key);
    }
  }

  /** Subtracts `key`'s tracked size from the running total and forgets it. */
  private dropImmutableSize(key: string): void {
    const size = this.immutableSizes.get(key);
    if (size !== undefined) {
      this.immutableBytes -= size;
      this.immutableSizes.delete(key);
    }
  }

  /** Drops every entry whose key starts with `prefix`. */
  public invalidate(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    for (let i = this.immutableOrder.length - 1; i >= 0; i -= 1) {
      const key = this.immutableOrder[i];
      if (key.startsWith(prefix)) {
        this.immutableOrder.splice(i, 1);
        this.dropImmutableSize(key);
      }
    }
  }

  public clear(): void {
    this.entries.clear();
    this.immutableOrder.length = 0;
    this.immutableSizes.clear();
    this.immutableBytes = 0;
  }
}
