# Task 4 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all seven Phase 1–4 review findings without losing Git history, then enforce the fixes with automated tests, coverage thresholds, accessibility checks, and production/package verification.

**Architecture:** Extract dangerous rewrite and UI coordination behavior into focused, testable modules. Git history rewrites transform Git's complete interactive-rebase todo instead of replacing it; graph history loads in 500-commit CLI batches; UI state uses pure helpers and latest-request-wins coordination. Vitest covers core behavior and Svelte components, while an extracted Git method handler makes the host RPC contract testable without a VS Code Extension Development Host.

**Tech Stack:** TypeScript 5.4, Node.js 18+, Svelte 4, Vitest 2, V8 coverage, jsdom, Testing Library, Git CLI, esbuild, Vite.

**Spec:** `docs/superpowers/specs/2026-08-23-task4-review-fixes-design.md`

## Global Constraints

- Preserve all descendant commits when rewording or squashing older commits.
- Never execute destructive Git tests in the workspace repository; every integration test creates its own temporary repository.
- Continue to spawn Git with argument arrays; do not interpolate user data into a Git command string.
- Keep Git CLI history batches at exactly 500 commits.
- Enforce coverage thresholds of 80% statements, lines, and functions and 70% branches for the explicitly included testable modules.
- Keep VS Code lifecycle glue out of jsdom; test its Git routing through the extracted handler.
- Use VS Code theme variables for UI colors and expose operation state through `aria-live`.
- Do not include `.superpowers/**` in the VSIX.

---

## Roadmap and Agent Routing

### Model roles

| Role | Model | Effort | Strength used |
|---|---|---:|---|
| Orchestrator and final reviewer | `gpt-5.6-sol` | high | Cross-layer reasoning, destructive-operation safety, regression review |
| P0 Git rewrite implementer | `gpt-5.6-sol` | high | Interactive rebase semantics, temporary-process integration, history-preservation proofs |
| Graph/concurrency implementer | `gpt-5.6-sol` | high | Async race analysis, pagination invariants, stale-response prevention |
| Parser and host RPC implementer | `gpt-5.6-terra` | high | TypeScript data contracts, NUL-delimited parsing, service/controller refactoring |
| Svelte accessibility implementer | `gpt-5.6-terra` | high | Component behavior, keyboard navigation, ARIA, DOM tests |
| Test infrastructure/config implementer | `gpt-5.6-terra` | medium | Vitest/V8 setup, TypeScript configuration, dependency compatibility |
| Packaging and mechanical cleanup | `gpt-5.6-luna` | medium | Narrow manifest/ignore edits and deterministic command verification |

Do not route P0 Git rewrite or async-window coordination to `gpt-5.6-luna`. Their failure modes are silent history loss and nondeterministic UI corruption, so they require frontier-level reasoning and independent `gpt-5.6-sol` review.

### Dependency waves

```text
Wave 0: Baseline + test/coverage infrastructure                          [Task 1]
                         |
Wave 1: Safe rewrite core       File parser       Working-state helpers [Tasks 2, 4, 5]
             |                       |                    |
Wave 2: Host RPC + revert       Graph batching/race      UI a11y        [Tasks 3, 6, 7]
             \_______________________|____________________/
                                     |
Wave 3: Coverage closure + package + end-to-end verification             [Task 8]
```

With four concurrency slots, the primary agent remains orchestrator/reviewer and dispatches at most three implementation agents in a wave. Every task returns to the orchestrator for spec review and fresh verification before its dependents start.

### Quality gates

| Gate | Required evidence |
|---|---|
| G0 Baseline | Existing `npm run build` and `npx tsc --noEmit` exit 0; worktree state recorded |
| G1 Test harness | A deliberately failing smoke test is observed, then passes after the harness is corrected |
| G2 History safety | Temporary-repo tests prove descendants remain reachable after reword and squash |
| G3 Data correctness | Parser and working-state tests cover every status category and unusual filenames |
| G4 UI behavior | Component tests prove viewport clamping, focus movement, keyboard actions, and resize keys |
| G5 Coverage | `npm run coverage` exits 0 at 80/80/80/70 thresholds |
| G6 Release | `npm run check`, `npm run package`, `git diff --check`, and `git status --short` meet acceptance criteria |

