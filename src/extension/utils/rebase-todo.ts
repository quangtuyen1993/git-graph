export type RebaseTodoPlan =
  | { kind: 'reword'; hash: string }
  | { kind: 'squash'; hashes: string[] };

export function transformRebaseTodo(todo: string, plan: RebaseTodoPlan): string {
  const commitActions = new Set([
    'pick', 'reword', 'edit', 'squash', 'fixup', 'drop',
  ]);
  const lines = todo.split('\n');
  const commands = lines.flatMap((line, lineIndex) => {
    const match = line.match(/^(\w+)\s+([0-9a-f]+)(.*)$/i);
    if (!match || !commitActions.has(match[1])) return [];
    return [{
      lineIndex,
      action: match[1],
      hash: match[2],
      rest: match[3],
    }];
  });

  const requested = plan.kind === 'reword' ? [plan.hash] : plan.hashes;
  const selected = requested.map((fullHash) => {
    const matches = commands.filter((command) => fullHash.startsWith(command.hash));
    if (matches.length !== 1) {
      throw new Error(`Commit not found in rebase todo: ${fullHash}`);
    }
    return matches[0];
  });

  if (new Set(selected.map((command) => command.lineIndex)).size !== selected.length) {
    throw new Error('Duplicate commit selected for history rewrite');
  }

  const commandPositions = selected
    .map((selectedCommand) => commands.findIndex(
      (command) => command.lineIndex === selectedCommand.lineIndex,
    ))
    .sort((a, b) => a - b);

  if (plan.kind === 'squash') {
    for (let i = 1; i < commandPositions.length; i++) {
      if (commandPositions[i] !== commandPositions[i - 1] + 1) {
        throw new Error('Selected commits are not consecutive in rebase todo');
      }
    }
  }

  const selectedLineIndexes = new Set(selected.map((command) => command.lineIndex));
  const firstSquashLine = plan.kind === 'squash'
    ? Math.min(...selectedLineIndexes)
    : -1;

  return lines.map((line, lineIndex) => {
    if (!selectedLineIndexes.has(lineIndex)) return line;
    const command = commands.find((item) => item.lineIndex === lineIndex)!;
    const action = plan.kind === 'reword'
      ? 'reword'
      : lineIndex === firstSquashLine ? 'pick' : 'squash';
    return `${action} ${command.hash}${command.rest}`;
  }).join('\n');
}
