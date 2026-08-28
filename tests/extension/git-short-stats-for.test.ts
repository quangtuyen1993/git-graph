import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';

function serviceWith(exec: (args: string[]) => Promise<string>) {
  const service = new GitService('/repo');
  const spy = vi.fn(exec);
  // GitCLI is private; the tests replace it through the same seam the
  // existing suites use — a direct property override on the instance.
  (service as unknown as { cli: { exec: typeof spy } }).cli = { exec: spy };
  return { service, spy };
}

const A = 'aa'.repeat(20);
const B = 'bb'.repeat(20);

describe('GitService.shortStatsFor', () => {
  it('asks git for exactly the hashes it was given, in order', async () => {
    // The regression this method exists to prevent: the old getShortStats
    // passed no revisions at all — `log --shortstat --all --max-count=500`
    // walked HEAD (or every ref), so with a branch filter active it returned
    // stats for commits nobody was looking at. Absolute hashes plus --no-walk
    // cannot drift from the rows on screen.
    const { service, spy } = serviceWith(async () => '');
    await service.shortStatsFor([A, B]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual([
      'log', '--no-walk', '--shortstat', '--format=%H', A, B,
    ]);
  });

  it('returns an empty map for no hashes without touching git', async () => {
    const { service, spy } = serviceWith(async () => '');
    expect(await service.shortStatsFor([])).toEqual(new Map());
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses a full shortstat line', async () => {
    const { service } = serviceWith(async () => (
      `${A}\n 3 files changed, 10 insertions(+), 5 deletions(-)\n`
    ));
    expect(await service.shortStatsFor([A])).toEqual(new Map([
      [A, { filesChanged: 3, additions: 10, deletions: 5 }],
    ]));
  });

  it('defaults an omitted insertions or deletions clause to zero', async () => {
    const { service } = serviceWith(async () => [
      A,
      ' 1 file changed, 4 insertions(+)',
      B,
      ' 2 files changed, 7 deletions(-)',
      '',
    ].join('\n'));

    expect(await service.shortStatsFor([A, B])).toEqual(new Map([
      [A, { filesChanged: 1, additions: 4, deletions: 0 }],
      [B, { filesChanged: 2, additions: 0, deletions: 7 }],
    ]));
  });

  it('parses a SHA-256 repository, whose %H is 64 hex not 40', async () => {
    // A hash-line match hard-coded to SHA-1's 40 characters never fires here,
    // so no hash line is recognised, no stat line is ever attached, and the map
    // comes back empty — and a caller that caches misses negatively would keep
    // that answer for the rest of the session.
    const wide = 'ab'.repeat(32);
    const { service } = serviceWith(async () => (
      `${wide}\n 5 files changed, 6 insertions(+), 7 deletions(-)\n`
    ));

    expect(await service.shortStatsFor([wide])).toEqual(new Map([
      [wide, { filesChanged: 5, additions: 6, deletions: 7 }],
    ]));
  });

  it('keys on the hash git printed, not on argv position', async () => {
    // --no-walk defaults to --no-walk=sorted, so git may emit the commits in
    // an order other than the one they were asked for.
    const { service } = serviceWith(async () => [
      B,
      ' 2 files changed, 2 insertions(+)',
      A,
      ' 1 file changed, 1 deletion(-)',
      '',
    ].join('\n'));

    expect(await service.shortStatsFor([A, B])).toEqual(new Map([
      [B, { filesChanged: 2, additions: 2, deletions: 0 }],
      [A, { filesChanged: 1, additions: 0, deletions: 1 }],
    ]));
  });

  /*
   * The three states `log --no-walk --shortstat --format=%H` can put a hash in.
   * They are asserted separately because conflating any two of them has already
   * cost this feature once: zeroing state 3 would dim rows on a git failure,
   * and dropping state 2 left an empty commit indistinguishable from a hash git
   * never answered for, which is what stopped the dim rule ever firing.
   */
  it('reports a hash git listed with a stat line as the numbers it printed', async () => {
    const { service } = serviceWith(async () => `${A}\n 2 files changed, 1 insertion(+), 1 deletion(-)\n`);

    expect(await service.shortStatsFor([A])).toEqual(new Map([
      [A, { filesChanged: 2, additions: 1, deletions: 1 }],
    ]));
  });

  it('reports a hash git listed without a stat line as nothing changed', async () => {
    // git lists an empty commit and a merge, and prints no stat line under
    // either. That is an answer — "nothing changed" — not a silence.
    const { service } = serviceWith(async () => (
      `${A}\n${B}\n 2 files changed, 1 insertion(+), 1 deletion(-)\n`
    ));

    const stats = await service.shortStatsFor([A, B]);
    expect(stats.get(A)).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
    expect(stats.get(B)).toEqual({ filesChanged: 2, additions: 1, deletions: 1 });
  });

  it('reports a hash git listed last without a stat line as nothing changed', async () => {
    // The trailing commit has no following hash line to flush it, so it needs
    // the end-of-output flush rather than the one on the next hash line.
    const { service } = serviceWith(async () => (
      `${A}\n 2 files changed, 1 insertion(+), 1 deletion(-)\n${B}\n`
    ));

    const stats = await service.shortStatsFor([A, B]);
    expect(stats.get(B)).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
  });

  it('leaves a hash git never listed out of the map entirely', async () => {
    // An unresolvable or garbage-collected revision. This is the state the
    // error contract rests on: absent becomes `null` upstream, and `null`
    // never dims — so a git failure cannot fade the whole screen.
    const { service } = serviceWith(async () => `${B}\n 1 file changed, 1 insertion(+)\n`);

    const stats = await service.shortStatsFor([A, B]);
    expect(stats.has(A)).toBe(false);
    expect(stats.get(B)).toEqual({ filesChanged: 1, additions: 1, deletions: 0 });
  });
});
