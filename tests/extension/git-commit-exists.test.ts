import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';

function serviceWith(exec: (args: string[]) => Promise<string>) {
  const service = new GitService('/repo');
  const spy = vi.fn(exec);
  // GitCLI is private; the tests replace it through the same seam
  // git-search-commits.test.ts uses — a direct property override on the instance.
  (service as unknown as { cli: { exec: typeof spy } }).cli = { exec: spy };
  return { service, spy };
}

describe('GitService.commitExists', () => {
  it('asks git to actually look the object up, not just echo a well-formed sha back', async () => {
    // I3 (the named trap): plain `rev-parse <sha>` succeeds for any
    // syntactically valid 40-hex string whether or not the object exists.
    // commitExists must use a real existence check instead.
    const sha = 'f'.repeat(40);
    const { service, spy } = serviceWith(async () => `${sha}\n`);

    expect(await service.commitExists(sha)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(['cat-file', '-e', `${sha}^{commit}`]);
  });

  it('reports false for a well-formed sha the repository has never fetched', async () => {
    const sha = 'f'.repeat(40);
    const { service } = serviceWith(async () => { throw new Error('fatal: Not a valid object name'); });

    expect(await service.commitExists(sha)).toBe(false);
  });
});
