import { describe, expect, it, vi } from 'vitest';
import { MutationGate, runMutationWithProgress } from '../../src/webview/lib/mutation-gate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('sidebar checkout mutation', () => {
  it('reports checkout progress and prevents a duplicate checkout while pending', async () => {
    const gate = new MutationGate();
    const pending = deferred<void>();
    const checkout = vi.fn(() => pending.promise);
    const progress: Array<string | null> = [];

    const first = runMutationWithProgress(gate, 'Checking out…', checkout, (label) => progress.push(label));

    expect(progress).toEqual(['Checking out…']);
    await expect(runMutationWithProgress(gate, 'Checking out…', checkout, (label) => progress.push(label)))
      .rejects.toThrow('A Git mutation is already in progress');
    expect(checkout).toHaveBeenCalledTimes(1);

    pending.resolve();
    await first;
    expect(progress.at(-1)).toBeNull();
  });
});
