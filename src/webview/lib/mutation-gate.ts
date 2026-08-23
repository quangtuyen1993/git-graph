export class MutationGate {
  public activeLabel: string | null = null;

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
