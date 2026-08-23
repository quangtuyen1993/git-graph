import { describe, expect, it } from 'vitest';
import {
  handleLatestWindowIntent,
  LatestRequestGate,
} from '../../src/webview/lib/latest-request';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('LatestRequestGate', () => {
  it('accepts only the latest response when requests resolve out of order', async () => {
    const gate = new LatestRequestGate();
    const firstResponse = deferred<string>();
    const secondResponse = deferred<string>();
    const accepted: string[] = [];
    const firstToken = gate.issue();
    const first = firstResponse.promise.then((value) => {
      if (gate.isLatest(firstToken)) accepted.push(value);
    });
    const secondToken = gate.issue();
    const second = secondResponse.promise.then((value) => {
      if (gate.isLatest(secondToken)) accepted.push(value);
    });

    expect([firstToken, secondToken]).toEqual([1, 2]);
    secondResponse.resolve('newest');
    await second;
    firstResponse.resolve('stale');
    await first;

    expect(accepted).toEqual(['newest']);
  });

  it('issues another token while an earlier request remains pending', () => {
    const gate = new LatestRequestGate();
    const pendingResponse = deferred<void>();

    expect(gate.issue()).toBe(1);
    void pendingResponse.promise;
    expect(gate.issue()).toBe(2);
    expect(gate.issue()).toBe(3);
  });
});

describe('latest graph window coordination', () => {
  it('keeps the cached window when an away request resolves after scrolling back', async () => {
    const gate = new LatestRequestGate();
    const topWindow = { id: 'top', startRow: 0, endRow: 20 };
    const awayWindow = { id: 'away', startRow: 50, endRow: 70 };
    const awayResponse = deferred<typeof awayWindow>();
    let graphWindow = topWindow;
    let currentStartRow = 0;
    let loading = false;
    const loadingWrites: boolean[] = [];
    let requestCount = 0;
    const setLoading = (value: boolean) => {
      loading = value;
      loadingWrites.push(value);
    };

    const awayIntent = handleLatestWindowIntent({
      gate,
      currentWindow: graphWindow,
      desiredRange: { startRow: 50, endRow: 60 },
      request: () => {
        requestCount += 1;
        return awayResponse.promise;
      },
      apply: (window) => {
        graphWindow = window;
        currentStartRow = window.startRow;
      },
      setLoading,
    });

    expect(loading).toBe(true);

    await handleLatestWindowIntent({
      gate,
      currentWindow: graphWindow,
      desiredRange: { startRow: 0, endRow: 10 },
      request: async () => {
        requestCount += 1;
        return topWindow;
      },
      apply: (window) => {
        graphWindow = window;
        currentStartRow = window.startRow;
      },
      setLoading,
    });

    expect(requestCount).toBe(1);
    expect(graphWindow).toBe(topWindow);
    expect(currentStartRow).toBe(0);
    expect(loading).toBe(false);
    const loadingWriteCountAfterCacheHit = loadingWrites.length;

    awayResponse.resolve(awayWindow);
    await awayIntent;

    expect(graphWindow).toBe(topWindow);
    expect(currentStartRow).toBe(0);
    expect(loading).toBe(false);
    expect(loadingWrites).toHaveLength(loadingWriteCountAfterCacheHit);
  });
});