---

### Task 1: Vitest and Coverage Gate

**Agent:** `gpt-5.6-terra`, effort `medium`.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: npm project with Svelte 4 and TypeScript.
- Produces: `npm test`, `npm run test:watch`, `npm run coverage`, and `npm run check`; jsdom setup with jest-dom matchers.

- [ ] **Step 1: Record the baseline**

Run:

```bash
git status --short
npm run build
npx tsc --noEmit --project tsconfig.json
```

Expected: build and typecheck exit 0; record any pre-existing worktree changes without modifying them.

- [ ] **Step 2: Install Node 18-compatible test dependencies**

Run:

```bash
npm install --save-dev vitest@2.1.9 @vitest/coverage-v8@2.1.9 jsdom@24.1.3 @testing-library/svelte@4.2.3 @testing-library/jest-dom@6.6.3
```

Expected: `package.json` and `package-lock.json` contain the five dev dependencies.

- [ ] **Step 3: Add scripts and the coverage configuration**

Add these scripts to `package.json`:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "coverage": "vitest run --coverage",
  "typecheck": "tsc --noEmit --project tsconfig.json",
  "check": "npm test && npm run coverage && npm run typecheck && npm run build"
}
```

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [['tests/webview/**/*.test.ts', 'jsdom']],
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: [
        'src/extension/services/git.service.ts',
        'src/extension/services/graph.service.ts',
        'src/extension/controllers/git-method-handler.ts',
        'src/extension/utils/git-parser.ts',
        'src/extension/utils/rebase-todo.ts',
        'src/webview/lib/**/*.ts',
        'src/webview/components/actions/ContextMenu.svelte',
        'src/webview/components/layout/ResizeHandle.svelte',
        'src/webview/components/sidebar/BranchSidebar.svelte'
      ],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
        branches: 70
      }
    }
  }
});
```

Create `tests/setup.ts`:

```typescript
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 4: Verify the harness observes RED**

Create `tests/smoke.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('runs TypeScript tests', () => {
    expect(1 + 1).toBe(3);
  });
});
```

Run: `npm test -- tests/smoke.test.ts`

Expected: FAIL with `expected 2 to be 3`.

- [ ] **Step 5: Make the harness GREEN**

Change the assertion to:

```typescript
expect(1 + 1).toBe(2);
```

Run: `npm test -- tests/smoke.test.ts`

Expected: one test passes.

- [ ] **Step 6: Commit the harness**

```bash
git add package.json package-lock.json vitest.config.ts tests/setup.ts tests/smoke.test.ts
git commit -m "test: add vitest coverage gate"
```

---

### Task 2: Preserve Descendants During Reword and Squash

**Agent:** `gpt-5.6-sol`, effort `high`; independent review by `gpt-5.6-sol`, effort `high`.

**Files:**
- Create: `src/extension/utils/rebase-todo.ts`
- Modify: `src/extension/services/git.service.ts:327-460`
- Test: `tests/extension/rebase-todo.test.ts`
- Test: `tests/extension/git-rewrite.integration.test.ts`
- Create: `tests/helpers/temp-git-repo.ts`

**Interfaces:**
- Consumes: full Git interactive-rebase todo text and full commit hashes.
- Produces: `transformRebaseTodo(todo, plan): string`, `GitService.isPublished(hash): Promise<boolean>`, safe `reword()` and `squash()` implementations.

- [ ] **Step 1: Write RED tests for todo transformation**

Create tests with these assertions:

```typescript
import { describe, expect, it } from 'vitest';
import { transformRebaseTodo } from '../../src/extension/utils/rebase-todo';

const todo = [
  'pick bbbbbbb B',
  'pick ccccccc C',
  'pick ddddddd D',
  '',
  '# Rebase aaaaaaa..ddddddd onto aaaaaaa'
].join('\n');

