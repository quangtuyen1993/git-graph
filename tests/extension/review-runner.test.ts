import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ai-review.service.ts imports `vscode` for its real CLI-spawning paths, which
// this test never exercises (the fake service below stands in for it) — but
// the module still needs to load to reach `ReviewCancelledError`, and there is
// no real `vscode` module under vitest, so it is mocked exactly as the other
// tests that touch this file do.
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

import { ReviewStore } from '../../src/extension/services/review-store';
import { ReviewRunner, type StartReviewInput } from '../../src/extension/services/review-runner';
import { ReviewCancelledError } from '../../src/extension/services/ai-review.service';

const REPO = 'repo-a';
let root: string;
let store: ReviewStore;

const input: StartReviewInput = {
  repoId: REPO,
  kind: 'branch',
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  headRef: 'feat/x',
  headSha: 'b'.repeat(40),
  provider: 'claude',
  model: 'sonnet',
  payloadText: 'payload',
};

/** A service stand-in whose single review call is resolved by the test. */
function deferredService() {
  let settle!: (value: { content: string }) => void;
  let fail!: (err: Error) => void;
  const captured: { onChunk?: (t: string) => void; signal?: AbortSignal } = {};

  const service = {
    review: vi.fn((req: { onChunk?: (t: string) => void; signal?: AbortSignal }) => {
      captured.onChunk = req.onChunk;
      captured.signal = req.signal;
      return new Promise<{ content: string }>((resolve, reject) => {
        settle = resolve;
        fail = reject;
        req.signal?.addEventListener('abort', () => reject(new ReviewCancelledError()), { once: true });
      });
    }),
  };
  return { service, captured, settle: (c: string) => settle({ content: c }), fail: (e: Error) => fail(e) };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-runner-'));
  store = new ReviewStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ReviewRunner', () => {
  it('returns an id immediately and leaves the entry running', async () => {
    const { service } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});

    const id = await runner.start(input);

    expect(id).toBe('aaaaaaa..bbbbbbb.claude.sonnet');
    expect((await store.get(REPO, id))?.status).toBe('running');
    expect(runner.isRunning(id)).toBe(true);
  });

  it('streams chunks into the body file', async () => {
    const { service, captured, settle } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    captured.onChunk?.('hello ');
    captured.onChunk?.('world');
    settle('hello world');
    await waitFor(() => runner.isRunning(id) === false);

    expect(await store.readBody(REPO, id)).toBe('hello world');
  });

  it('marks the entry done when the CLI exits cleanly', async () => {
    const { service, settle } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    settle('the review');
    await waitFor(() => runner.isRunning(id) === false);

    const entry = await store.get(REPO, id);
    expect(entry?.status).toBe('done');
    expect(entry?.finishedAt).toBeTruthy();
  });

  it('marks the entry failed and records the error in the body', async () => {
    const { service, fail } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    fail(new Error('claude failed (exit 1): boom'));
    await waitFor(() => runner.isRunning(id) === false);

    const entry = await store.get(REPO, id);
    expect(entry?.status).toBe('failed');
    expect(entry?.error).toContain('boom');
    expect(await store.readBody(REPO, id)).toContain('boom');
  });

  it('keeps the partial body when cancelled', async () => {
    const { service, captured } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    captured.onChunk?.('half a review');
    expect(runner.cancel(REPO, id)).toBe(true);
    await waitFor(() => runner.isRunning(id) === false);

    expect((await store.get(REPO, id))?.status).toBe('cancelled');
    expect(await store.readBody(REPO, id)).toBe('half a review');
  });

  it('reports cancel of an unknown id as false', async () => {
    const { service } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});

    expect(runner.cancel(REPO, 'nope')).toBe(false);
  });

  it('cancelAll stops every in-flight run', async () => {
    const first = deferredService();
    const runner = new ReviewRunner(store, first.service as never, () => {});
    const idA = await runner.start(input);
    const idB = await runner.start({ ...input, model: 'opus' });

    runner.cancelAll();
    await waitFor(() => !runner.isRunning(idA) && !runner.isRunning(idB));

    expect((await store.get(REPO, idA))?.status).toBe('cancelled');
    expect((await store.get(REPO, idB))?.status).toBe('cancelled');
  });

  it('notifies on every status transition so the tree can refresh', async () => {
    const { service, settle } = deferredService();
    const changes: string[] = [];
    const runner = new ReviewRunner(store, service as never, (_repo, id) => changes.push(id));

    const id = await runner.start(input);
    settle('done');
    await waitFor(() => runner.isRunning(id) === false);

    expect(changes.filter(c => c === id).length).toBeGreaterThanOrEqual(2);
  });

  it('is idempotent for a second start() while the same id is already in flight', async () => {
    const { service, captured } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});

    const idA = await runner.start(input);
    captured.onChunk?.('first run body');
    const idB = await runner.start(input);

    expect(idB).toBe(idA);
    expect(service.review).toHaveBeenCalledTimes(1);
    // The original controller must still be the one governing the run — a
    // second, competing entry in `inFlight` would have orphaned it.
    expect(runner.cancel(REPO, idA)).toBe(true);
    await waitFor(() => runner.isRunning(idA) === false);

    expect((await store.get(REPO, idA))?.status).toBe('cancelled');
    expect(await store.readBody(REPO, idA)).toBe('first run body');
  });

  it('replaces the streamed stdout with the processed result', async () => {
    // C1: the stream is raw CLI stdout. Only the value the service returns has
    // been through the provider's post-processing (codex transcript slicing,
    // deepseek JSON unwrapping) and the control-character sanitisation.
    const { service, captured, settle } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    captured.onChunk?.('\u001b[32mraw terminal transcript\u001b[0m\n');
    captured.onChunk?.('tokens used\n1234\n');
    settle('## The processed review');
    await waitFor(() => runner.isRunning(id) === false);

    expect(await store.readBody(REPO, id)).toBe('## The processed review');
  });

  it('keeps unawaited chunks in arrival order', async () => {
    // C2: the runner used to fire each append concurrently and only await the
    // pile at the end, so the libuv threadpool decided the on-disk order.
    const { service, captured, settle } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    const chunks = Array.from({ length: 32 }, (_, i) => `part-${i};`);
    for (const chunk of chunks) captured.onChunk?.(chunk);
    // No content: the streamed text is all this run produced.
    settle(undefined as never);
    await waitFor(() => runner.isRunning(id) === false);

    expect(await store.readBody(REPO, id)).toBe(chunks.join(''));
  });

  it('batches chunks instead of writing one file operation per chunk', async () => {
    // I9: every chunk used to be its own mkdir+open+write+close, and every
    // write re-triggered a reload of the open editor tab.
    const { service, captured, settle } = deferredService();
    const append = vi.spyOn(store, 'appendBody');
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    for (let i = 0; i < 10; i++) captured.onChunk?.(`chunk ${i} `);
    settle(undefined as never);
    await waitFor(() => runner.isRunning(id) === false);

    expect(append).toHaveBeenCalledTimes(1);
    append.mockRestore();
  });

  it('flushes the buffered tail before the entry is marked finished', async () => {
    const { service, captured, settle } = deferredService();
    const seenAtFinish: string[] = [];
    const runner = new ReviewRunner(store, service as never, () => {});
    const finish = vi.spyOn(store, 'finish').mockImplementation(async (repoId, entryId, patch) => {
      seenAtFinish.push(await store.readBody(repoId, entryId));
      finish.mockRestore();
      return store.finish(repoId, entryId, patch);
    });
    const id = await runner.start(input);

    captured.onChunk?.('streamed tail');
    settle(undefined as never);
    await waitFor(() => runner.isRunning(id) === false);

    expect(seenAtFinish).toEqual(['streamed tail']);
  });
});
