import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  buildReviewPayload,
  splitDiffByFile,
  REVIEW_INSTRUCTIONS,
  type ReviewFileSummary,
} from '../../src/extension/services/review-payload';

function fileDiff(path: string, bodyLines = 4): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `+line ${i} of ${path}`).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,0 +1,4 @@',
    body,
  ].join('\n');
}

const summary = (path: string, over: Partial<ReviewFileSummary> = {}): ReviewFileSummary => ({
  path, oldPath: null, status: 'modified', additions: 4, deletions: 0, binary: false, ...over,
});

describe('splitDiffByFile', () => {
  it('splits on file boundaries and keeps each file whole', () => {
    const diff = [fileDiff('src/a.ts'), fileDiff('src/b.ts')].join('\n');
    const chunks = splitDiffByFile(diff);

    expect(chunks.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('diff --git ')).toBe(true);
      expect(chunk.text).toContain('@@');
    }
  });

  it('returns nothing for an empty diff', () => {
    expect(splitDiffByFile('')).toEqual([]);
    expect(splitDiffByFile('   \n')).toEqual([]);
  });

  it('handles paths that git had to quote', () => {
    const diff = 'diff --git "a/tệp tiếng việt.txt" "b/tệp tiếng việt.txt"\n@@ -0,0 +1 @@\n+x';
    expect(splitDiffByFile(diff)[0].path).toBe('tệp tiếng việt.txt');
  });

  it('reassembles to the original diff without losing lines', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const diff = files.map((f) => fileDiff(f)).join('\n');
    expect(splitDiffByFile(diff).map((c) => c.text).join('\n')).toBe(diff);
  });
});

describe('buildReviewPayload', () => {
  const base = { baseBranch: 'main', headBranch: 'feature' };

  it('sends every file when no budget is set', () => {
    // Default behaviour: the reviewer must see the real change, untrimmed.
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const diff = paths.map((p) => fileDiff(p, 200)).join('\n');

    for (const budget of [undefined, 0]) {
      const payload = buildReviewPayload({
        ...base, diff, files: paths.map((p) => summary(p)), budget,
      });
      expect(payload.truncated, `budget=${budget}`).toBe(false);
      expect(payload.omittedFiles).toEqual([]);
      expect(payload.includedFiles).toBe(paths.length);
      for (const p of paths) expect(payload.text).toContain(`+line 199 of ${p}`);
    }
  });

  it('never cuts a file in half when an explicit budget is exceeded', () => {
    const diff = [fileDiff('src/a.ts'), fileDiff('src/b.ts'), fileDiff('src/c.ts')].join('\n');
    const oneFile = splitDiffByFile(diff)[0].text.length;

    const payload = buildReviewPayload({
      ...base,
      diff,
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p) => summary(p)),
      budget: oneFile + 5, // room for one file only
    });

    expect(payload.truncated).toBe(true);
    expect(payload.includedFiles).toBe(1);
    expect(payload.omittedFiles).toEqual(['src/b.ts', 'src/c.ts']);

    // The included file must appear in full, and no partial hunk may leak through.
    expect(payload.text).toContain('+line 3 of src/a.ts');
    expect(payload.text).not.toContain('+line 0 of src/b.ts');
  });

  it('names omitted files instead of dropping them silently', () => {
    const diff = [fileDiff('keep.ts'), fileDiff('dropped.ts')].join('\n');
    const payload = buildReviewPayload({
      ...base,
      diff,
      files: [summary('keep.ts'), summary('dropped.ts')],
      budget: splitDiffByFile(diff)[0].text.length + 5,
    });

    // Listed as omitted in the diff note...
    expect(payload.text).toContain('> - dropped.ts');
    expect(payload.text).toMatch(/1 of 2 files were omitted/);
    // ...and still present in the stat summary so the model sees the full shape.
    expect(payload.text).toContain('dropped.ts — +4 -0');
  });

  it('includes the whole change when it fits', () => {
    const diff = [fileDiff('src/a.ts'), fileDiff('src/b.ts')].join('\n');
    const payload = buildReviewPayload({
      ...base, diff, files: [summary('src/a.ts'), summary('src/b.ts')], budget: 1_000_000,
    });

    expect(payload.truncated).toBe(false);
    expect(payload.omittedFiles).toEqual([]);
    expect(payload.includedFiles).toBe(2);
    expect(payload.text).not.toContain('were omitted');
  });

  it('carries instructions, direction, commits, renames and binary markers', () => {
    const payload = buildReviewPayload({
      ...base,
      diff: fileDiff('src/a.ts'),
      files: [
        summary('src/new.ts', { status: 'renamed', oldPath: 'src/old.ts' }),
        summary('logo.png', { status: 'added', binary: true, additions: 0, deletions: 0 }),
      ],
      commits: ['feat: add thing', 'fix: guard null'],
      budget: 100_000,
    });

    expect(payload.text).toContain(REVIEW_INSTRUCTIONS);
    expect(payload.text).toContain('git diff main...feature');
    expect(payload.text).toContain('- feat: add thing');
    expect(payload.text).toContain('(renamed from src/old.ts)');
    expect(payload.text).toContain('logo.png — binary');
    expect(payload.text).toContain('Critical');
  });

  it('includes a single oversized file rather than reviewing nothing', () => {
    const huge = fileDiff('src/huge.ts', 500);
    const payload = buildReviewPayload({
      ...base, diff: huge, files: [summary('src/huge.ts')], budget: 10,
    });

    expect(payload.includedFiles).toBe(1);
    expect(payload.omittedFiles).toEqual([]);
    expect(payload.text).toContain('+line 499 of src/huge.ts');
  });

  it('states plainly when there are no textual differences', () => {
    const payload = buildReviewPayload({ ...base, diff: '', files: [], budget: 100 });
    expect(payload.text).toContain('(no textual differences)');
    expect(payload.truncated).toBe(false);
  });

  it('keeps files whole on a real repository diff that exceeds the budget', () => {
    // Guards the original bug against real git output, not just synthetic diffs.
    const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const range = 'HEAD~8...HEAD';
    const diff = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', range], {
      encoding: 'utf8', cwd: repo, maxBuffer: 64 * 1024 * 1024,
    });
    const chunks = splitDiffByFile(diff);
    expect(chunks.length).toBeGreaterThan(1);

    const payload = buildReviewPayload({
      ...base, diff, budget: Math.floor(diff.length / 2),
    });

    expect(payload.truncated).toBe(true);
    // Every included byte must belong to a complete file chunk.
    const includedText = payload.text.slice(payload.text.indexOf('### Diff'));
    for (const chunk of chunks) {
      const present = includedText.includes(chunk.text);
      const named = payload.omittedFiles.includes(chunk.path);
      expect(present || named, `${chunk.path} must be fully included or listed as omitted`).toBe(true);
    }
  });
});