describe('transformRebaseTodo', () => {
  it('rewords one commit and preserves descendants', () => {
    expect(transformRebaseTodo(todo, { kind: 'reword', hash: 'bbbbbbbbbbbb' }))
      .toContain('reword bbbbbbb B\npick ccccccc C\npick ddddddd D');
  });

  it('squashes selected commits and preserves later commits', () => {
    expect(transformRebaseTodo(todo, {
      kind: 'squash',
      hashes: ['cccccccccccc', 'bbbbbbbbbbbb']
    })).toContain('pick bbbbbbb B\nsquash ccccccc C\npick ddddddd D');
  });

  it('rejects missing commit hashes', () => {
    expect(() => transformRebaseTodo(todo, { kind: 'reword', hash: 'eeeeeeeeeeee' }))
      .toThrow('Commit not found in rebase todo');
  });
});
```

Run: `npm test -- tests/extension/rebase-todo.test.ts`

Expected: FAIL because `rebase-todo.ts` does not exist.

- [ ] **Step 2: Implement the minimal todo transformer**

Create discriminated plan types and transform only commit command lines. Match abbreviated todo hashes with `fullHash.startsWith(todoHash)`, preserve comments/blank lines verbatim, require every requested hash to appear exactly once, and require selected squash commits to be consecutive among commit-command lines.

```typescript
export type RebaseTodoPlan =
  | { kind: 'reword'; hash: string }
  | { kind: 'squash'; hashes: string[] };

const COMMIT_ACTIONS = new Set([
  'pick', 'reword', 'edit', 'squash', 'fixup', 'drop'
]);

