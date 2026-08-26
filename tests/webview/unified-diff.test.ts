import { describe, expect, it } from 'vitest';
import { extractFileDiffContent, parseUnifiedDiff } from '../../src/webview/lib/unified-diff';

describe('parseUnifiedDiff', () => {
  it('returns an empty list for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('counts added and removed lines for a modified file', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index 1111111..2222222 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,3 +1,4 @@',
      ' line one',
      '-old line',
      '+new line',
      '+another new line',
      ' line three',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({
      path: 'src/auth.ts', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false,
    });
  });

  it('marks a new file as added', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '+export const y = 2;',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({ path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 });
  });

  it('marks a removed file as deleted', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export const z = 1;',
      '-export const w = 2;',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({ path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 2 });
  });

  it('keeps the old path for a rename with content changes', () => {
    const diff = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 88%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index 5555555..6666666 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1,2 +1,2 @@',
      '-export const a = 1;',
      '+export const a = 2;',
      ' export const b = 2;',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({
      path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed', additions: 1, deletions: 1,
    });
  });

  it('handles a pure rename with no content change and no hunks', () => {
    const diff = [
      'diff --git a/src/pure-old.ts b/src/pure-new.ts',
      'similarity index 100%',
      'rename from src/pure-old.ts',
      'rename to src/pure-new.ts',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({
      path: 'src/pure-new.ts', oldPath: 'src/pure-old.ts', status: 'renamed', additions: 0, deletions: 0,
    });
  });

  it('flags a binary file without counting the "differ" line as content', () => {
    const diff = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 7777777..8888888 100644',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({
      path: 'assets/logo.png', status: 'modified', binary: true, additions: 0, deletions: 0,
    });
  });

  it('flags a new binary file as added', () => {
    const diff = [
      'diff --git a/assets/new.png b/assets/new.png',
      'new file mode 100644',
      'index 0000000..9999999',
      'Binary files /dev/null and b/assets/new.png differ',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({ path: 'assets/new.png', status: 'added', binary: true });
  });

  // A "no newline at end of file" marker sits right after the content line it
  // describes and must not itself be miscounted as an added or removed line.
  it('does not count a "no newline at end of file" marker as content', () => {
    const diff = [
      'diff --git a/README.md b/README.md',
      'index aaaaaaa..bbbbbbb 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-old text',
      '\\ No newline at end of file',
      '+new text',
      '\\ No newline at end of file',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('parses every file out of a multi-file diff', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+aa',
      'diff --git a/b.ts b/b.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/b.ts',
      '@@ -0,0 +1 @@',
      '+b',
    ].join('\n');

    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(files[1].status).toBe('added');
  });
});

describe('extractFileDiffContent', () => {
  it('reconstructs both sides of a modified file from its hunk', () => {
    const diff = [
      'diff --git a/src/widget.ts b/src/widget.ts',
      'index 1111111..2222222 100644',
      '--- a/src/widget.ts',
      '+++ b/src/widget.ts',
      '@@ -1,3 +1,3 @@',
      ' context line',
      '-old line',
      '+new line',
      ' trailing context',
    ].join('\n');

    const result = extractFileDiffContent(diff, 'src/widget.ts');

    expect(result).toEqual({
      oldContent: 'context line\nold line\ntrailing context',
      newContent: 'context line\nnew line\ntrailing context',
    });
  });

  it('leaves the old side empty for an added file', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '+export const y = 2;',
    ].join('\n');

    const result = extractFileDiffContent(diff, 'src/new.ts');

    expect(result).toEqual({ oldContent: '', newContent: 'export const x = 1;\nexport const y = 2;' });
  });

  it('leaves the new side empty for a deleted file', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-gone one',
      '-gone two',
    ].join('\n');

    const result = extractFileDiffContent(diff, 'src/old.ts');

    expect(result).toEqual({ oldContent: 'gone one\ngone two', newContent: '' });
  });

  it('picks the right file out of a multi-file diff', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+aa',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-b',
      '+bb',
    ].join('\n');

    expect(extractFileDiffContent(diff, 'b.ts')).toEqual({ oldContent: 'b', newContent: 'bb' });
  });

  it('joins two non-adjacent hunks with a blank separator on both sides', () => {
    const diff = [
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -1,2 +1,2 @@',
      ' top',
      '-first old',
      '+first new',
      '@@ -50,2 +50,2 @@',
      ' bottom',
      '-second old',
      '+second new',
    ].join('\n');

    const result = extractFileDiffContent(diff, 'big.ts');

    expect(result?.oldContent).toBe('top\nfirst old\n\nbottom\nsecond old');
    expect(result?.newContent).toBe('top\nfirst new\n\nbottom\nsecond new');
  });

  it('ignores a "no newline at end of file" marker', () => {
    const diff = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-old text',
      '\\ No newline at end of file',
      '+new text',
      '\\ No newline at end of file',
    ].join('\n');

    expect(extractFileDiffContent(diff, 'README.md')).toEqual({ oldContent: 'old text', newContent: 'new text' });
  });

  it('returns null when the path is not in the diff', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+aa',
    ].join('\n');

    expect(extractFileDiffContent(diff, 'missing.ts')).toBeNull();
  });

  it('returns null for empty diff text', () => {
    expect(extractFileDiffContent('', 'a.ts')).toBeNull();
  });
});
