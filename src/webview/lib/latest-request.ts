export class LatestRequestGate {
  private latestToken = 0;

  public issue(): number {
    this.latestToken += 1;
    return this.latestToken;
  }

  public isLatest(token: number): boolean {
    return token === this.latestToken;
  }
}

export async function runLatestRequest<T>(
  gate: LatestRequestGate,
  request: () => Promise<T>,
  apply: (result: T) => void,
): Promise<boolean> {
  const token = gate.issue();

  try {
    const result = await request();
    if (!gate.isLatest(token)) {
      return false;
    }
    apply(result);
    return true;
  } catch (error) {
    if (!gate.isLatest(token)) {
      return false;
    }
    throw error;
  }
}

interface RowRange {
  startRow: number;
  endRow: number;
}

interface LatestWindowIntentOptions<TWindow extends RowRange> {
  currentWindow: TWindow | null;
  desiredRange: RowRange;
  request: () => Promise<TWindow>;
  apply: (window: TWindow) => void;
  setLoading: (loading: boolean) => void;
}

interface PendingWindowIntent<TWindow extends RowRange> {
  token: number;
  options: LatestWindowIntentOptions<TWindow>;
}

export class LatestWindowRequestCoordinator<TWindow extends RowRange> {
  private pendingIntent: PendingWindowIntent<TWindow> | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly gate = new LatestRequestGate()) {}

  public handle(options: LatestWindowIntentOptions<TWindow>): Promise<void> {
    const token = this.gate.issue();
    const { currentWindow, desiredRange, setLoading } = options;
    const currentWindowCoversIntent = currentWindow !== null
      && desiredRange.startRow >= currentWindow.startRow
      && desiredRange.endRow <= currentWindow.endRow;

    if (currentWindowCoversIntent) {
      this.pendingIntent = null;
      setLoading(false);
      return Promise.resolve();
    }

    this.pendingIntent = { token, options };
    setLoading(true);
    if (!this.drainPromise) {
      this.drainPromise = this.drain();
    }
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pendingIntent) {
        const intent = this.pendingIntent;
        this.pendingIntent = null;
        if (!this.gate.isLatest(intent.token)) continue;

        const { request, apply, setLoading } = intent.options;
        try {
          const requestedWindow = await request();
          if (this.gate.isLatest(intent.token)) {
            apply(requestedWindow);
          }
        } catch (error) {
          if (this.gate.isLatest(intent.token)) {
            throw error;
          }
        } finally {
          if (this.gate.isLatest(intent.token) && !this.pendingIntent) {
            setLoading(false);
          }
        }
      }
    } finally {
      this.drainPromise = null;
    }
  }
}
