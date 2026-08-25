import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';

describe('GitService.diffWorkingTree', () => {
  it('diffs the ref against the working tree with no range operator', async () => {
    const service = new GitService('/repo');
    const calls: string[][] = [];
    const exec = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args.includes('--numstat')) return '3\t1\tsrc/app.ts\0';
      if (args.includes('--name-status')) return 'M\0src/app.ts\0';
      return 'diff --git a/src/app.ts b/src/app.ts\n';
    });
    (service as unknown as { cli: { exec: typeof exec } }).cli = { exec };

    const result = await service.diffWorkingTree('develop');

    // No '...' anywhere: three-dot against the working tree is not a valid revision.
    for (const args of calls) {
      expect(args.some((arg) => arg.includes('...'))).toBe(false);
      expect(args).toContain('develop');
    }
    expect(calls[0]).toEqual(['diff', '--numstat', '-z', '-M', '-C', 'develop']);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/app.ts');
  });
});
