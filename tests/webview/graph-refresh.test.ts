import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRefreshScheduler, isSupersededError } from '../../src/webview/lib/graph-refresh';

describe('isSupersededError', () => {
  it('recognises the error kind carried across the bridge', () => {
    const error = Object.assign(new Error('Graph build superseded'), { kind: 'GRAPH_BUILD_SUPERSEDED' });
    expect(isSupersededError(error)).toBe(true);
  });

  it('does not guess from message text alone', () => {
    expect(isSupersededError(new Error('Graph build superseded'))).toBe(false);
  });

  it('tolerates non-errors', () => {
    expect(isSupersededError(undefined)).toBe(false);
    expect(isSupersededError('boom')).toBe(false);
  });
});

describe('createRefreshScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of invalidations into one run', async () => {
    const run = vi.fn(async () => {});
    const scheduler = createRefreshScheduler({ run, delayMs: 200, onError: () => {} });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports failures through onError', async () => {
    const onError = vi.fn();
    const scheduler = createRefreshScheduler({
      run: async () => { throw new Error('nope'); },
      delayMs: 10,
      onError,
    });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('nope');
  });

  it('does not run after cancel', async () => {
    const run = vi.fn(async () => {});
    const scheduler = createRefreshScheduler({ run, delayMs: 50, onError: () => {} });

    scheduler.schedule();
    scheduler.cancel();
    await vi.advanceTimersByTimeAsync(50);

    expect(run).not.toHaveBeenCalled();
  });
});
