/**
 * `invalidate()` bumps the build generation before the event is sent, so every
 * in-flight build is expected to lose that race. The extension tags those
 * failures with a stable code; matching on the code rather than the message
 * keeps the check from silently breaking when the wording changes.
 */
export function isSupersededError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { kind?: unknown }).kind === 'GRAPH_BUILD_SUPERSEDED';
}

export interface RefreshScheduler {
  schedule(): void;
  cancel(): void;
}

export function createRefreshScheduler(options: {
  run: () => Promise<void>;
  delayMs: number;
  onError: (error: unknown) => void;
}): RefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    // A watcher burst (checkout writes HEAD, refs and index in quick
    // succession) collapses into a single refresh; the existing
    // LatestRequestGate still handles genuine overlap.
    schedule(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        options.run().catch(options.onError);
      }, options.delayMs);
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
