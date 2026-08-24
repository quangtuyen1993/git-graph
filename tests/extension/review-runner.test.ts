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
  sourceBranch: 'main',
  sourceSha: 'a'.repeat(40),
  targetBranch: 'feat/x',
  targetSha: 'b'.repeat(40),
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
});
