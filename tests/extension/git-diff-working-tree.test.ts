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

  it('neither runs nor returns the raw diff by default', async () => {
    // The webview reads `files` and drops everything else, so a megabyte of raw
    // diff text is pure postMessage weight — and a whole git invocation.
    const service = new GitService('/repo');
    const exec = vi.fn(async (args: string[]) => {
      if (args.includes('--numstat')) return '3\t1\tsrc/app.ts\0';
      if (args.includes('--name-status')) return 'M\0src/app.ts\0';
      return 'diff --git a/src/app.ts b/src/app.ts\n';
    });
    (service as unknown as { cli: { exec: typeof exec } }).cli = { exec };

    const result = await service.diffWorkingTree('develop');

    expect(result.raw).toBe('');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.map(([args]) => args))
      .not.toContainEqual(['diff', '-M', '-C', 'develop']);
    // The shape other callers rely on is unchanged.
    expect(result.files[0].path).toBe('src/app.ts');
  });

  it('returns the raw diff when a caller asks for it', async () => {
    const service = new GitService('/repo');
    const exec = vi.fn(async (args: string[]) => {
      if (args.includes('--numstat')) return '3\t1\tsrc/app.ts\0';
      if (args.includes('--name-status')) return 'M\0src/app.ts\0';
      return 'diff --git a/src/app.ts b/src/app.ts\n';
    });
    (service as unknown as { cli: { exec: typeof exec } }).cli = { exec };

    const result = await service.diffWorkingTree('develop', { includeRaw: true });

    expect(result.raw).toContain('diff --git');
    expect(exec.mock.calls.map(([args]) => args))
      .toContainEqual(['diff', '-M', '-C', 'develop']);
  });
});
