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

  it('omits a hash git printed no stat line for rather than zeroing it', async () => {
    // `log --no-walk --shortstat` prints nothing under a merge commit.
    // Reporting `0 files changed` would be a lie the caller cannot tell
    // apart from a genuinely empty commit.
    const { service } = serviceWith(async () => (
      `${A}\n${B}\n 2 files changed, 1 insertion(+), 1 deletion(-)\n`
    ));

    const stats = await service.shortStatsFor([A, B]);
    expect(stats.has(A)).toBe(false);
    expect(stats.get(B)).toEqual({ filesChanged: 2, additions: 1, deletions: 1 });
  });
});
