import { describe, expect, it, vi } from 'vitest';
import { BRANCH_FILTER_UNRESOLVED, GitService } from '../../src/extension/services/git.service';

function serviceWith(exec: (args: string[]) => Promise<string>) {
  const service = new GitService('/repo');
  const spy = vi.fn(exec);
  (service as unknown as { cli: { exec: typeof spy } }).cli = { exec: spy };
  return { service, spy };
}

/**
 * argv is what pins git behaviour, so every stub answers per-ref and rejects
 * anything it was not asked about. A test that reaches the wrong arm of
 * `snapshotLogOptions` then fails instead of quietly passing on a fallback.
 */
function refStub(hashes: Record<string, string>) {
  return async (args: string[]): Promise<string> => {
    const hash = hashes[args[2]];
    if (!hash) throw new Error(`unknown revision: ${args.join(' ')}`);
    return `${hash}\n`;
  };
}

function argvOf(spy: { mock: { calls: unknown[][] } }): string[][] {
  return spy.mock.calls.map((call) => call[0] as string[]);
}

describe('snapshotLogOptions with multiple branches', () => {
  it('resolves every branch to a revision and dedupes', async () => {
    const { service, spy } = serviceWith(refStub({
      develop: 'a'.repeat(40),
      'origin/develop': 'a'.repeat(40), // same commit
      'feature/x': 'b'.repeat(40),
    }));

    const snapshot = await service.snapshotLogOptions({
      branches: ['develop', 'origin/develop', 'feature/x'],
    });

    expect(argvOf(spy)).toEqual([
      ['rev-parse', '--verify', 'develop'],
      ['rev-parse', '--verify', 'origin/develop'],
      ['rev-parse', '--verify', 'feature/x'],
    ]);
    expect(snapshot.revisions).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });

  it('skips branches that no longer resolve instead of failing the build', async () => {
    // Only `alive` is answered — `gone` rejects, as a deleted ref would.
    const { service, spy } = serviceWith(refStub({ alive: 'c'.repeat(40) }));

    const snapshot = await service.snapshotLogOptions({ branches: ['gone', 'alive'] });

    expect(argvOf(spy)).toEqual([
      ['rev-parse', '--verify', 'gone'],
      ['rev-parse', '--verify', 'alive'],
    ]);
    expect(snapshot.revisions).toEqual(['c'.repeat(40)]);
  });

  it('fails loudly when no requested branch resolves at all', async () => {
    // Skip-on-failure is for a partially stale list. When the whole filter is
    // dead, an empty `revisions` would make `log()` return [] and blank the
    // graph with no error — indistinguishable from an empty branch.
    const { service, spy } = serviceWith(refStub({}));

    await expect(service.snapshotLogOptions({ branches: ['gone', 'also-gone'] }))
      .rejects.toMatchObject({
        code: BRANCH_FILTER_UNRESOLVED,
        branches: ['gone', 'also-gone'],
      });
    expect(argvOf(spy)).toEqual([
      ['rev-parse', '--verify', 'gone'],
      ['rev-parse', '--verify', 'also-gone'],
    ]);
  });

  it('fails loudly when the single requested branch is gone', async () => {
    // Pre-task behaviour: a deleted `branch` threw. It must not silently
    // degrade to an empty graph now that the path shares skip-on-failure.
    const { service, spy } = serviceWith(refStub({}));

    await expect(service.snapshotLogOptions({ branch: 'gone' }))
      .rejects.toMatchObject({ code: BRANCH_FILTER_UNRESOLVED, branches: ['gone'] });
    expect(argvOf(spy)).toEqual([['rev-parse', '--verify', 'gone']]);
  });

  it('still honours the single-branch form', async () => {
    // The stub answers `develop` only, so falling through to the HEAD arm
    // rejects rather than passing on a catch-all hash.
    const { service, spy } = serviceWith(refStub({ develop: 'd'.repeat(40) }));

    const snapshot = await service.snapshotLogOptions({ branch: 'develop' });

    expect(argvOf(spy)).toEqual([['rev-parse', '--verify', 'develop']]);
    expect(snapshot.revisions).toEqual(['d'.repeat(40)]);
  });

  it('prefers branches over branch when both are set', async () => {
    const { service, spy } = serviceWith(refStub({
      'from-branches': 'e'.repeat(40),
      'from-branch': 'f'.repeat(40),
    }));

    const snapshot = await service.snapshotLogOptions({
      branches: ['from-branches'],
      branch: 'from-branch',
    });

    expect(argvOf(spy)).toEqual([['rev-parse', '--verify', 'from-branches']]);
    expect(snapshot.revisions).toEqual(['e'.repeat(40)]);
  });

  it('falls back to branch when branches is empty', async () => {
    const { service, spy } = serviceWith(refStub({ 'from-branch': 'f'.repeat(40) }));

    const snapshot = await service.snapshotLogOptions({
      branches: [],
      branch: 'from-branch',
    });

    expect(argvOf(spy)).toEqual([['rev-parse', '--verify', 'from-branch']]);
    expect(snapshot.revisions).toEqual(['f'.repeat(40)]);
  });

  it('passes every revision through to git log', async () => {
    const { service, spy } = serviceWith(async () => '');
    await service.log({ revisions: ['a'.repeat(40), 'b'.repeat(40)] });
    const args = spy.mock.calls[0][0];
    expect(args.slice(-2)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });
});
