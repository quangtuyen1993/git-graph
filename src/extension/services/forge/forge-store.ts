export const PR_LIST_TTL_MS = 60_000;
export const PR_DETAIL_TTL_MS = 300_000;
/** A diff is keyed by its sha pair, so its content can never change. */
export const DIFF_TTL_MS = Number.POSITIVE_INFINITY;

export interface CacheResult<T> {
  value: T;
  /** True when the loader failed and this is the previous value. */
  stale: boolean;
  fetchedAt: number;
}

interface Entry {
  value: unknown;
  fetchedAt: number;
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

  constructor(private readonly clock: () => number = Date.now) {}

  public async fetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const existing = this.entries.get(key);

    if (existing?.inFlight) {
      const value = (await existing.inFlight) as T;
      return { value, stale: false, fetchedAt: this.entries.get(key)?.fetchedAt ?? this.clock() };
    }

    if (existing && this.clock() - existing.fetchedAt < ttlMs) {
      return { value: existing.value as T, stale: false, fetchedAt: existing.fetchedAt };
    }

    const inFlight = loader();
    this.entries.set(key, { value: existing?.value, fetchedAt: existing?.fetchedAt ?? 0, inFlight });

    try {
      const value = await inFlight;
      const fetchedAt = this.clock();
      this.entries.set(key, { value, fetchedAt });
      return { value, stale: false, fetchedAt };
    } catch (error) {
      if (existing && existing.fetchedAt > 0) {
        this.entries.set(key, { value: existing.value, fetchedAt: existing.fetchedAt });
        return { value: existing.value as T, stale: true, fetchedAt: existing.fetchedAt };
      }
      this.entries.delete(key);
      throw error;
    }
  }

  /** Drops every entry whose key starts with `prefix`. */
  public invalidate(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}
