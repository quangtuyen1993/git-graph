import { AIReviewService, ReviewCancelledError } from './ai-review.service';
import { buildReviewId } from './review-key';
import type { ReviewStore, ReviewTargetKind } from './review-store';

export interface StartReviewInput {
  repoId: string;
  kind: ReviewTargetKind;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  subject?: string;
  /** Present only for kind 'pr'. */
  prId?: string;
  prNumber?: number;
  providerId?: string;
  provider: string;
  model: string;
  payloadText: string;
  /**
   * The language the payload asked for, or empty. This travels with the input
   * only because `start()` rebuilds the id below and `buildReviewId` needs it:
   * were it left out, the caller would look up one id and this would write
   * another, so no run would ever be a cache hit and two languages would
   * overwrite each other's body.
   */
  outputLanguage?: string;
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

  /**
   * Resolves once the entry exists — not when the review finishes.
   *
   * Idempotent on the review id: a second call for the same
   * (repoId, shas, provider, model) while the first is still in flight returns
   * the existing id untouched rather than starting a second run. Without this,
   * `ReviewStore.create()` would truncate the first run's partial body, reset
   * its entry to a fresh `running` row, and orphan the first run's
   * `AbortController` in `inFlight` — a caller (e.g. a cache-miss path that
   * only short-circuits on `done`) can legitimately call `start()` again for a
   * review that is already running.
   */
  public async start(input: StartReviewInput): Promise<string> {
    const id = buildReviewId({
      kind: input.kind,
      baseSha: input.baseSha,
      headSha: input.headSha,
      provider: input.provider,
      model: input.model,
      outputLanguage: input.outputLanguage,
    });
    if (this.inFlight.has(id)) return id;

    const controller = new AbortController();

    await this.store.create(input.repoId, {
      id,
      kind: input.kind,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      headRef: input.headRef,
      headSha: input.headSha,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.prId ? { prId: input.prId } : {}),
      ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      provider: input.provider,
      model: input.model || 'default',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    this.inFlight.set(id, { repoId: input.repoId, controller });
    this.onChange(input.repoId, id);

    // The background run is fire-and-forget from start()'s point of view, but
    // it must never become an unhandled rejection in a long-lived extension
    // host: run() already reports every real failure onto the entry itself,
    // so anything that still escapes here is a bug in that reporting, not a
    // review failure the user needs to see again.
    void this.run(id, input, controller).catch((err: unknown) => {
      console.error(`[ReviewRunner] run(${id}) escaped unhandled:`, err);
    });
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
    const body = new BodyStream(this.store, input.repoId, id);

    try {
      const result = await this.service.review({
        diff: '',
        payloadText: input.payloadText,
        provider: input.provider,
        model: input.model,
        onChunk: (text: string) => body.push(text),
        signal: controller.signal,
      });
      // The stream is raw CLI stdout: codex emits a whole terminal transcript,
      // deepseek a JSON envelope, and the control-character sanitisation lives
      // on the returned value too. Streaming stays the live preview; the
      // finished document is rewritten from the processed content.
      const writeError = await body.finalize(result?.content);
      // A store write failure must not be reported as `done` — a review whose
      // text never reached disk is a lie. Surface it as `failed` instead of
      // swallowing it.
      await this.finishSafely(input.repoId, id, {
        status: writeError ? 'failed' : 'done',
        finishedAt: new Date().toISOString(),
        error: writeError,
      });
    } catch (err) {
      if (err instanceof ReviewCancelledError) {
        // The partial body stays on disk: half a review is often still useful,
        // so the buffered tail must be flushed before the entry is finished.
        await body.drain();
        await this.finishSafely(input.repoId, id, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        body.push(`\n\n---\n\n**Review failed:** ${message}\n`);
        await body.drain();
        await this.finishSafely(input.repoId, id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: message,
        });
      }
    } finally {
      this.inFlight.delete(id);
      // onChange is caller-supplied (a tree view refresh, typically) — its
      // failure must not leave inFlight cleanup half-done or become an
      // unhandled rejection out of this fire-and-forget run.
      try {
        this.onChange(input.repoId, id);
      } catch (err) {
        console.error(`[ReviewRunner] onChange(${input.repoId}, ${id}) threw:`, err);
      }
    }
  }

  /**
   * `store.finish()` is a real I/O write and can fail (disk full, permissions).
   * Left unguarded, that failure would escape the branch calling it — the
   * success branch would fall into `catch (err)` and treat a store failure as
   * a review failure, calling `finish()` a second time; if that one also
   * rejects, the exception would escape `run()` entirely with nothing to
   * catch it. There is nothing more useful to do with a finish failure than
   * report it — the entry may be left stale, but the run itself is over.
   */
  private async finishSafely(
    repoId: string,
    id: string,
    patch: Parameters<ReviewStore['finish']>[2],
  ): Promise<void> {
    try {
      await this.store.finish(repoId, id, patch);
    } catch (err) {
      console.error(`[ReviewRunner] finish(${repoId}, ${id}) failed:`, err);
    }
  }
}

/** Buffered writes are flushed on this cadence, per the design's ~1/second. */
export const BODY_FLUSH_INTERVAL_MS = 1000;

/**
 * One writer per body file. Chunks are accumulated and flushed on a timer
 * rather than written one syscall per chunk: that is the design's ~1/second
 * cadence, it removes the write amplification of a mkdir+open+write+close per
 * chunk, and it stops every chunk re-triggering a reload of the open editor
 * tab. Writes are chained, so what lands on disk is always in arrival order.
 */
class BodyStream {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private error: string | undefined;

  constructor(
    private readonly store: ReviewStore,
    private readonly repoId: string,
    private readonly id: string,
  ) {}

  public push(text: string): void {
    if (!text) return;
    this.buffer += text;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), BODY_FLUSH_INTERVAL_MS);
    // A pending preview flush must never hold the host (or a test runner) open.
    this.timer.unref?.();
  }

  /** Flush the buffered tail and wait for every queued write to land. */
  public async drain(): Promise<string | undefined> {
    this.flush();
    await this.chain;
    return this.error;
  }

  /**
   * Replace the streamed preview with the processed review. Anything still
   * buffered is superseded by `content` and dropped rather than appended after
   * it. A run that produced no content (shouldn't happen, but a service stub
   * or a future provider could) keeps whatever streamed.
   */
  public async finalize(content: string | undefined): Promise<string | undefined> {
    if (typeof content !== 'string') return this.drain();
    this.buffer = '';
    this.clearTimer();
    this.enqueue(() => this.store.writeBody(this.repoId, this.id, content));
    await this.chain;
    return this.error;
  }

  private flush(): void {
    this.clearTimer();
    if (!this.buffer) return;
    const chunk = this.buffer;
    this.buffer = '';
    this.enqueue(() => this.store.appendBody(this.repoId, this.id, chunk));
  }

  private enqueue(write: () => Promise<void>): void {
    // A failed write (disk full, permissions) must not abort the run, but it
    // must not vanish either — the first failure is captured so the entry is
    // finished as `failed` rather than silently reported `done`.
    this.chain = this.chain.then(write).catch((err: unknown) => {
      this.error ??= err instanceof Error ? err.message : String(err);
    });
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
