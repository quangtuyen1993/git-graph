import { describe, expect, it } from 'vitest';
import { LatestRequestGate } from '../../src/webview/lib/latest-request';

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
