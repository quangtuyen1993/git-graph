import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';

function serviceWith() {
  const service = new GitService('/repo');
  const exec = vi.fn(async () => '');
  (service as unknown as { cli: { exec: typeof exec } }).cli = { exec };
  return { service, exec };
}

describe('GitService.pull integration strategy', () => {
  it('rebases when asked to rebase', async () => {
    const { service, exec } = serviceWith();
    await service.pull('origin', 'develop', { rebase: true });
    expect(exec.mock.calls[0][0]).toEqual(['pull', '--rebase', 'origin', 'develop']);
  });

  it('says --no-rebase when asked not to rebase, so pull.rebase cannot override it', async () => {
    // "Pull into <current> Using Merge" passes `rebase: false`. With no flag at
    // all git honours the user's `pull.rebase=true` and rebases anyway, which
    // made the Merge and Rebase menu items do the same thing.
    const { service, exec } = serviceWith();
    await service.pull('origin', 'develop', { rebase: false });
    expect(exec.mock.calls[0][0]).toEqual(['pull', '--no-rebase', 'origin', 'develop']);
  });

  it('expresses no preference when no rebase key is given', async () => {
    // The plain Pull menu item deliberately leaves the choice to git config.
    const { service, exec } = serviceWith();
    await service.pull('origin', 'develop');
    expect(exec.mock.calls[0][0]).toEqual(['pull', 'origin', 'develop']);

    await service.pull('origin', 'develop', { ffOnly: true });
    expect(exec.mock.calls[1][0]).toEqual(['pull', '--ff-only', 'origin', 'develop']);
  });
});
