import { describe, expect, it } from 'vitest';
import { MutationGate } from '../../src/webview/lib/mutation-gate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MutationGate', () => {
  it('exposes the active label and rejects a duplicate mutation', async () => {
    const gate = new MutationGate();
    const pending = deferred<void>();
    const first = gate.run('Stashing changes…', () => pending.promise);

    expect(gate.activeLabel).toBe('Stashing changes…');
    await expect(gate.run('Resetting…', async () => undefined)).rejects.toThrow('A Git mutation is already in progress');

    pending.resolve();
    await first;
    expect(gate.activeLabel).toBeNull();
  });

  it('clears its active label when the mutation rejects', async () => {
    const gate = new MutationGate();

    await expect(gate.run('Stashing changes…', async () => {
      throw new Error('stash failed');
    })).rejects.toThrow('stash failed');

    expect(gate.activeLabel).toBeNull();
  });
});