export function transformRebaseTodo(todo: string, plan: RebaseTodoPlan): string {
  const lines = todo.split('\n');
  const commands = lines.flatMap((line, lineIndex) => {
    const match = line.match(/^(\w+)\s+([0-9a-f]+)(.*)$/i);
    if (!match || !COMMIT_ACTIONS.has(match[1])) return [];
    return [{
      lineIndex,
      action: match[1],
      hash: match[2],
      rest: match[3]
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
      (command) => command.lineIndex === selectedCommand.lineIndex
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
```

Run: `npm test -- tests/extension/rebase-todo.test.ts`

Expected: all transformer tests pass.

- [ ] **Step 3: Write RED integration tests for descendant preservation**

`tests/helpers/temp-git-repo.ts` must create a directory with `fs.mkdtemp`, initialize Git, configure a test identity locally, create allow-empty commits, expose `execGit(args)`, and remove the directory in `afterEach` with `fs.rm(path, { recursive: true, force: true })` after validating that the path begins with `path.join(os.tmpdir(), 'git-graph-test-')`.

Add integration tests:

```typescript
it('reword preserves commits after the rewritten commit', async () => {
  const [a, b, c] = await repo.commitSeries(['A', 'B', 'C']);
  await new GitService(repo.path).reword(b, 'B changed');
  expect(await repo.subjects()).toEqual(['C', 'B changed', 'A']);
  expect(await repo.commitCount()).toBe(3);
  expect(await repo.treeOf('HEAD')).toBe(await repo.treeOf(c));
});

it('squash preserves descendants after the selected range', async () => {
  const [, b, c, d] = await repo.commitSeries(['A', 'B', 'C', 'D']);
  const service = new GitService(repo.path);
  expect(await service.canSquash([c, b])).toEqual({ ok: true });
  await service.squash([c, b], 'BC squashed');
  expect(await repo.subjects()).toEqual(['D', 'BC squashed', 'A']);
  expect(await repo.commitCount()).toBe(3);
  expect(await repo.treeOf('HEAD')).toBe(await repo.treeOf(d));
});
```

Run: `npm test -- tests/extension/git-rewrite.integration.test.ts`

Expected: both tests FAIL because the original implementations drop C or D.

- [ ] **Step 4: Implement collision-safe editor scripts**

Replace the todo-overwrite implementation with temporary Node editor scripts:

- The sequence editor reads `process.argv[2]`, reads an adjacent JSON rewrite plan, parses commit-command lines with the same action/hash rules specified in Step 2, validates exact hash selection and squash adjacency, transforms only the selected actions, and writes every line back in its original order.
- The commit-message editor writes the requested message to `process.argv[2]`.
- Build editor commands by quoting `process.execPath` and the script path separately.
- Use `fs.mkdtemp(path.join(os.tmpdir(), 'git-graph-rebase-'))` instead of `Date.now()` filenames.
- Use `rebase -i <oldest>^` for non-root ranges and `rebase -i --root` when the oldest selected commit has no parent.
- Set the rebase timeout to 120 seconds.
- Remove only the validated temporary directory in `finally`; do not auto-abort a conflicted rebase.

Run: `npm test -- tests/extension/rebase-todo.test.ts tests/extension/git-rewrite.integration.test.ts`

Expected: all rewrite tests pass and descendant counts/trees are preserved.

- [ ] **Step 5: Add published-history detection RED→GREEN**

Add a temporary remote/upstream test proving:

```typescript
expect(await service.isPublished(pushedHash)).toBe(true);
expect(await service.isPublished(localOnlyHash)).toBe(false);
```

Run the focused test and observe FAIL because `isPublished` is missing. Implement it with `merge-base --is-ancestor <hash> @{upstream}` and return false when no upstream exists. Re-run and expect PASS.

- [ ] **Step 6: Commit the safe rewrite**

```bash
git add src/extension/utils/rebase-todo.ts src/extension/services/git.service.ts tests/extension tests/helpers/temp-git-repo.ts
git commit -m "fix: preserve descendants during history rewrites"
```

---

### Task 3: Extract Git RPC Handler and Implement Revert

**Agent:** `gpt-5.6-terra`, effort `high`; review by `gpt-5.6-sol`, effort `medium`.

**Files:**
- Create: `src/extension/controllers/git-method-handler.ts`
- Modify: `src/extension/extension.ts:59-177`
- Modify: `src/extension/services/git.service.ts:83-181`
- Modify: `src/webview/App.svelte:472-557`
- Test: `tests/extension/git-method-handler.test.ts`
- Test: `tests/extension/git-revert.integration.test.ts`

**Interfaces:**
- Consumes: `GitService`, method string, unknown params.
- Produces: `handleGitMethod(service, method, params): Promise<unknown>`, `GitService.revert(hash)`, `git.isPublished`, and a complete route for every Git method sent by the webview.

- [ ] **Step 1: Write a failing route contract test**

Extract all literal `bridge.send('git.*')` names from `src/webview/App.svelte` in the test and invoke `handleGitMethod` with a typed fake service. Assert no method reaches `Unknown method`; include `git.revert` and `git.isPublished` explicitly.

Run: `npm test -- tests/extension/git-method-handler.test.ts`

Expected: FAIL because the handler module and revert route do not exist.

- [ ] **Step 2: Extract the existing switch without behavior changes**

Create:

```typescript
export async function handleGitMethod(
  gitService: GitService,
  method: string,
  params: unknown
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'git.revert':
      await gitService.revert(p.hash as string);
      return { success: true };
    case 'git.isPublished':
      return { published: await gitService.isPublished(p.hash as string) };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
```

Before adding the two new cases shown above, move the complete existing `git.*` switch from `src/extension/extension.ts:67-175` into this function verbatim. The moved cases retain their current parameter casts and return values; only the final default and the two new cases change.

Replace the large `extension.ts` switch with:

```typescript
router.register('git', async (method, params) => {
  if (!gitService) throw new Error('No git repository found in workspace');
  return handleGitMethod(gitService, method, params);
});
```

Run the contract test. Expected: it still fails only for `git.revert` and `git.isPublished`.

- [ ] **Step 3: Write and verify a RED revert integration test**

Create a file-changing commit in the temporary repo, invoke `service.revert(hash)`, then assert the commit count increases by one, HEAD subject starts with `Revert`, and the tree equals the parent tree.

Run: `npm test -- tests/extension/git-revert.integration.test.ts`

Expected: FAIL because `GitService.revert` is missing.

- [ ] **Step 4: Implement revert and published-history routes**

Add:

```typescript
public async revert(hash: string): Promise<void> {
  await this.cli.exec(['revert', '--no-edit', hash]);
}
```

Add `git.revert` and `git.isPublished` cases to `handleGitMethod`. Before `reword` or `squash`, the webview requests `git.isPublished`; if true it opens a modal confirmation explaining that descendant hashes change and force-push may be required. Cancellation must return without calling the mutation.

Run: `npm test -- tests/extension/git-method-handler.test.ts tests/extension/git-revert.integration.test.ts`

Expected: all route and revert tests pass.

- [ ] **Step 5: Commit the RPC fix**

```bash
git add src/extension/controllers/git-method-handler.ts src/extension/extension.ts src/extension/services/git.service.ts src/webview/App.svelte tests/extension
git commit -m "fix: complete git revert and rewrite routes"
```

---

### Task 4: Parse File Status and Rename Data Correctly

**Agent:** `gpt-5.6-terra`, effort `high`.

**Files:**
- Modify: `src/extension/utils/git-parser.ts:258-290`
- Modify: `src/extension/services/git.service.ts:51-81`
- Modify: `src/extension/extension.ts:270-311`
- Modify: `src/webview/components/detail/CommitDetail.svelte:135-138`
- Test: `tests/extension/git-parser.test.ts`
- Test: `tests/extension/git-file-changes.integration.test.ts`

**Interfaces:**
- Consumes: NUL-delimited numstat and name-status streams.
- Produces: `parseFileChanges(numstatOutput, nameStatusOutput): FileChange[]` with correct `path`, `oldPath`, status, counts, and binary flag.

- [ ] **Step 1: Add RED parser cases**

Create table-driven cases for `A`, `M`, `D`, `R100`, `C100`, binary `-/-`, spaces, tab characters, and `tên-tiếng-Việt.ts`. Assert rename produces `{ oldPath, path, status: 'renamed' }` and copied produces `status: 'copied'`.

Run: `npm test -- tests/extension/git-parser.test.ts`

Expected: FAIL because the current parser accepts one stream and defaults statuses to modified.

- [ ] **Step 2: Implement two-stream parsing**

Parse `--name-status -z -M -C` into ordered status records. Parse `--numstat -z -M -C` into ordered statistic records, including Git's rename/copy empty-path marker followed by old and new NUL fields. Merge records by normalized `(oldPath, path)` identity and throw a descriptive error when stream entries cannot be reconciled.

Run the parser test. Expected: all cases pass.

- [ ] **Step 3: Add a RED temporary-repo integration test**

Create added, modified, deleted, renamed, copied, binary, whitespace, and non-ASCII paths in an isolated repository. Call `GitService.show(HEAD)` and assert every returned status/path/count.

Run: `npm test -- tests/extension/git-file-changes.integration.test.ts`

Expected: FAIL until GitService requests and merges both streams.

- [ ] **Step 4: Update GitService and diff opening**

For `show`, queue both:

```typescript
['diff-tree', '--numstat', '-z', '-M', '-C', '-r', '--root', hash]
['diff-tree', '--name-status', '-z', '-M', '-C', '-r', '--root', hash]
```

For `diff`, request equivalent `git diff` streams plus raw diff. Pass `oldPath` through `CommitDetail`'s `openFile` event, and use `oldPath ?? path` when reading the parent side of a rename in `ui.openDiff`.

Run parser and integration tests. Expected: all pass.

- [ ] **Step 5: Commit file-change correctness**

```bash
git add src/extension/utils/git-parser.ts src/extension/services/git.service.ts src/extension/extension.ts src/webview/components/detail/CommitDetail.svelte tests/extension
git commit -m "fix: preserve git file statuses and rename paths"
```

---

### Task 5: Working Changes and Mutation State

**Agent:** `gpt-5.6-terra`, effort `medium`.

**Files:**
- Create: `src/webview/lib/git-status.ts`
- Create: `src/webview/lib/mutation-gate.ts`
- Modify: `src/webview/App.svelte:55-181,289-682,713-884`
- Test: `tests/webview/git-status.test.ts`
- Test: `tests/webview/mutation-gate.test.ts`

**Interfaces:**
- Produces: `hasWorkingTreeChanges(status): boolean` and `MutationGate.run(label, operation): Promise<unknown>` with observable active label.

- [ ] **Step 1: Write RED working-state tests**

Assert each non-empty `staged`, `unstaged`, `untracked`, or `conflicted` collection returns true and a fully empty status returns false.

Run: `npm test -- tests/webview/git-status.test.ts`

Expected: FAIL because the helper is missing.

- [ ] **Step 2: Implement and wire the status helper**

Create a minimal structural `WorkingTreeStatus` type and return the OR of the four collection lengths. Replace the `status.files` cast in `refreshGraph` with the helper.

Run the focused test. Expected: pass.

- [ ] **Step 3: Write RED mutation-gate tests**

Assert the gate exposes `Stashing changes…` while a deferred promise is active, rejects or ignores a second mutation while busy, clears state in `finally`, and also clears after rejection.

Run: `npm test -- tests/webview/mutation-gate.test.ts`

Expected: FAIL because the gate is missing.

- [ ] **Step 4: Implement mutation state and working-row actions**

Use the gate around every Git mutation in `handleContextMenuAction`. Render an `aria-live="polite"` status element while active. Add a `working` context target with `Stash tracked changes` and `Refresh` actions; never send `WORKING` to commit-only RPC methods.

Run both tests and `npm run build:webview`. Expected: tests and build pass.

- [ ] **Step 5: Commit working-state fixes**

```bash
git add src/webview/lib/git-status.ts src/webview/lib/mutation-gate.ts src/webview/App.svelte tests/webview
git commit -m "fix: show working changes and mutation progress"
```

---

### Task 6: Load Complete History and Resolve Scroll Races

**Agent:** `gpt-5.6-sol`, effort `high`; independent review by `gpt-5.6-sol`, effort `high`.

**Files:**
- Create: `src/extension/services/graph-loader.ts`
- Create: `src/webview/lib/latest-request.ts`
- Modify: `src/extension/extension.ts:179-220`
- Modify: `src/webview/App.svelte:80-211`
- Test: `tests/extension/graph-loader.test.ts`
- Test: `tests/webview/latest-request.test.ts`

**Interfaces:**
- Produces: `loadAllCommits(gitService, options, batchSize = 500): Promise<Commit[]>` and `LatestRequestGate`.

- [ ] **Step 1: Write RED batching tests**

Use a fake Git service returning 500, 500, then 37 commits. Assert calls use `{ maxCount: 500, skip: 0 }`, `{ maxCount: 500, skip: 500 }`, `{ maxCount: 500, skip: 1000 }`, results contain 1037 commits in order, and an empty first batch terminates after one call.

Run: `npm test -- tests/extension/graph-loader.test.ts`

Expected: FAIL because `graph-loader.ts` is missing.

- [ ] **Step 2: Implement batch loading and wire graph.build**

Implement the loop with a fixed batch size and terminate only when `batch.length < batchSize`. Preserve author/branch filters on every request. Replace the fixed `maxCount: 500` graph build with `loadAllCommits`, then build one layout.

Run the focused test. Expected: pass.

- [ ] **Step 3: Write a RED latest-request test**

Issue request tokens 1 and 2, resolve token 2 first and token 1 last, and assert only token 2 is accepted. Assert a third token can be issued while the first is pending.

Run: `npm test -- tests/webview/latest-request.test.ts`

Expected: FAIL because the gate is missing.

- [ ] **Step 4: Implement latest-request-wins in the webview**

`LatestRequestGate.issue()` increments an integer; `isLatest(token)` compares it with the last issued token. Remove `if (loading) return`. Every `fetchWindow` issues a token, performs the bridge request, and assigns `graphWindow/currentStartRow` only when the token remains latest. Clear the loading indicator only for the latest token.

Run latest-request tests and `npm run build:webview`. Expected: pass.

- [ ] **Step 5: Add a 501-commit integration assertion**

Create 501 allow-empty commits in a temporary repository, invoke the graph loader with the real service, and assert 501 results plus two `git log` batches. Keep this focused test timeout at 30 seconds.

Run the integration test. Expected: pass with all commits present.

- [ ] **Step 6: Commit graph and race fixes**

```bash
git add src/extension/services/graph-loader.ts src/extension/extension.ts src/webview/lib/latest-request.ts src/webview/App.svelte tests/extension tests/webview
git commit -m "fix: load complete history and keep latest graph window"
```

---

### Task 7: Keyboard and Viewport Accessibility

**Agent:** `gpt-5.6-terra`, effort `high`; review by `gpt-5.6-sol`, effort `medium`.

**Files:**
- Create: `src/webview/lib/context-menu-position.ts`
- Modify: `src/webview/components/actions/ContextMenu.svelte`
- Modify: `src/webview/components/sidebar/BranchSidebar.svelte`
- Modify: `src/webview/components/layout/ResizeHandle.svelte`
- Modify: `src/webview/App.svelte`
- Test: `tests/webview/context-menu-position.test.ts`
- Test: `tests/webview/context-menu.test.ts`
- Test: `tests/webview/branch-sidebar.test.ts`
- Test: `tests/webview/resize-handle.test.ts`

**Interfaces:**
- Produces: `clampMenuPosition(requested, menuSize, viewport, margin = 4)`, keyboard-operable menu/sidebar/resize controls.

- [ ] **Step 1: Write RED viewport-clamping tests**

Cover top-left, right overflow, bottom overflow, and a menu larger than the viewport. Assert returned coordinates never fall below the margin.

Run: `npm test -- tests/webview/context-menu-position.test.ts`

Expected: FAIL because the helper is missing.

- [ ] **Step 2: Implement the pure clamp helper**

Use:

```typescript
const maxX = Math.max(margin, viewport.width - menu.width - margin);
const maxY = Math.max(margin, viewport.height - menu.height - margin);
return {
  x: Math.min(Math.max(requested.x, margin), maxX),
  y: Math.min(Math.max(requested.y, margin), maxY)
};
```

Run the focused test. Expected: pass.

- [ ] **Step 3: Write RED context-menu DOM tests**

Render `ContextMenu` visible with enabled, disabled, and divider items. Assert the first enabled item receives focus; ArrowDown skips disabled items; ArrowUp wraps; Home/End move to first/last enabled item; Enter dispatches its action; Escape dispatches close; coordinates are clamped after mocking `getBoundingClientRect` and viewport dimensions.

Run: `npm test -- tests/webview/context-menu.test.ts`

Expected: FAIL on focus, navigation, and clamping.

- [ ] **Step 4: Implement menu focus and keyboard behavior**

Capture `document.activeElement` before focusing the menu, query enabled `[role="menuitem"]` buttons, manage roving `tabindex`, add `role="separator"`, and restore the captured element on close when it is still connected. Recalculate position after `tick()` when the menu becomes visible.

Run the context-menu tests. Expected: pass.

- [ ] **Step 5: Write and fix sidebar keyboard tests**

Render local branch, tag, stash, and worktree entries. Assert each is reachable by Tab semantics, Enter/Space invokes its primary action where defined, and Shift+F10 dispatches the correct context-menu event with coordinates derived from its bounding box.

Replace non-focusable interactive `li` nodes with semantic buttons inside list items, retain list structure, and add `aria-current="true"` for the current branch.

Run: `npm test -- tests/webview/branch-sidebar.test.ts`

Expected: pass after the semantic conversion.

- [ ] **Step 6: Write and fix resize-handle keyboard tests**

Assert ArrowRight/ArrowLeft adjust a left panel, reverse direction for a right panel, clamp to min/max, and Home/End select min/max. Add `tabindex="0"`, an `aria-label` describing the panel, and a keydown handler that updates bound width and dispatches `resize`.

Run: `npm test -- tests/webview/resize-handle.test.ts`

Expected: pass.

- [ ] **Step 7: Clamp side panel widths**

On mount and window resize, clamp `leftSidebarWidth + rightPanelWidth` so the center retains at least 300px. Add a pure width calculation beside the context-menu position helper and unit-test narrow 600px and normal 1400px viewports.

Run all webview tests and `npm run build:webview`. Expected: pass with no Svelte accessibility warnings.

- [ ] **Step 8: Commit accessibility fixes**

```bash
git add src/webview tests/webview
git commit -m "fix: make graph controls keyboard accessible"
```

---

### Task 8: Coverage Closure, Packaging, and Release Verification

**Agent:** `gpt-5.6-luna`, effort `medium` for packaging edits; final verification and review by `gpt-5.6-sol`, effort `high`.

**Files:**
- Modify: `.vscodeignore`
- Modify: tests under `tests/` only when coverage output identifies an untested behavior branch
- Modify: `vitest.config.ts` only to correct an inaccurate include/exclude path, never to lower thresholds

**Interfaces:**
- Produces: passing 80/80/80/70 coverage gate and a VSIX without internal planning files.

- [ ] **Step 1: Exclude internal artifacts from packaging**

Add:

```text
.superpowers/**
coverage/**
tests/**
vitest.config.ts
```

to `.vscodeignore`.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: all unit, integration, RPC, and component tests pass with zero unhandled rejections.

- [ ] **Step 3: Enforce the coverage gate**

Run: `npm run coverage`

Expected: statements ≥80%, lines ≥80%, functions ≥80%, branches ≥70%. If a threshold fails, add a behavior-focused test for the uncovered branch; do not lower the configured threshold or exclude the source file.

- [ ] **Step 4: Run static and production verification**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Verify VSIX contents**

Run:

```bash
npm run package
vsce ls --tree
```

Expected: `.superpowers`, `tests`, and `coverage` are absent; `dist/extension.cjs`, `dist/webview/assets/main.js`, and `dist/webview/assets/main.css` are present. Remove the generated `.vsix` after recording the package result.

- [ ] **Step 6: Review destructive-operation invariants**

Re-run only the P0 regression tests with verbose output:

```bash
npm test -- tests/extension/git-rewrite.integration.test.ts --reporter=verbose
```

Expected: reword and squash both retain descendants, published-history detection passes, and temporary repositories are removed after the suite.

- [ ] **Step 7: Run the aggregate check**

Run: `npm run check`

Expected: tests, coverage, typecheck, and production build all exit 0 in one command.

- [ ] **Step 8: Confirm repository state and commit**

```bash
git status --short
git add .vscodeignore vitest.config.ts package.json package-lock.json src tests
git commit -m "fix: close task 4 review findings"
git status --short
```

Expected: final status is clean. Do not push or open a pull request without separate user authorization.

---

## Final Acceptance Checklist

- [ ] Rewording B in A→B→C→D produces A→B′→C′→D′.
- [ ] Squashing B+C in A→B→C→D produces A→BC′→D′.
- [ ] Published-history rewrite requires explicit confirmation.
- [ ] `git.revert` succeeds from the webview route.
- [ ] Working changes are visible for staged, unstaged, untracked, and conflicted states.
- [ ] File status, rename/copy paths, binary stats, non-ASCII names, spaces, and tabs are correct.
- [ ] A 501-commit repository exposes all 501 commits.
- [ ] A stale graph-window response cannot overwrite the latest request.
- [ ] Context menu, sidebar, and resize handles are keyboard operable.
- [ ] Git mutations expose progress and reject duplicate dispatches.
- [ ] Coverage meets 80/80/80/70.
- [ ] Build, typecheck, tests, package, and aggregate check pass.
- [ ] VSIX excludes `.superpowers/**`, tests, and coverage output.
- [ ] Final worktree is clean and no external push/PR occurred.
