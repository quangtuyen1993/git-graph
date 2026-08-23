import { describe, expect, it } from 'vitest';
import { parseFileChanges } from '../../src/extension/utils/git-parser';

describe('parseFileChanges', () => {
  const cases = [
    {
      name: 'added files',
      numstat: '3\t0\tnew file.ts\0',
      nameStatus: 'A\0new file.ts\0',
      expected: { path: 'new file.ts', oldPath: null, status: 'added', additions: 3, deletions: 0, binary: false },
    },
    {
      name: 'modified files',
      numstat: '2\t1\tmodified.ts\0',
      nameStatus: 'M\0modified.ts\0',
      expected: { path: 'modified.ts', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false },
    },
    {
      name: 'deleted files',
      numstat: '0\t4\tdeleted.ts\0',
      nameStatus: 'D\0deleted.ts\0',
      expected: { path: 'deleted.ts', oldPath: null, status: 'deleted', additions: 0, deletions: 4, binary: false },
    },
    {
      name: 'renamed files',
      numstat: '1\t1\t\0old name.ts\0new name.ts\0',
      nameStatus: 'R100\0old name.ts\0new name.ts\0',
      expected: { path: 'new name.ts', oldPath: 'old name.ts', status: 'renamed', additions: 1, deletions: 1, binary: false },
    },
    {
      name: 'copied files',
      numstat: '5\t0\t\0source.ts\0copy.ts\0',
      nameStatus: 'C100\0source.ts\0copy.ts\0',
      expected: { path: 'copy.ts', oldPath: 'source.ts', status: 'copied', additions: 5, deletions: 0, binary: false },
    },
    {
      name: 'binary files',
      numstat: '-\t-\tassets/image.bin\0',
      nameStatus: 'M\0assets/image.bin\0',
      expected: { path: 'assets/image.bin', oldPath: null, status: 'modified', additions: 0, deletions: 0, binary: true },
    },
    {
      name: 'paths containing tabs',
      numstat: '7\t3\tdirectory/has\ta tab.ts\0',
      nameStatus: 'M\0directory/has\ta tab.ts\0',
      expected: { path: 'directory/has\ta tab.ts', oldPath: null, status: 'modified', additions: 7, deletions: 3, binary: false },
    },
    {
      name: 'non-ASCII paths',
      numstat: '1\t0\ttên-tiếng-Việt.ts\0',
      nameStatus: 'A\0tên-tiếng-Việt.ts\0',
      expected: { path: 'tên-tiếng-Việt.ts', oldPath: null, status: 'added', additions: 1, deletions: 0, binary: false },
    },
  ] as const;

  it.each(cases)('parses $name from NUL-delimited streams', ({ numstat, nameStatus, expected }) => {
    expect(parseFileChanges(numstat, nameStatus)).toEqual([expected]);
  });

  it('rejects unmatched numstat and name-status records', () => {
    expect(() => parseFileChanges('1\t0\tactual.ts\0', 'A\0different.ts\0')).toThrow(
      'Unable to reconcile file change streams',
    );
  });
});
