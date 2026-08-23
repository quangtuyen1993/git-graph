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

interface RowRange {
  startRow: number;
  endRow: number;
}

interface LatestWindowIntentOptions<TWindow extends RowRange> {
  gate: LatestRequestGate;
  currentWindow: TWindow | null;
  desiredRange: RowRange;
  request: () => Promise<TWindow>;
  apply: (window: TWindow) => void;
  setLoading: (loading: boolean) => void;
}

export async function handleLatestWindowIntent<TWindow extends RowRange>({
  gate,
  currentWindow,
  desiredRange,
  request,
  apply,
  setLoading,
}: LatestWindowIntentOptions<TWindow>): Promise<void> {
  const token = gate.issue();
  const currentWindowCoversIntent = currentWindow !== null
    && desiredRange.startRow >= currentWindow.startRow
    && desiredRange.endRow <= currentWindow.endRow;

  if (currentWindowCoversIntent) {
    setLoading(false);
    return;
  }

  setLoading(true);
  try {
    const requestedWindow = await request();
    if (gate.isLatest(token)) {
      apply(requestedWindow);
    }
  } finally {
    if (gate.isLatest(token)) {
      setLoading(false);
    }
  }
}
