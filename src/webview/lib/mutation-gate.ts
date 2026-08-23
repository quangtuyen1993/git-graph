export class MutationGate {
  public activeLabel: string | null = null;

  updateLabel(label: string): void {
    if (!this.activeLabel) {
      throw new Error('No Git mutation is in progress');
    }
    this.activeLabel = label;
  }

  async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeLabel) {
      throw new Error('A Git mutation is already in progress');
    }

    this.activeLabel = label;
    try {
      return await operation();
    } finally {
      this.activeLabel = null;
    }
  }
}

export async function runMutationWithProgress<T>(
  gate: MutationGate,
  label: string,
  operation: () => Promise<T>,
  setProgress: (label: string | null) => void,
): Promise<T> {
  const mutation = gate.run(label, operation);
  setProgress(gate.activeLabel);
  try {
    return await mutation;
  } finally {
    setProgress(gate.activeLabel);
  }
}
