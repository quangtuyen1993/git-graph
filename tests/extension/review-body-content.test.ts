import { EventEmitter } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('child_process', () => ({ spawn: hoisted.spawn }));
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === 'deepseekApiKey' ? 'sk-test-key' : undefined),
    }),
  },
}));

import { AIReviewService } from '../../src/extension/services/ai-review.service';
import { ReviewRunner, type StartReviewInput } from '../../src/extension/services/review-runner';
import { ReviewStore } from '../../src/extension/services/review-store';

const REPO = 'repo-a';
let root: string;
let store: ReviewStore;

function baseInput(provider: string): StartReviewInput {
  return {
    repoId: REPO,
    kind: 'branch',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'feat/x',
    headSha: 'b'.repeat(40),
    provider,
    model: 'default',
    payloadText: 'payload',
  };
}

/**
 * A child process whose stdout the test drives. The chunks are emitted a tick
 * after `spawn` is called — not a tick after the mock is armed — so the runner
 * sees them exactly as it would a live CLI: as a stream, before the exit.
 */
function armSpawn(chunks: string[]): void {
  hoisted.spawn.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.pid = 999999;
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kill = vi.fn();
    setTimeout(() => {
      for (const chunk of chunks) (proc.stdout as EventEmitter).emit('data', Buffer.from(chunk));
      proc.exitCode = 0;
      proc.emit('close', 0);
    }, 0);
    return proc;
  });
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Runs a full review through the real service and returns the stored body. */
async function bodyFor(provider: string, stdoutChunks: string[]): Promise<string> {
  armSpawn(stdoutChunks);
  const runner = new ReviewRunner(store, new AIReviewService(), () => {});
  const id = await runner.start(baseInput(provider));
  await waitFor(() => runner.isRunning(id) === false);
  expect((await store.get(REPO, id))?.status).toBe('done');
  return store.readBody(REPO, id);
}

beforeEach(async () => {
  hoisted.spawn.mockReset();
  root = await mkdtemp(join(tmpdir(), 'review-body-'));
  store = new ReviewStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * C1: the runner used to keep whatever `onChunk` streamed, which is unprocessed
 * stdout. Every provider except `claude --print` post-processes *after* the
 * stream, so the stored document — the feature's primary artifact — was a
 * terminal transcript or a raw JSON envelope.
 */
describe('the stored review body is the processed content, not raw stdout', () => {
  it('codex: the transcript is sliced down to the review', async () => {
    const transcript = [
      'Reading prompt from stdin...\n',
      '\u001b[1mOpenAI Codex v1.2\u001b[0m\n',
      'workdir: /repo\nmodel: gpt-5\n',
      '\ncodex\n',
      '## Summary\n\u001b[32mLooks good.\u001b[0m\n',
      '\ntokens used\n12,345\n',
    ];

    const body = await bodyFor('codex', transcript);

    expect(body).toBe('## Summary\nLooks good.');
    expect(body).not.toContain('tokens used');
    expect(body).not.toContain('\u001b[');
  });

  it('deepseek: the JSON envelope is unwrapped', async () => {
    const envelope = JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: '## Verdict\nAPPROVE' } }],
    });

    // Split across chunks, exactly as curl delivers a long response.
    const body = await bodyFor('deepseek', [envelope.slice(0, 30), envelope.slice(30)]);

    expect(body).toBe('## Verdict\nAPPROVE');
    expect(body).not.toContain('choices');
  });

  it('kiro: ANSI escape codes are stripped', async () => {
    const body = await bodyFor('kiro', ['\u001b[31mIssues\u001b[0m: none\n']);

    expect(body).toBe('Issues: none\n');
  });

  it('claude: clean stdout survives untouched', async () => {
    const body = await bodyFor('claude', ['## Summary\n', 'No issues found.\n']);

    expect(body).toBe('## Summary\nNo issues found.\n');
  });

  it('control characters are sanitised out of the stored document', async () => {
    const body = await bodyFor('claude', ['clean\u0000er\u0007 text']);

    expect(body).toBe('cleaner text');
  });
});
