const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RequestQueueDeps {
  /** Ceiling on requests in flight at once — Bitbucket and GitHub set different values. */
  maxConcurrent: number;
  /** Ceiling on how long a rate-limit response may pause every queued request. */
  maxPauseMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Concurrency-capped, pausable request gate. Bitbucket's 429 handling and
 * GitHub's 403 rate limiting need the identical mechanism underneath —
 * different status codes and headers signal it, but once a provider decides
 * a pause is needed, "hold every queued request, extend rather than shorten,
 * re-check on wake" is the same logic either way. Phase 7 (the GitHub
 * provider) duplicated this rather than extracting it: doing the extraction
 * there would itself have violated that phase's "touches only forge/github/"
 * acceptance criterion — the duplication was accepted deliberately and
 * extraction deferred to phase 8, which is this file.
 *
 * Provider-specific status-code classification stays in each provider's own
 * `classify()` — this class only enforces a pause once a provider has
 * decided one is needed, and gates concurrency around any request.
 */
export class RequestQueue {
  private readonly maxConcurrent: number;
  private readonly maxPauseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Epoch ms before which no request may start, set by a rate-limit response. */
  private pausedUntil = 0;

  constructor(deps: RequestQueueDeps) {
    this.maxConcurrent = deps.maxConcurrent;
    this.maxPauseMs = deps.maxPauseMs;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Runs `fn` once a concurrency slot is free and any active queue-wide
   * pause has elapsed. The slot is held (and released in `finally`) for the
   * duration of `fn`, mirroring how each provider previously wrapped its own
   * `fetch` call between `acquire()`/`release()`.
   */
  public async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.waitForPause();
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Clamps `rawSeconds` to `maxPauseMs` and extends (never shortens) the
   * queue-wide pause deadline — a concurrency cap of more than one means
   * several requests can each land a rate-limit response around the same
   * time, and a later one with a *shorter* wait must not cut a longer one
   * short. Returns the clamped seconds actually applied, for the caller to
   * report on its own error type rather than the raw, possibly much larger,
   * header value.
   */
  public applyPause(rawSeconds: number): number {
    const clampedPauseMs = Math.min(rawSeconds * 1000, this.maxPauseMs);
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + clampedPauseMs);
    return clampedPauseMs / 1000;
  }

  /**
   * Waits out `pausedUntil`, then re-checks it: a concurrent request can
   * extend the deadline (via `applyPause`) while this one was asleep, and
   * firing on the earlier, shorter deadline it started with would defeat the
   * point of a queue-wide pause. Loops only while the deadline itself has
   * moved further out since the last sleep — not against the raw clock —
   * so it still resolves in one pass under a mocked, instantly-resolving
   * `sleep` when nothing extended it.
   */
  private async waitForPause(): Promise<void> {
    let deadline = this.pausedUntil;
    for (;;) {
      const wait = deadline - Date.now();
      if (wait <= 0) return;
      await this.sleep(wait);
      if (this.pausedUntil <= deadline) return;
      deadline = this.pausedUntil;
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => { this.active += 1; resolve(); });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

/**
 * Retry-After is delta-seconds or an HTTP-date (RFC 9110 §10.2.3); both
 * Bitbucket and GitHub have been seen to send either. Anything that parses
 * as neither falls back to 60s rather than firing again immediately.
 */
export function parseRetryAfterHeader(header: string | null | undefined): number {
  if (header) {
    const deltaSeconds = Number(header);
    if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) return deltaSeconds;

    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
      const untilDate = Math.ceil((dateMs - Date.now()) / 1000);
      if (untilDate > 0) return untilDate;
    }
  }
  return 60;
}
