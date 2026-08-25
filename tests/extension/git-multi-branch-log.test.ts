import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';

function serviceWith(exec: (args: string[]) => Promise<string>) {
  const service = new GitService('/repo');
  const spy = vi.fn(exec);
  (service as unknown as { cli: { exec: typeof spy } }).cli = { exec: spy };
  return { service, spy };
}

describe('snapshotLogOptions with multiple branches', () => {
  it('resolves every branch to a revision and dedupes', async () => {
    const { service } = serviceWith(async (args) => {
      const ref = args[2];
      if (ref === 'develop') return `${'a'.repeat(40)}\n`;
      if (ref === 'origin/develop') return `${'a'.repeat(40)}\n`; // same commit
      return `${'b'.repeat(40)}\n`;
    });

    const snapshot = await service.snapshotLogOptions({
      branches: ['develop', 'origin/develop', 'feature/x'],
    });

    expect(snapshot.revisions).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });

  it('skips branches that no longer resolve instead of failing the build', async () => {
    const { service } = serviceWith(async (args) => {
      if (args[2] === 'gone') throw new Error('unknown revision');
      return `${'c'.repeat(40)}\n`;
    });

    const snapshot = await service.snapshotLogOptions({ branches: ['gone', 'alive'] });

    expect(snapshot.revisions).toEqual(['c'.repeat(40)]);
  });

  it('still honours the single-branch form', async () => {
    const { service } = serviceWith(async () => `${'d'.repeat(40)}\n`);
    const snapshot = await service.snapshotLogOptions({ branch: 'develop' });
    expect(snapshot.revisions).toEqual(['d'.repeat(40)]);
  });

  it('passes every revision through to git log', async () => {
    const { service, spy } = serviceWith(async () => '');
    await service.log({ revisions: ['a'.repeat(40), 'b'.repeat(40)] });
    const args = spy.mock.calls[0][0];
    expect(args.slice(-2)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });
});
