import { describe, expect, it } from 'vitest';
import { transformRebaseTodo } from '../../src/extension/utils/rebase-todo';

const todo = [
  'pick bbbbbbb B',
  'pick ccccccc C',
  'pick ddddddd D',
  '',
  '# Rebase aaaaaaa..ddddddd onto aaaaaaa',
].join('\n');

describe('transformRebaseTodo', () => {
  it('rewords one commit and preserves descendants', () => {
    expect(transformRebaseTodo(todo, { kind: 'reword', hash: 'bbbbbbbbbbbb' }))
      .toContain('reword bbbbbbb B\npick ccccccc C\npick ddddddd D');
  });

  it('squashes selected commits and preserves later commits', () => {
    expect(transformRebaseTodo(todo, {
      kind: 'squash',
      hashes: ['cccccccccccc', 'bbbbbbbbbbbb'],
    })).toContain('pick bbbbbbb B\nsquash ccccccc C\npick ddddddd D');
  });

  it('rejects missing commit hashes', () => {
    expect(() => transformRebaseTodo(todo, { kind: 'reword', hash: 'eeeeeeeeeeee' }))
      .toThrow('Commit not found in rebase todo');
  });
});
