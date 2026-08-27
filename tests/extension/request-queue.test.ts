import { describe, expect, it, vi } from 'vitest';
import { parseRetryAfterHeader, RequestQueue } from '../../src/extension/services/forge/request-queue';

// Extracted in phase 8 from what was, until then, duplicated verbatim
// between bitbucket-api.ts and github-api.ts — see request-queue.ts's own
// doc comment for why phase 7 deliberately left the duplication in place.
// bitbucket-api.test.ts and github-api.test.ts already exercise this
// behaviour indirectly through each provider's own black-box tests; these
// pin the shared mechanism directly, independent of either provider.

describe('RequestQueue', () => {
  it('never runs more than maxConcurrent callbacks at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const queue = new RequestQueue({ maxConcurrent: 3, maxPauseMs: 1000 });

    await Promise.all(Array.from({ length: 10 }, () => queue.run(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    })));

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('releases the slot even when the callback throws', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, maxPauseMs: 1000 });
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    // If the slot were not released, this would hang forever.
    await expect(queue.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('pauses subsequent run() calls until the applied pause elapses', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const queue = new RequestQueue({ maxConcurrent: 4, maxPauseMs: 60_000, sleep });

    queue.applyPause(5);
    await queue.run(async () => 'ok');

    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('clamps applyPause to maxPauseMs and reports the clamped seconds', () => {
    const queue = new RequestQueue({ maxConcurrent: 4, maxPauseMs: 5 * 60 * 1000 });
    expect(queue.applyPause(86_400)).toBe(5 * 60);
  });

  // Two requests can each land a rate-limit response around the same time;
  // the one carrying the longer wait must not be cut short by a later,
  // shorter one landing after it.
  it('extends the pause deadline rather than shortening it', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const queue = new RequestQueue({ maxConcurrent: 4, maxPauseMs: 60_000, sleep });

    queue.applyPause(10);
    queue.applyPause(3);
    await queue.run(async () => 'ok');

    const waitedMs = sleep.mock.calls[0][0] as number;
    expect(waitedMs).toBeGreaterThan(5000);
  });

  it('sleeps again when the deadline is extended while a run() is already asleep', async () => {
    const queue = new RequestQueue({ maxConcurrent: 4, maxPauseMs: 60_000 });
    queue.applyPause(5);

    let sleepCallCount = 0;
    const sleep = vi.fn().mockImplementation(async () => {
      sleepCallCount += 1;
      if (sleepCallCount === 1) queue.applyPause(60);
    });
    (queue as unknown as { sleep: typeof sleep }).sleep = sleep;

    await queue.run(async () => 'ok');
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe('parseRetryAfterHeader', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterHeader('37')).toBe(37);
  });

  it('parses an HTTP-date into a delta from now', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(parseRetryAfterHeader(new Date(now + 12_000).toUTCString())).toBe(12);
    vi.restoreAllMocks();
  });

  it('falls back to 60 for a missing header', () => {
    expect(parseRetryAfterHeader(null)).toBe(60);
    expect(parseRetryAfterHeader(undefined)).toBe(60);
  });

  it('falls back to 60 for a header that is neither a valid delta nor a future date', () => {
    expect(parseRetryAfterHeader('not-a-real-value')).toBe(60);
  });
});
