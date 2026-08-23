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
