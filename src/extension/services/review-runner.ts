import { AIReviewService, ReviewCancelledError } from './ai-review.service';
import { buildReviewId } from './review-key';
import type { ReviewStore } from './review-store';

export interface StartReviewInput {
  repoId: string;
  sourceBranch: string;
  sourceSha: string;
  targetBranch: string;
  targetSha: string;
  provider: string;
  model: string;
  payloadText: string;
}

interface InFlight {
  repoId: string;
  controller: AbortController;
}

/**
 * Owns every review child process. The host holds these, not the webview, so a
 * run survives a webview reload and dies with the extension rather than leaking.
 */
export class ReviewRunner {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    private readonly store: ReviewStore,
    private readonly service: AIReviewService,
    private readonly onChange: (repoId: string, id: string) => void,
  ) {}

  public isRunning(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** Resolves once the entry exists — not when the review finishes. */
  public async start(input: StartReviewInput): Promise<string> {
    const id = buildReviewId(input);
    const controller = new AbortController();

    await this.store.create(input.repoId, {
      id,
      sourceBranch: input.sourceBranch,
      sourceSha: input.sourceSha,
      targetBranch: input.targetBranch,
      targetSha: input.targetSha,
      provider: input.provider,
      model: input.model || 'default',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    this.inFlight.set(id, { repoId: input.repoId, controller });
    this.onChange(input.repoId, id);

    void this.run(id, input, controller);
    return id;
  }

  public cancel(repoId: string, id: string): boolean {
    const running = this.inFlight.get(id);
    if (!running || running.repoId !== repoId) return false;
    running.controller.abort();
    return true;
  }

  public cancelAll(): void {
    for (const running of this.inFlight.values()) {
      running.controller.abort();
    }
  }

  private async run(id: string, input: StartReviewInput, controller: AbortController): Promise<void> {
    // Chunks are written straight through; the store appends, so an open editor
    // tab sees the review grow.
    const writes: Promise<void>[] = [];
    let writeError: string | undefined;
    const onChunk = (text: string) => {
      // A failed write (disk full, permissions) must not abort the run, but it
      // must not vanish either — the first failure is captured and the entry is
      // finished as `failed`, not silently reported `done`.
      writes.push(this.store.appendBody(input.repoId, id, text).catch((err: unknown) => {
        writeError ??= err instanceof Error ? err.message : String(err);
      }));
    };

    try {
      await this.service.review({
        diff: '',
        payloadText: input.payloadText,
        provider: input.provider,
        model: input.model,
        onChunk,
        signal: controller.signal,
      });
      await Promise.all(writes);
      // A store write failure must not be reported as `done` — a review whose
      // text never reached disk is a lie. Surface it as `failed` instead of
      // swallowing it.
      await this.store.finish(input.repoId, id, {
        status: writeError ? 'failed' : 'done',
        finishedAt: new Date().toISOString(),
        error: writeError,
      });
    } catch (err) {
      await Promise.all(writes);
      if (err instanceof ReviewCancelledError) {
        // The partial body stays on disk: half a review is often still useful.
        await this.store.finish(input.repoId, id, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await this.store.appendBody(input.repoId, id, `\n\n---\n\n**Review failed:** ${message}\n`).catch(() => {});
        await this.store.finish(input.repoId, id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: message,
        });
      }
    } finally {
      this.inFlight.delete(id);
      this.onChange(input.repoId, id);
    }
  }
}
