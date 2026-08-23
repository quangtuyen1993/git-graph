import { describe, expect, it, vi } from 'vitest';
import {
  LatestRequestGate,
  LatestWindowRequestCoordinator,
  runLatestRequest,
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
    const coordinator = new LatestWindowRequestCoordinator<{
      id: string;
      startRow: number;
      endRow: number;
    }>(gate);
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

    const awayIntent = coordinator.handle({
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

    await coordinator.handle({
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

describe('latest graph refresh coordination', () => {
  it('keeps the new repository state when the old build resolves last', async () => {
    const gate = new LatestRequestGate();
    const oldBuild = deferred<{ repo: string; layoutVersion: number }>();
    const newBuild = deferred<{ repo: string; layoutVersion: number }>();
    let applied = { repo: 'initial', layoutVersion: 0 };

    const oldRefresh = runLatestRequest(
      gate,
      () => oldBuild.promise,
      (result) => { applied = result; },
    );
    const newRefresh = runLatestRequest(
      gate,
      () => newBuild.promise,
      (result) => { applied = result; },
    );

    newBuild.resolve({ repo: 'new', layoutVersion: 2 });
    await expect(newRefresh).resolves.toBe(true);
    oldBuild.resolve({ repo: 'old', layoutVersion: 1 });
    await expect(oldRefresh).resolves.toBe(false);

    expect(applied).toEqual({ repo: 'new', layoutVersion: 2 });
  });
});

describe('LatestWindowRequestCoordinator', () => {
  it('runs at most one request and coalesces pending intents to the latest range', async () => {
    const coordinator = new LatestWindowRequestCoordinator<{
      id: string;
      startRow: number;
      endRow: number;
    }>();
    const currentWindow = { id: 'top', startRow: 0, endRow: 20 };
    const firstResponse = deferred<{ id: string; startRow: number; endRow: number }>();
    const skippedResponse = deferred<{ id: string; startRow: number; endRow: number }>();
    const latestResponse = deferred<{ id: string; startRow: number; endRow: number }>();
    const requestedRanges: number[] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let appliedWindow = currentWindow;
    const request = (
      startRow: number,
      response: ReturnType<typeof deferred<{ id: string; startRow: number; endRow: number }>>,
    ) => async () => {
      requestedRanges.push(startRow);
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        return await response.promise;
      } finally {
        activeRequests -= 1;
      }
    };
    const options = (startRow: number, response: typeof firstResponse) => ({
      currentWindow,
      desiredRange: { startRow, endRow: startRow + 10 },
      request: request(startRow, response),
      apply: (window: typeof currentWindow) => { appliedWindow = window; },
      setLoading: () => undefined,
    });

    const first = coordinator.handle(options(50, firstResponse));
    const skipped = coordinator.handle(options(100, skippedResponse));
    const latest = coordinator.handle(options(200, latestResponse));

    expect(requestedRanges).toEqual([50]);
    expect(maxActiveRequests).toBe(1);

    firstResponse.resolve({ id: 'first', startRow: 50, endRow: 70 });
    await vi.waitFor(() => expect(requestedRanges).toEqual([50, 200]));
    expect(maxActiveRequests).toBe(1);

    latestResponse.resolve({ id: 'latest', startRow: 200, endRow: 220 });
    await Promise.all([first, skipped, latest]);

    expect(requestedRanges).toEqual([50, 200]);
    expect(appliedWindow.id).toBe('latest');
    expect(maxActiveRequests).toBe(1);
  });

  it('clears loading after the latest rejection and accepts a subsequent intent', async () => {
    const coordinator = new LatestWindowRequestCoordinator<{
      id: string;
      startRow: number;
      endRow: number;
    }>();
    const currentWindow = { id: 'top', startRow: 0, endRow: 20 };
    const loadingWrites: boolean[] = [];
    let activeRequests = 0;
    let appliedWindow = currentWindow;

    await expect(coordinator.handle({
      currentWindow,
      desiredRange: { startRow: 50, endRow: 60 },
      request: async () => {
        activeRequests += 1;
        try {
          throw new Error('window failed');
        } finally {
          activeRequests -= 1;
        }
      },
      apply: (window) => { appliedWindow = window; },
      setLoading: (value) => { loadingWrites.push(value); },
    })).rejects.toThrow('window failed');

    expect(activeRequests).toBe(0);
    expect(loadingWrites.at(-1)).toBe(false);

    await expect(coordinator.handle({
      currentWindow,
      desiredRange: { startRow: 100, endRow: 110 },
      request: async () => {
        activeRequests += 1;
        try {
          return { id: 'recovered', startRow: 100, endRow: 120 };
        } finally {
          activeRequests -= 1;
        }
      },
      apply: (window) => { appliedWindow = window; },
      setLoading: (value) => { loadingWrites.push(value); },
    })).resolves.toBeUndefined();

    expect(activeRequests).toBe(0);
    expect(appliedWindow.id).toBe('recovered');
    expect(loadingWrites.at(-1)).toBe(false);
  });
});
