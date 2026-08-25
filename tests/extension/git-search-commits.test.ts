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

describe('GitService.searchCommits', () => {
  it('returns nothing for a blank query without touching git', async () => {
    const { service, spy } = serviceWith(async () => '');
    expect(await service.searchCommits('   ')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('verifies a hash-shaped query as a commit before grepping', async () => {
    const full = 'a'.repeat(40);
    const { service, spy } = serviceWith(async () => `${full}\n`);
    expect(await service.searchCommits('a1b2c3d')).toEqual([full]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(['rev-parse', '--verify', 'a1b2c3d^{commit}']);
  });

  it('falls back to a case-insensitive message grep when the hash does not resolve', async () => {
    const calls: string[][] = [];
    const { service } = serviceWith(async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') throw new Error('unknown revision');
      return `${'b'.repeat(40)}\n${'c'.repeat(40)}\n`;
    });

    expect(await service.searchCommits('deadbeef')).toEqual(['b'.repeat(40), 'c'.repeat(40)]);
    expect(calls[1]).toEqual([
      'log', '--grep=deadbeef', '-i', '--max-count=50', '--format=%H', '--all',
    ]);
  });

  it('greps directly for text queries and drops blank lines', async () => {
    const { service, spy } = serviceWith(async () => `${'d'.repeat(40)}\n\n`);
    expect(await service.searchCommits('  fix login  ')).toEqual(['d'.repeat(40)]);
    expect(spy.mock.calls[0][0]).toEqual([
      'log', '--grep=fix login', '-i', '--max-count=50', '--format=%H', '--all',
    ]);
  });
});
