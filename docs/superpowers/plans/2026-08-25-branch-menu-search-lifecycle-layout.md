# Branch Menu, Commit Search, Lifecycle & Row Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing branch context-menu actions, commit search by message/hash, a progress spinner, a multi-branch graph filter, right-aligned ref chips, and stop the startup lifecycle errors.

**Architecture:** Extension-side git and graph capabilities land first (new `GitService` methods, multi-ref log snapshot, a typed supersede error). Decision logic moves into pure helpers under `src/webview/lib/` where the coverage config already reaches. `App.svelte` integration comes last, one task at a time, because every UI task edits that single file.

**Tech Stack:** TypeScript, Svelte 4, Vite, esbuild, vitest + @testing-library/svelte, VS Code webview API, git CLI.

**Spec:** `docs/superpowers/specs/2026-08-25-branch-context-menu-and-commit-search-design.md`

## Global Constraints

- Svelte 4 (`^4.2.0`): `export let` props, assignment-based reactivity. No runes.
- `GitCLI.exec()` resolves to a **`string`**, never `{ stdout }`.
- Assert on the **argv array** passed to `exec`, not on parsed output, when pinning git flags.
- Coverage thresholds are enforced: statements 80, lines 80, functions 80, branches 70.
- Coverage `include` already covers `src/extension/services/git.service.ts`, `src/extension/controllers/git-method-handler.ts`, `src/extension/controllers/graph-method-handler.ts`, `src/webview/lib/**/*.ts`. New logic there **requires** tests.
- Do **not** add new `.svelte` files to the coverage `include` list.
- `npm run check` must pass before every commit.
- Do not change `ROW_HEIGHT` (`src/webview/lib/virtual-scroll.ts`).
- Error `kind` propagation: extension throws an error carrying a string `code`; `message-router.ts:62` copies it to `error.kind`; `message-bridge.ts:128-129` reattaches it as `err.kind`.

## Parallel Execution Map

Parallelism is bounded by **file ownership**, not by feature independence. Two agents must never
hold the same file.

```
Wave 1 — three tracks run in parallel
  Track A (owns src/extension/services/git.service.ts,
                src/extension/types/git.types.ts,
                src/extension/controllers/git-method-handler.ts)
      A1 → A2 → A3          sequential inside the track

  Track B (owns src/extension/controllers/graph-method-handler.ts)
      B1

  Track C (owns only NEW files under src/webview/lib/ and components/common/)
      C1 ‖ C2 ‖ C3 ‖ C4 ‖ C5    all five fully parallel

Wave 2 — strictly sequential, single owner of src/webview/App.svelte
  D1 → D2 → D3 → D4 → D5 → D6
```

**Dispatch rule:** launch A1, B1, C1, C2, C3, C4, C5 together (7 agents). A2 starts when A1
lands, A3 when A2 lands. Wave 2 starts only after Wave 1 is fully merged.

| Task | Depends on | Reason |
|------|-----------|--------|
| A2, A3 | A1 (file lock only) | same three files |
| D1 | C1 | consumes `sortRefsForRow` |
| D2 | C5 | consumes `LoadingSpinner` |
| D3 | B1, C4 | consumes the error kind and the scheduler |
| D4 | A1, A2, C3 | consumes `git.diffWorkingTree`, `resolvePullTarget` |
| D5 | A1, C2, C5 | consumes `git.searchCommits`, query classifier, spinner |
| D6 | A3, C3 | consumes multi-ref log and the filter label |

---

# Wave 1 — Track A: extension git layer

### Task A1: `git.searchCommits`

**Files:**
- Modify: `src/extension/services/git.service.ts` (add method after `revParse`, ~line 218)
- Modify: `src/extension/controllers/git-method-handler.ts` (add case near `git.log`)
- Test: `tests/extension/git-search-commits.test.ts` (create)

**Interfaces:**
- Consumes: `GitCLI.exec(args: string[]): Promise<string>`
- Produces: `GitService.searchCommits(query: string): Promise<string[]>`; method `git.searchCommits` taking `{ query: string }` and returning `string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/extension/git-search-commits.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';

function serviceWith(exec: (args: string[]) => Promise<string>) {
  const service = new GitService('/repo');
  const spy = vi.fn(exec);
  // GitCLI is private; the tests replace it through the same seam the
  // existing suites use — a direct property override on the instance.
  (service as unknown as { cli: { exec: typeof spy } }).cli = { exec: spy };
  return { service, spy };
}

describe('GitService.searchCommits', () => {
  it('returns nothing for a blank query without touching git', async () => {
    const { service, spy } = serviceWith(async () => '');
    expect(await service.searchCommits('   ')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('verifies a hash-shaped query as a commit before grepping', async () => {
    const full = 'a'.repeat(40);
    const { service, spy } = serviceWith(async () => `${full}\n`);
    expect(await service.searchCommits('a1b2c3d')).toEqual([full]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(['rev-parse', '--verify', 'a1b2c3d^{commit}']);
  });

  it('falls back to a case-insensitive message grep when the hash does not resolve', async () => {
    const calls: string[][] = [];
    const { service } = serviceWith(async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') throw new Error('unknown revision');
      return `${'b'.repeat(40)}\n${'c'.repeat(40)}\n`;
    });

    expect(await service.searchCommits('deadbeef')).toEqual(['b'.repeat(40), 'c'.repeat(40)]);
    expect(calls[1]).toEqual([
      'log', '--grep=deadbeef', '-i', '--max-count=50', '--format=%H', '--all',
    ]);
  });

  it('greps directly for text queries and drops blank lines', async () => {
    const { service, spy } = serviceWith(async () => `${'d'.repeat(40)}\n\n`);
    expect(await service.searchCommits('  fix login  ')).toEqual(['d'.repeat(40)]);
    expect(spy.mock.calls[0][0]).toEqual([
      'log', '--grep=fix login', '-i', '--max-count=50', '--format=%H', '--all',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extension/git-search-commits.test.ts`
Expected: FAIL — `service.searchCommits is not a function`

- [ ] **Step 3: Implement `searchCommits`**

In `src/extension/services/git.service.ts`, directly after `revParse`:

```typescript
  /**
   * Finds commits by abbreviated/full hash or by message text.
   *
   * `rev-parse --verify <q>^{commit}` is the only reliable existence check —
   * plain `rev-parse` echoes syntactically valid object names back even when
   * the object is absent. A hash-shaped query that does not resolve falls
   * through to the message grep, because `deadbeef` is also a real word.
   */
  public async searchCommits(query: string): Promise<string[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];

    if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
      const resolved = await this.cli
        .exec(['rev-parse', '--verify', `${trimmed}^{commit}`])
        .then((output) => output.trim())
        .catch(() => '');
      if (resolved !== '') return [resolved];
    }

    const output = await this.cli.exec([
      'log', `--grep=${trimmed}`, '-i', '--max-count=50', '--format=%H', '--all',
    ]);
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  }
```

- [ ] **Step 4: Register the method**

In `src/extension/controllers/git-method-handler.ts`, after the `case 'git.log':` block:

```typescript
    case 'git.searchCommits':
      return gitService.searchCommits(p.query as string);
```

- [ ] **Step 5: Extend the handler test**

Append to `tests/extension/git-method-handler.test.ts` inside the existing top-level `describe`:

```typescript
  it('routes git.searchCommits to the service', async () => {
    const hashes = ['a'.repeat(40)];
    const service = { ...fakeGitService, searchCommits: async () => hashes };
    const result = await handleGitMethod(service as unknown as GitService, 'git.searchCommits', { query: 'fix' });
    expect(result).toEqual(hashes);
  });
```

Add `searchCommits: async () => []` to the `fakeGitService` literal so the object still satisfies
the service shape for every other case.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/extension/git-search-commits.test.ts tests/extension/git-method-handler.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/extension/services/git.service.ts src/extension/controllers/git-method-handler.ts tests/extension/git-search-commits.test.ts tests/extension/git-method-handler.test.ts
git commit -m "feat(git): add searchCommits by hash or message"
```

---

### Task A2: `git.diffWorkingTree`

**Files:**
- Modify: `src/extension/services/git.service.ts` (add after `diff`, ~line 207)
- Modify: `src/extension/controllers/git-method-handler.ts`
- Test: `tests/extension/git-diff-working-tree.test.ts` (create)

**Interfaces:**
- Consumes: the existing parse helpers used by `diff()` in the same file
- Produces: `GitService.diffWorkingTree(ref: string): Promise<DiffResult>`; method `git.diffWorkingTree` taking `{ ref: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/extension/git-diff-working-tree.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extension/git-diff-working-tree.test.ts`
Expected: FAIL — `service.diffWorkingTree is not a function`

- [ ] **Step 3: Implement `diffWorkingTree`**

`diff()` (`git.service.ts:193-206`) parses through the shared `parseFileChanges` helper already
imported in this file, so `diffWorkingTree` reuses it directly — only the revision arguments
change:

```typescript
  /**
   * Compares `ref` against the working tree. Unlike `diff()` there is no
   * second revision and no three-dot range — `git diff <ref>` already means
   * "ref versus what is on disk right now".
   */
  public async diffWorkingTree(ref: string): Promise<DiffResult> {
    const [numstatOutput, nameStatusOutput, rawOutput] = await Promise.all([
      this.cli.exec(['diff', '--numstat', '-z', '-M', '-C', ref]),
      this.cli.exec(['diff', '--name-status', '-z', '-M', '-C', ref]),
      this.cli.exec(['diff', '-M', '-C', ref]),
    ]);

    return {
      files: parseFileChanges(numstatOutput, nameStatusOutput),
      raw: rawOutput,
    };
  }
```

- [ ] **Step 4: Register the method**

In `git-method-handler.ts`, after `case 'git.diff':`:

```typescript
    case 'git.diffWorkingTree':
      return gitService.diffWorkingTree(p.ref as string);
```

Add `diffWorkingTree: async () => ({ files: [], raw: '' })` to `fakeGitService` in
`tests/extension/git-method-handler.test.ts`, plus:

```typescript
  it('routes git.diffWorkingTree to the service', async () => {
    const service = { ...fakeGitService, diffWorkingTree: async () => ({ files: [], raw: 'RAW' }) };
    const result = await handleGitMethod(service as unknown as GitService, 'git.diffWorkingTree', { ref: 'develop' });
    expect(result).toEqual({ files: [], raw: 'RAW' });
  });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/extension/git-diff-working-tree.test.ts tests/extension/git-method-handler.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/extension/services/git.service.ts src/extension/controllers/git-method-handler.ts tests/extension/git-diff-working-tree.test.ts tests/extension/git-method-handler.test.ts
git commit -m "feat(git): add diffWorkingTree for branch vs working tree"
```

---

### Task A3: multi-branch log snapshot

**Files:**
- Modify: `src/extension/types/git.types.ts` (`GitLogOptions`)
- Modify: `src/extension/services/git.service.ts` (`snapshotLogOptions`, ~line 96-114)
- Modify: `src/extension/controllers/graph-method-handler.ts` (`GraphOptions`, `build`)
- Test: `tests/extension/git-multi-branch-log.test.ts` (create)

**Interfaces:**
- Consumes: existing `GitLogOptions.revisions?: string[]` handling in `log()` — **do not modify `log()`**, it already spreads `revisions`
- Produces: `GitLogOptions.branches?: string[]`; `graph.build` accepts `{ branches: string[] }`

- [ ] **Step 1: Write the failing test**

Create `tests/extension/git-multi-branch-log.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extension/git-multi-branch-log.test.ts`
Expected: FAIL — `branches` is not accepted / `revisions` is `['undefined']`

- [ ] **Step 3: Add `branches` to the options type**

In `src/extension/types/git.types.ts`, inside `GitLogOptions`:

```typescript
  /** Single-branch filter. Kept for existing callers. */
  branch?: string;
  /** Multi-branch filter. Takes precedence over `branch` when non-empty. */
  branches?: string[];
```

- [ ] **Step 4: Resolve multiple branches in `snapshotLogOptions`**

Replace the leading `if (options.branch)` arm (`git.service.ts:99-102`) with:

```typescript
    const requestedBranches = options.branches?.length
      ? options.branches
      : (options.branch ? [options.branch] : []);

    if (requestedBranches.length > 0) {
      const resolved = await Promise.all(requestedBranches.map((branch) => this.cli
        // A branch can vanish between the branch list and the build; a stale
        // entry must not fail the whole graph.
        .exec(['rev-parse', '--verify', branch])
        .then((output) => output.trim())
        .catch(() => '')));
      revisions = [...new Set(resolved.filter(Boolean))];
    } else if (options.all) {
```

Keep the `all` and `HEAD` arms untouched.

- [ ] **Step 5: Thread `branches` through the graph handler**

In `src/extension/controllers/graph-method-handler.ts`, add `branches?: string[]` to
`GraphOptions` and include it in the `logOptions` object built in `build()` (~line 68-71),
alongside the existing `branch` and `all` fields.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/extension/git-multi-branch-log.test.ts tests/extension/graph-method-handler.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/extension/types/git.types.ts src/extension/services/git.service.ts src/extension/controllers/graph-method-handler.ts tests/extension/git-multi-branch-log.test.ts
git commit -m "feat(graph): resolve multiple branch filters into log revisions"
```

---

# Wave 1 — Track B: extension graph layer

### Task B1: typed supersede error

**Files:**
- Modify: `src/extension/controllers/graph-method-handler.ts` (`assertCurrent`, ~line 97-108)
- Test: `tests/extension/graph-method-handler.test.ts` (extend)

**Interfaces:**
- Produces: a build failure carrying `code: 'GRAPH_BUILD_SUPERSEDED'`, which `message-router.ts:62` copies into `error.kind` and `message-bridge.ts:128-129` reattaches as `err.kind`

- [ ] **Step 1: Write the failing test**

Append to `tests/extension/graph-method-handler.test.ts`, using the `graphSource`, `commit`, and
`deferred` helpers already defined at the top of that file:

```typescript
  it('tags a superseded build with a stable error code', async () => {
    // invalidate() bumps the generation before the event goes out, so the
    // in-flight build is expected to lose. The webview must recognise that
    // from a code, not from the message text.
    const pendingLog = deferred<Commit[]>();
    const source = graphSource('/repo', () => pendingLog.promise);
    const handler = new GraphMethodHandler(new GraphService(), () => source);

    const inFlight = handler.handle('graph.build', { all: true });
    await Promise.resolve();
    handler.invalidate();
    pendingLog.resolve([commit('old')]);

    await expect(inFlight).rejects.toMatchObject({
      message: 'Graph build superseded',
      code: 'GRAPH_BUILD_SUPERSEDED',
    });
  });
```

The existing `rejects.toThrow('Graph build superseded')` assertion earlier in this file must keep
passing — the message stays identical, only the `code` property is added.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extension/graph-method-handler.test.ts`
Expected: FAIL — rejection has no `code` property

- [ ] **Step 3: Attach the code**

In `graph-method-handler.ts`, replace the throw inside `assertCurrent`:

```typescript
  private assertCurrent(generation: number, gitService: GraphGitService, repoPath: string): void {
    const current = this.getGitService();
    if (generation !== this.buildGeneration || current !== gitService || current?.getRepoPath() !== repoPath) {
      // Superseded is routine, not a fault: invalidate() bumps the generation
      // before the event goes out, so any in-flight build is expected to lose.
      // The code lets the webview drop it instead of surfacing an error.
      const error = new Error('Graph build superseded') as Error & { code: string };
      error.code = 'GRAPH_BUILD_SUPERSEDED';
      throw error;
    }
  }
```

Keep the existing condition exactly as it is — only the thrown value changes.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/extension/graph-method-handler.test.ts tests/extension/message-router.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extension/controllers/graph-method-handler.ts tests/extension/graph-method-handler.test.ts
git commit -m "fix(graph): tag superseded builds with GRAPH_BUILD_SUPERSEDED"
```

---

# Wave 1 — Track C: webview helpers (all parallel, new files only)

### Task C1: ref chip ordering helper

**Files:**
- Create: `src/webview/lib/ref-chips.ts`
- Test: `tests/webview/ref-chips.test.ts` (create)

**Interfaces:**
- Produces: `sortRefsForRow(refs: string[]): string[]`, `refDisplayName(ref: string): string`, `refType(ref: string): 'head' | 'branch' | 'tag' | 'remote'`

- [ ] **Step 1: Write the failing test**

Create `tests/webview/ref-chips.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { refDisplayName, refType, sortRefsForRow } from '../../src/webview/lib/ref-chips';

describe('sortRefsForRow', () => {
  it('puts HEAD first, then local branches, then tags, then remotes', () => {
    expect(sortRefsForRow([
      'origin/develop', 'tag: v1.2.0', 'develop', 'HEAD -> develop',
    ])).toEqual([
      'HEAD -> develop', 'develop', 'tag: v1.2.0', 'origin/develop',
    ]);
  });

  it('keeps a stable order inside a group', () => {
    expect(sortRefsForRow(['feature/b', 'feature/a'])).toEqual(['feature/b', 'feature/a']);
  });

  it('leaves an empty list alone', () => {
    expect(sortRefsForRow([])).toEqual([]);
  });
});

describe('refType', () => {
  it('classifies each ref shape', () => {
    expect(refType('HEAD -> develop')).toBe('head');
    expect(refType('tag: v1.0.0')).toBe('tag');
    expect(refType('origin/develop')).toBe('remote');
    expect(refType('develop')).toBe('branch');
  });
});

describe('refDisplayName', () => {
  it('strips the tag and HEAD prefixes', () => {
    expect(refDisplayName('tag: v1.0.0')).toBe('v1.0.0');
    expect(refDisplayName('HEAD -> develop')).toBe('develop');
    expect(refDisplayName('origin/develop')).toBe('origin/develop');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/webview/ref-chips.test.ts`
Expected: FAIL — cannot resolve `../../src/webview/lib/ref-chips`

- [ ] **Step 3: Implement the helper**

Create `src/webview/lib/ref-chips.ts`:

```typescript
export type RefType = 'head' | 'branch' | 'tag' | 'remote';

const KNOWN_REMOTE_PREFIXES = ['origin/', 'upstream/'];

export function refType(ref: string): RefType {
  if (ref.includes('HEAD')) return 'head';
  if (ref.startsWith('tag:')) return 'tag';
  if (KNOWN_REMOTE_PREFIXES.some((prefix) => ref.startsWith(prefix))) return 'remote';
  return 'branch';
}

export function refDisplayName(ref: string): string {
  return ref.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
}

// Chips are right-aligned and truncate from the right, so the refs a reader
// needs most must come first: where HEAD is, then local branches, then tags,
// then remotes, which are the most guessable from context.
const ORDER: Record<RefType, number> = { head: 0, branch: 1, tag: 2, remote: 3 };

export function sortRefsForRow(refs: string[]): string[] {
  return refs
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => (ORDER[refType(a.ref)] - ORDER[refType(b.ref)]) || (a.index - b.index))
    .map((entry) => entry.ref);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/webview/ref-chips.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/ref-chips.ts tests/webview/ref-chips.test.ts
git commit -m "feat(webview): add ref chip ordering and display helpers"
```

---

### Task C2: commit search state helper

**Files:**
- Create: `src/webview/lib/commit-search.ts`
- Test: `tests/webview/commit-search.test.ts` (create)

**Interfaces:**
- Produces: `classifyQuery(query: string): 'empty' | 'hash' | 'text'`, `nextMatchIndex(total: number, activeIndex: number, direction: 1 | -1): number`, `formatMatchCounter(total: number, activeIndex: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/webview/commit-search.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { classifyQuery, formatMatchCounter, nextMatchIndex } from '../../src/webview/lib/commit-search';

describe('classifyQuery', () => {
  it('treats blank input as empty', () => {
    expect(classifyQuery('   ')).toBe('empty');
    expect(classifyQuery('')).toBe('empty');
  });

  it('recognises hash-shaped input of 7 to 40 hex characters', () => {
    expect(classifyQuery('a1b2c3d')).toBe('hash');
    expect(classifyQuery('A1B2C3D')).toBe('hash');
    expect(classifyQuery('f'.repeat(40))).toBe('hash');
  });

  it('treats short or non-hex input as text', () => {
    expect(classifyQuery('a1b2c3')).toBe('text');       // 6 chars
    expect(classifyQuery('f'.repeat(41))).toBe('text'); // too long
    expect(classifyQuery('fix login')).toBe('text');
  });
});

describe('nextMatchIndex', () => {
  it('wraps forward past the end', () => {
    expect(nextMatchIndex(3, 2, 1)).toBe(0);
    expect(nextMatchIndex(3, 0, 1)).toBe(1);
  });

  it('wraps backward past the start', () => {
    expect(nextMatchIndex(3, 0, -1)).toBe(2);
    expect(nextMatchIndex(3, 2, -1)).toBe(1);
  });

  it('stays at zero when there is nothing to cycle', () => {
    expect(nextMatchIndex(0, 0, 1)).toBe(0);
  });
});

describe('formatMatchCounter', () => {
  it('shows a one-based position', () => {
    expect(formatMatchCounter(5, 0)).toBe('1/5');
    expect(formatMatchCounter(5, 4)).toBe('5/5');
  });

  it('shows nothing when there are no matches', () => {
    expect(formatMatchCounter(0, 0)).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/webview/commit-search.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the helper**

Create `src/webview/lib/commit-search.ts`:

```typescript
export type SearchQueryKind = 'empty' | 'hash' | 'text';

const HASH_SHAPED = /^[0-9a-f]{7,40}$/i;

export function classifyQuery(query: string): SearchQueryKind {
  const trimmed = query.trim();
  if (trimmed === '') return 'empty';
  return HASH_SHAPED.test(trimmed) ? 'hash' : 'text';
}

export function nextMatchIndex(total: number, activeIndex: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  return (activeIndex + direction + total) % total;
}

export function formatMatchCounter(total: number, activeIndex: number): string {
  if (total <= 0) return '';
  return `${activeIndex + 1}/${total}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/webview/commit-search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/commit-search.ts tests/webview/commit-search.test.ts
git commit -m "feat(webview): add commit search query and match helpers"
```

---

### Task C3: branch menu targeting helper

**Files:**
- Create: `src/webview/lib/branch-menu.ts`
- Test: `tests/webview/branch-menu.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface MenuBranch { name: string; current: boolean; remote: string | null; upstream: string | null }`
  - `interface PullTarget { remote: string; ref: string }`
  - `resolvePullTarget(branch: MenuBranch): PullTarget | null`
  - `localNameFor(branch: MenuBranch): string`
  - `formatBranchFilterLabel(selected: string[]): string`
  - `formatFilterStatus(totalRows: number, selected: string[], branchCount: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/webview/branch-menu.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  formatBranchFilterLabel,
  formatFilterStatus,
  localNameFor,
  resolvePullTarget,
} from '../../src/webview/lib/branch-menu';

const branch = (over: Partial<Parameters<typeof resolvePullTarget>[0]> = {}) => ({
  name: 'develop', current: false, remote: null, upstream: null, ...over,
});

describe('resolvePullTarget', () => {
  it('splits a remote branch into remote and ref', () => {
    expect(resolvePullTarget(branch({ name: 'origin/bugfix/RMS2025-1027', remote: 'origin' })))
      .toEqual({ remote: 'origin', ref: 'bugfix/RMS2025-1027' });
  });

  it('uses the upstream of a local branch', () => {
    expect(resolvePullTarget(branch({ name: 'develop', upstream: 'origin/develop' })))
      .toEqual({ remote: 'origin', ref: 'develop' });
  });

  it('returns null for a local branch with no upstream', () => {
    expect(resolvePullTarget(branch())).toBeNull();
  });

  it('keeps nested refs intact when splitting', () => {
    expect(resolvePullTarget(branch({ name: 'develop', upstream: 'upstream/team/a/b' })))
      .toEqual({ remote: 'upstream', ref: 'team/a/b' });
  });
});

describe('localNameFor', () => {
  it('strips the remote prefix', () => {
    expect(localNameFor(branch({ name: 'origin/feature/x', remote: 'origin' }))).toBe('feature/x');
  });

  it('leaves a local name alone', () => {
    expect(localNameFor(branch({ name: 'feature/x' }))).toBe('feature/x');
  });
});

describe('formatBranchFilterLabel', () => {
  it('describes the selection', () => {
    expect(formatBranchFilterLabel([])).toBe('All branches');
    expect(formatBranchFilterLabel(['develop'])).toBe('develop');
    expect(formatBranchFilterLabel(['develop', 'main'])).toBe('2 branches');
  });
});

describe('formatFilterStatus', () => {
  it('reports commits against the active filter', () => {
    expect(formatFilterStatus(120, [], 7)).toBe('7 branches, 120 commits');
    expect(formatFilterStatus(30, ['develop'], 7)).toBe('30 commits on develop');
    expect(formatFilterStatus(45, ['develop', 'main'], 7)).toBe('45 commits on 2 branches');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/webview/branch-menu.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the helper**

Create `src/webview/lib/branch-menu.ts`:

```typescript
export interface MenuBranch {
  name: string;
  current: boolean;
  remote: string | null;
  upstream: string | null;
}

export interface PullTarget {
  remote: string;
  ref: string;
}

function splitRemoteRef(fullName: string): PullTarget | null {
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) return null;
  return { remote: fullName.slice(0, slash), ref: fullName.slice(slash + 1) };
}

/**
 * "Pull into current" integrates someone else's ref, so it needs a concrete
 * remote and ref. A remote branch supplies both directly; a local branch
 * borrows them from its upstream. Without an upstream there is nothing to
 * pull, and the menu item is omitted rather than shown disabled.
 */
export function resolvePullTarget(branch: MenuBranch): PullTarget | null {
  if (branch.remote) return splitRemoteRef(branch.name);
  if (branch.upstream) return splitRemoteRef(branch.upstream);
  return null;
}

export function localNameFor(branch: MenuBranch): string {
  return branch.remote ? branch.name.replace(/^[^/]+\//, '') : branch.name;
}

export function formatBranchFilterLabel(selected: string[]): string {
  if (selected.length === 0) return 'All branches';
  if (selected.length === 1) return selected[0];
  return `${selected.length} branches`;
}

export function formatFilterStatus(totalRows: number, selected: string[], branchCount: number): string {
  if (selected.length === 0) return `${branchCount} branches, ${totalRows} commits`;
  if (selected.length === 1) return `${totalRows} commits on ${selected[0]}`;
  return `${totalRows} commits on ${selected.length} branches`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/webview/branch-menu.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/branch-menu.ts tests/webview/branch-menu.test.ts
git commit -m "feat(webview): add branch menu targeting and filter label helpers"
```

---

### Task C4: refresh scheduler helper

**Files:**
- Create: `src/webview/lib/graph-refresh.ts`
- Test: `tests/webview/graph-refresh.test.ts` (create)

**Interfaces:**
- Produces: `isSupersededError(error: unknown): boolean`, `createRefreshScheduler(options: { run: () => Promise<void>; delayMs: number; onError: (error: unknown) => void }): { schedule(): void; cancel(): void }`

- [ ] **Step 1: Write the failing test**

Create `tests/webview/graph-refresh.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRefreshScheduler, isSupersededError } from '../../src/webview/lib/graph-refresh';

describe('isSupersededError', () => {
  it('recognises the error kind carried across the bridge', () => {
    const error = Object.assign(new Error('Graph build superseded'), { kind: 'GRAPH_BUILD_SUPERSEDED' });
    expect(isSupersededError(error)).toBe(true);
  });

  it('does not guess from message text alone', () => {
    expect(isSupersededError(new Error('Graph build superseded'))).toBe(false);
  });

  it('tolerates non-errors', () => {
    expect(isSupersededError(undefined)).toBe(false);
    expect(isSupersededError('boom')).toBe(false);
  });
});

describe('createRefreshScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of invalidations into one run', async () => {
    const run = vi.fn(async () => {});
    const scheduler = createRefreshScheduler({ run, delayMs: 200, onError: () => {} });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports failures through onError', async () => {
    const onError = vi.fn();
    const scheduler = createRefreshScheduler({
      run: async () => { throw new Error('nope'); },
      delayMs: 10,
      onError,
    });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('nope');
  });

  it('does not run after cancel', async () => {
    const run = vi.fn(async () => {});
    const scheduler = createRefreshScheduler({ run, delayMs: 50, onError: () => {} });

    scheduler.schedule();
    scheduler.cancel();
    await vi.advanceTimersByTimeAsync(50);

    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/webview/graph-refresh.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the helper**

Create `src/webview/lib/graph-refresh.ts`:

```typescript
/**
 * `invalidate()` bumps the build generation before the event is sent, so every
 * in-flight build is expected to lose that race. The extension tags those
 * failures with a stable code; matching on the code rather than the message
 * keeps the check from silently breaking when the wording changes.
 */
export function isSupersededError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { kind?: unknown }).kind === 'GRAPH_BUILD_SUPERSEDED';
}

export interface RefreshScheduler {
  schedule(): void;
  cancel(): void;
}

export function createRefreshScheduler(options: {
  run: () => Promise<void>;
  delayMs: number;
  onError: (error: unknown) => void;
}): RefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    // A watcher burst (checkout writes HEAD, refs and index in quick
    // succession) collapses into a single refresh; the existing
    // LatestRequestGate still handles genuine overlap.
    schedule(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        options.run().catch(options.onError);
      }, options.delayMs);
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/webview/graph-refresh.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/graph-refresh.ts tests/webview/graph-refresh.test.ts
git commit -m "feat(webview): add superseded detection and refresh scheduler"
```

---

### Task C5: `LoadingSpinner` component

**Files:**
- Create: `src/webview/components/common/LoadingSpinner.svelte`
- Test: `tests/webview/loading-spinner.test.ts` (create)

**Interfaces:**
- Produces: `<LoadingSpinner size?: 'sm' | 'md' label?: string />`

- [ ] **Step 1: Write the failing test**

Create `tests/webview/loading-spinner.test.ts`:

```typescript
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import LoadingSpinner from '../../src/webview/components/common/LoadingSpinner.svelte';

afterEach(cleanup);

describe('LoadingSpinner', () => {
  it('announces itself as a busy status', () => {
    const { getByRole } = render(LoadingSpinner, { props: { label: 'Pushing to origin…' } });
    const status = getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Pushing to origin…');
  });

  it('defaults to the small size', () => {
    const { getByRole } = render(LoadingSpinner);
    expect(getByRole('status').className).toContain('spinner-sm');
  });

  it('accepts the medium size', () => {
    const { getByRole } = render(LoadingSpinner, { props: { size: 'md' } });
    expect(getByRole('status').className).toContain('spinner-md');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/webview/loading-spinner.test.ts`
Expected: FAIL — component file not found

- [ ] **Step 3: Implement the component**

Create `src/webview/components/common/LoadingSpinner.svelte`:

```svelte
<script lang="ts">
  export let size: 'sm' | 'md' = 'sm';
  export let label = 'Working…';
</script>

<span class="spinner spinner-{size}" role="status" aria-label={label}>
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor"
            stroke-width="2" stroke-dasharray="47 16" stroke-linecap="round" />
  </svg>
</span>

<style>
  .spinner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-progressBar-background, #0e70c0);
    flex-shrink: 0;
  }

  .spinner-sm svg { width: 12px; height: 12px; }
  .spinner-md svg { width: 16px; height: 16px; }

  svg {
    animation: spin 0.9s linear infinite;
    transform-origin: center;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* A spinner exists to say "still working", which a slower sweep still says. */
  @media (prefers-reduced-motion: reduce) {
    svg { animation-duration: 2s; }
  }
</style>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/webview/loading-spinner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/common/LoadingSpinner.svelte tests/webview/loading-spinner.test.ts
git commit -m "feat(webview): add LoadingSpinner component"
```

---

# Wave 2 — `App.svelte` integration (sequential, single owner)

### Task D1: right-aligned ref chips

**Depends on:** C1

**Files:**
- Modify: `src/webview/App.svelte` (row template ~1687-1692, `.col-message` CSS ~2130-2141, `.ref-badge` ~2191-2200, `.commit-subject` ~2219-2223)
- Test: `tests/webview/graph-row-layout.test.ts` (create)

**Interfaces:**
- Consumes: `sortRefsForRow`, `refDisplayName`, `refType` from `src/webview/lib/ref-chips`

- [ ] **Step 1: Write the failing test**

Create `tests/webview/graph-row-layout.test.ts`. Copy the mock setup and `windowResult`
helper from `tests/webview/app-refresh-race.test.ts`, then assert the layout contract:

```typescript
  it('renders the subject before the right-aligned chip group', async () => {
    const { container } = await renderAppWithRow({
      subject: 'fix: login redirect loop',
      refs: ['origin/develop', 'HEAD -> develop', 'tag: v1.0.0'],
    });

    const message = container.querySelector('.commit-row .col-message')!;
    const children = Array.from(message.children);

    // Subject first in the DOM, chips last: matches the visual order and reads
    // correctly for screen readers.
    expect(children[0].classList.contains('commit-subject')).toBe(true);
    expect(children[1].classList.contains('ref-chips')).toBe(true);

    const chips = Array.from(message.querySelectorAll('.ref-badge')).map((el) => el.textContent?.trim());
    expect(chips).toEqual(['develop', 'v1.0.0', 'origin/develop']);
  });

  it('gives both the subject and every chip a title for the truncated case', async () => {
    const { container } = await renderAppWithRow({
      subject: 'a'.repeat(200),
      refs: ['origin/some/very/long/branch/name'],
    });

    expect(container.querySelector('.commit-subject')!.getAttribute('title')).toBe('a'.repeat(200));
    expect(container.querySelector('.ref-badge')!.getAttribute('title')).toBe('origin/some/very/long/branch/name');
  });
```

`renderAppWithRow` is a local helper in this file:

```typescript
async function renderAppWithRow(node: { subject: string; refs: string[] }) {
  const hash = 'a'.repeat(40);
  send.mockImplementation((method: string) => {
    switch (method) {
      case 'repo.list': return Promise.resolve({ repos: [{ path: '/repo', name: 'repo', active: true }], submodules: [] });
      case 'git.branches': return Promise.resolve([branch('main')]);
      case 'graph.build': return Promise.resolve({ totalRows: 1, maxLane: 0, layoutVersion: 1 });
      case 'graph.getWindow': return Promise.resolve({
        nodes: [{
          hash, abbreviatedHash: hash.slice(0, 7), subject: node.subject, refs: node.refs,
          author: 'A', authorEmail: 'a@example.test', authorDate: '2026-08-23T00:00:00Z',
          parents: [], lane: 0, row: 0, color: 0,
        }],
        edges: [], startRow: 0, endRow: 1, totalRows: 1,
      });
      default: return Promise.resolve([]);
    }
  });

  const rendered = render(App);
  await waitFor(() => expect(rendered.container.querySelector('.commit-row')).not.toBeNull());
  return rendered;
}
```

`branch()` and the `send` / `on` hoisted mocks come from the same setup used in
`tests/webview/app-refresh-race.test.ts`; copy those five lines verbatim at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/webview/graph-row-layout.test.ts`
Expected: FAIL — chips render before the subject and have no `.ref-chips` wrapper

- [ ] **Step 3: Import the helper and delete the local copies**

Add to the `<script>` imports in `App.svelte`:

```typescript
  import { refDisplayName, refType, sortRefsForRow } from './lib/ref-chips';
```

Delete the local `getRefType` (App.svelte:1459-1464) and `getRefDisplayName`
(App.svelte:1465-1470) — the imported versions replace them, and the logic now lives in a file the
coverage config reaches. Update the other call sites of those two functions (the working-changes
row and the commit detail header, if present) to the new names in the same edit.

- [ ] **Step 4: Restructure the row template**

Replace the `.col-message` block in the commit row (~1687-1692):

```svelte
                <div class="col-message">
                  <span class="commit-subject" title={node.subject}>{node.subject}</span>
                  {#if node.refs.length > 0}
                    <span class="ref-chips">
                      {#each sortRefsForRow(node.refs) as ref (ref)}
                        <span class="ref-badge ref-{refType(ref)}" title={refDisplayName(ref)}
                        >{refDisplayName(ref)}</span>
                      {/each}
                    </span>
                  {/if}
                </div>
```

- [ ] **Step 5: Update the CSS**

`.commit-row .col-message` — keep `flex: 1; min-width: 40px; padding-left: 8px; font-size: 13px;
display: flex; align-items: center; overflow: hidden;`, set `gap: 8px`, and drop
`white-space: nowrap` / `text-overflow: ellipsis` from the container (they belong to the leaves).

Then:

```css
  .commit-subject {
    flex: 1 1 auto;
    min-width: 0;            /* a flex item never ellipsises without this */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ref-chips {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 50%;          /* chips never starve the subject */
    display: flex;
    gap: 6px;
    overflow: hidden;
    justify-content: flex-end;
  }
```

In `.ref-badge`, change `flex-shrink: 0` to `flex-shrink: 1` and add
`max-width: 160px; overflow: hidden; text-overflow: ellipsis;`. Keep `white-space: nowrap`,
padding, radius, and the three colour variants untouched.

Add a `ref-remote` variant matching the existing `ref-branch` styling but using
`var(--vscode-descriptionForeground)` for the text, since `refType` now emits `remote`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/webview/graph-row-layout.test.ts tests/webview/app-toolbar.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/webview/App.svelte tests/webview/graph-row-layout.test.ts
git commit -m "feat(graph): right-align ref chips and ellipsise both row texts"
```

---

### Task D2: spinner in the progress banner

**Depends on:** C5

**Files:**
- Modify: `src/webview/App.svelte` (banner ~1471-1473, `runMutation` labels ~1075-1091)
- Modify: `src/webview/ReviewApp.svelte` (panel header)
- Test: `tests/webview/app-mutation-progress.test.ts` (extend)

**Interfaces:**
- Consumes: `LoadingSpinner`; existing `mutationProgress: string | null` and `MutationGate`

- [ ] **Step 1: Write the failing test**

Append to `tests/webview/app-mutation-progress.test.ts`:

```typescript
  it('shows a spinner while a mutation runs', async () => {
    const { container } = await startPendingMutation('Pushing to origin…');
    const banner = container.querySelector('.mutation-progress')!;
    expect(banner.textContent).toContain('Pushing to origin…');
    expect(banner.querySelector('[role="status"]')).not.toBeNull();
  });

  it('hides the spinner while waiting on the user', async () => {
    // Nothing is running during a confirmation prompt; a spinner there reads
    // as a hang.
    const { container } = await startPendingMutation('Awaiting confirmation…');
    const banner = container.querySelector('.mutation-progress')!;
    expect(banner.textContent).toContain('Awaiting confirmation…');
    expect(banner.querySelector('[role="status"]')).toBeNull();
  });
```

`startPendingMutation(label)` is a local helper that renders the app, triggers a context-menu
mutation whose bridge promise never resolves, and waits for `.mutation-progress` to show `label`.
Reuse the deferred-promise pattern already in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/webview/app-mutation-progress.test.ts`
Expected: FAIL — no element with `role="status"` inside the banner

- [ ] **Step 3: Render the spinner**

Import the component in `App.svelte`:

```typescript
  import LoadingSpinner from './components/common/LoadingSpinner.svelte';
```

Replace the banner:

```svelte
  {#if mutationProgress}
    <div class="mutation-progress" aria-live="polite">
      {#if mutationProgress !== AWAITING_CONFIRMATION_LABEL}
        <LoadingSpinner label={mutationProgress} />
      {/if}
      <span>{mutationProgress}</span>
    </div>
  {/if}
```

Introduce the constant next to the state declarations and use it in the two places that currently
inline the string (`mutationGate.updateLabel('Awaiting confirmation…')` and
`mutationProgress = 'Awaiting confirmation…'`, ~1083-1084):

```typescript
  const AWAITING_CONFIRMATION_LABEL = 'Awaiting confirmation…';
```

Add `display: flex; align-items: center; gap: 8px;` to the `.mutation-progress` rule.

- [ ] **Step 4: Confirm no label work is needed here**

`mutationLabels` (App.svelte:1030-1060) already maps every action to a specific label —
`push: 'Pushing…'`, `pull: 'Pulling…'`, `fetch: 'Fetching…'`, and so on. `Preparing…` is only the
brief state before `progress.start()` fires, not the label network operations run under. No
changes to this map belong in this task; the new actions added in D4 register their own labels
there.

- [ ] **Step 5: Add the review spinner**

`ReviewApp.svelte` already derives `hasRunning` (line 92) from
`reviews.some((r) => r.status === 'running')` and already branches on
`entry.status === 'running'` in the entry template (line 586), where it currently renders the `⟳`
glyph from `statusIcon` (line 387).

Import the component and use it in both places:

```svelte
  import LoadingSpinner from './components/common/LoadingSpinner.svelte';
```

In the panel header, next to the title:

```svelte
  {#if hasRunning}<LoadingSpinner label="Review running…" />{/if}
```

In the entry row, replace the static `⟳` for the running state with
`<LoadingSpinner label="Review running…" />`, leaving the other status glyphs untouched. Do not
add new state — `hasRunning` and `entry.status` already carry everything needed.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/webview/app-mutation-progress.test.ts tests/webview/review-app.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/webview/App.svelte src/webview/ReviewApp.svelte tests/webview/app-mutation-progress.test.ts
git commit -m "feat(ui): show a spinner while git and review work runs"
```

---

### Task D3: startup lifecycle fix

**Depends on:** B1, C4

**Files:**
- Modify: `src/webview/App.svelte` (`onMount` ~298-320, `refreshGraph` catch ~578-581, cleanup ~321-333)
- Test: `tests/webview/app-refresh-race.test.ts` (extend)

**Interfaces:**
- Consumes: `isSupersededError`, `createRefreshScheduler` from `src/webview/lib/graph-refresh`

- [ ] **Step 1: Write the failing test**

Append to `tests/webview/app-refresh-race.test.ts`:

```typescript
  it('does not surface a superseded build as a startup error', async () => {
    // invalidate() bumps the generation before the event is sent, so the very
    // first build can lose the race. That must not paint an error banner.
    send.mockImplementation((method: string) => {
      if (method === 'graph.build') {
        return Promise.reject(Object.assign(new Error('Graph build superseded'), {
          kind: 'GRAPH_BUILD_SUPERSEDED',
        }));
      }
      return defaultSend(method);
    });

    const { container } = render(App);
    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.build', expect.anything()));

    expect(container.querySelector('.error')).toBeNull();
    expect(container.textContent).not.toContain('Error');
  });

  it('subscribes to graph.invalidated before the first refresh', async () => {
    // An invalidation during startup must not be dropped, or the graph stays
    // stale until the next unrelated event.
    const order: string[] = [];
    on.mockImplementation((event: string) => { order.push(`on:${event}`); return () => {}; });
    send.mockImplementation((method: string) => {
      order.push(`send:${method}`);
      return defaultSend(method);
    });

    render(App);
    await waitFor(() => expect(order).toContain('send:graph.build'));

    expect(order.indexOf('on:graph.invalidated')).toBeLessThan(order.indexOf('send:graph.build'));
  });

  it('collapses a burst of invalidations into a single refresh', async () => {
    vi.useFakeTimers();
    try {
      let invalidate!: () => void;
      on.mockImplementation((event: string, handler: () => void) => {
        if (event === 'graph.invalidated') invalidate = handler;
        return () => {};
      });
      send.mockImplementation((method: string) => defaultSend(method));

      render(App);
      await vi.waitFor(() => expect(invalidate).toBeTypeOf('function'));
      const before = send.mock.calls.filter(([m]) => m === 'graph.build').length;

      invalidate(); invalidate(); invalidate();
      await vi.advanceTimersByTimeAsync(200);

      const after = send.mock.calls.filter(([m]) => m === 'graph.build').length;
      expect(after - before).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
```

`defaultSend` is a local helper returning the standard fixtures for `ping.hello`, `repo.list`,
`git.branches`, `git.tags`, `git.stashList`, `git.worktreeList`, `git.submoduleList`,
`git.status`, `graph.build`, `graph.getWindow`; factor it out of the existing setup in this file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/webview/app-refresh-race.test.ts`
Expected: FAIL — error banner appears, listener registers last, three builds fire

- [ ] **Step 3: Make supersede non-fatal in `refreshGraph`**

Import the helpers:

```typescript
  import { createRefreshScheduler, isSupersededError } from './lib/graph-refresh';
```

Change the `refreshGraph` catch (~578-581):

```typescript
    } catch (refreshError) {
      if (!graphRefreshGate.isLatest(refreshToken)) return;
      // A newer build is already on its way; dropping this result is correct.
      if (isSupersededError(refreshError)) return;
      throw refreshError;
    }
```

- [ ] **Step 4: Create the scheduler and register the listener first**

Above `onMount`, next to the other state:

```typescript
  const refreshScheduler = createRefreshScheduler({
    run: () => refreshGraph(),
    delayMs: 200,
    onError: (refreshError) => {
      if (isSupersededError(refreshError)) return;
      console.warn('[git-graph] graph refresh failed:', refreshError);
    },
  });
```

Rewrite the first `onMount` so the subscription happens before any awaiting:

```typescript
  onMount(async () => {
    // Subscribe first: an invalidation that lands mid-startup would otherwise
    // be dropped and leave the graph stale.
    const stopInvalidated = bridge.on('graph.invalidated', () => refreshScheduler.schedule());
    invalidatedUnsubscribe = stopInvalidated;

    try {
      await bridge.send('ping.hello');
      const repoResult = await bridge.send('repo.list') as RepoListResult;
      repos = repoResult.repos;
      workspaceSubmodules = repoResult.submodules ?? [];
      const active = repos.find((r) => r.active);
      activeRepoName = active?.name ?? repos[0]?.name ?? '';
      await loadFavourites(active?.path ?? repos[0]?.path);
      await loadSidebarState(active?.path ?? repos[0]?.path);
      await refreshGraph();
      await restorePanelState();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'Error';
    }
  });
```

Declare `let invalidatedUnsubscribe: (() => void) | undefined;` with the other state, and in the
existing cleanup return of the second `onMount` add:

```typescript
      refreshScheduler.cancel();
      invalidatedUnsubscribe?.();
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/webview/app-refresh-race.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/webview/App.svelte tests/webview/app-refresh-race.test.ts
git commit -m "fix(webview): stop startup errors from superseded graph builds"
```

---

### Task D4: new branch context-menu actions

**Depends on:** A1, A2, C3

**Files:**
- Modify: `src/webview/App.svelte` (`handleBranchContextMenu` ~793-860, branch actions in `handleContextMenuAction` ~1288-1355)
- Test: `tests/webview/app-branch-menu-actions.test.ts` (create)

**Interfaces:**
- Consumes: `resolvePullTarget`, `localNameFor` from `src/webview/lib/branch-menu`; methods `git.diffWorkingTree`, `git.createBranch`, `git.checkout`, `git.rebase`, `git.pull`

- [ ] **Step 1: Write the failing test**

Create `tests/webview/app-branch-menu-actions.test.ts`, reusing the bridge mock and
`openBranchContextMenu` interaction style from `tests/webview/app-delete-branch.test.ts`:

```typescript
  it('offers the new actions on a local branch with an upstream', async () => {
    const labels = await menuLabelsFor({
      name: 'develop', current: false, remote: null, upstream: 'origin/develop',
    });

    expect(labels).toContain("New Branch from 'develop'...");
    expect(labels).toContain("Checkout and Rebase onto 'main'");
    expect(labels).toContain('Show Diff with Working Tree');
    expect(labels).toContain("Rebase 'main' onto 'develop'");
    expect(labels).toContain("Pull into 'main' Using Rebase");
    expect(labels).toContain("Pull into 'main' Using Merge");
  });

  it('omits the pull actions when the branch has no upstream', async () => {
    const labels = await menuLabelsFor({
      name: 'spike', current: false, remote: null, upstream: null,
    });

    expect(labels).toContain("New Branch from 'spike'...");
    expect(labels.some((label) => label.startsWith('Pull into'))).toBe(false);
  });

  it('creates a local tracking branch before rebasing a remote branch', async () => {
    // git checkout origin/x detaches HEAD, which would make the rebase meaningless.
    const { send } = await runBranchAction(
      { name: 'origin/bugfix/RMS2025-1027', current: false, remote: 'origin', upstream: null },
      "Checkout and Rebase onto 'main'",
    );

    expect(send).toHaveBeenCalledWith('git.createBranch', {
      name: 'bugfix/RMS2025-1027', startPoint: 'origin/bugfix/RMS2025-1027',
    });
    expect(send).toHaveBeenCalledWith('git.checkout', { ref: 'bugfix/RMS2025-1027' });
    expect(send).toHaveBeenCalledWith('git.rebase', { onto: 'main' });
  });

  it('splits the remote and ref when pulling into the current branch', async () => {
    const { send } = await runBranchAction(
      { name: 'origin/bugfix/RMS2025-1027', current: false, remote: 'origin', upstream: null },
      "Pull into 'main' Using Rebase",
    );

    expect(send).toHaveBeenCalledWith('git.pull', {
      remote: 'origin', branch: 'bugfix/RMS2025-1027', options: { rebase: true },
    });
  });

  it('requests a working-tree diff for the selected branch', async () => {
    const { send } = await runBranchAction(
      { name: 'develop', current: false, remote: null, upstream: 'origin/develop' },
      'Show Diff with Working Tree',
    );

    expect(send).toHaveBeenCalledWith('git.diffWorkingTree', { ref: 'develop' });
  });
```

`menuLabelsFor(branch)` renders the app with `main` as the current branch plus the given branch,
fires a `contextmenu` on that branch row, and returns the visible menu labels.
`runBranchAction(branch, label)` does the same and then clicks the item with that label.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/webview/app-branch-menu-actions.test.ts`
Expected: FAIL — the new labels do not exist

- [ ] **Step 3: Build the new menu items**

Import the helper in `App.svelte`:

```typescript
  import { localNameFor, resolvePullTarget } from './lib/branch-menu';
```

In `handleBranchContextMenu`, compute once before the branches of the `if`:

```typescript
    const currentBranchName = branches.find((b) => b.current)?.name ?? 'HEAD';
    const pullTarget = resolvePullTarget(branch);
    const pullItems = pullTarget
      ? [
          { label: '', action: '', divider: true },
          { label: `Pull into '${currentBranchName}' Using Rebase`, action: 'pullIntoCurrentRebase' },
          { label: `Pull into '${currentBranchName}' Using Merge`, action: 'pullIntoCurrentMerge' },
        ]
      : [];
```

Remote branch menu:

```typescript
      contextMenuItems = [
        { label: 'Checkout', action: 'checkout' },
        { label: `New Branch from '${branch.name}'...`, action: 'newBranchFrom' },
        { label: '', action: '', divider: true },
        { label: `Checkout and Rebase onto '${currentBranchName}'`, action: 'checkoutAndRebase' },
        { label: '', action: '', divider: true },
        { label: `Compare with '${currentBranchName}'`, action: 'compareBranch' },
        { label: 'Show Diff with Working Tree', action: 'diffWorkingTree' },
        { label: '', action: '', divider: true },
        { label: `Rebase '${currentBranchName}' onto '${branch.name}'`, action: 'rebase' },
        { label: `Merge '${branch.name}' into '${currentBranchName}'`, action: 'merge' },
        ...pullItems,
        { label: '', action: '', divider: true },
        { label: 'Delete remote branch', action: 'deleteRemoteBranch', danger: true },
      ];
```

Local non-current menu — insert after the existing `Checkout` entry and replace the two generic
rebase/merge labels with the explicit ones:

```typescript
        { label: 'Checkout', action: 'checkout' },
        { label: `New Branch from '${branch.name}'...`, action: 'newBranchFrom' },
        ...(pullTarget
          ? [{ label: '', action: '', divider: true },
             { label: `Checkout and Rebase onto '${currentBranchName}'`, action: 'checkoutAndRebase' }]
          : []),
        { label: '', action: '', divider: true },
        { label: `Compare with '${currentBranchName}'`, action: 'compareBranch' },
        { label: 'Show Diff with Working Tree', action: 'diffWorkingTree' },
        { label: '', action: '', divider: true },
        { label: `Rebase '${currentBranchName}' onto '${branch.name}'`, action: 'rebase' },
        { label: `Merge '${branch.name}' into '${currentBranchName}'`, action: 'merge' },
        ...pullItems,
```

Keep the existing Push/Publish submenu, Fetch, Rename, and Delete entries below, and keep the
current-branch menu unchanged apart from adding `Show Diff with Working Tree`.

- [ ] **Step 4: Handle the new actions**

`contextMenuTarget` only carries a name, so re-resolve the branch object at action time. Add to
the `branch` arm of `handleContextMenuAction`:

```typescript
          case 'newBranchFrom': {
            const name = await bridge.send('ui.inputBox', {
              prompt: `New branch from '${branchName}':`,
              placeholder: 'feature/...',
            }) as string | null;
            if (name) await runMutation('git.createBranch', { name, startPoint: branchName });
            break;
          }
          case 'checkoutAndRebase': {
            const target = branches.find((b) => b.name === branchName);
            if (!target) break;
            const previousCurrent = branches.find((b) => b.current)?.name;
            if (!previousCurrent) break;

            const local = localNameFor(target);
            progress?.awaitConfirmation();
            const confirmed = await bridge.send('ui.confirm', {
              message: `Checkout '${local}' and rebase onto '${previousCurrent}'?`,
            }) as boolean;
            if (!confirmed) break;

            // A remote ref must become a local tracking branch first, or the
            // checkout detaches HEAD and the rebase has no branch to move.
            const localExists = branches.some((b) => !b.remote && b.name === local);
            if (!localExists) {
              await runMutation('git.createBranch', { name: local, startPoint: branchName });
            }
            await runMutation('git.checkout', { ref: local });
            await runMutation('git.rebase', { onto: previousCurrent });
            break;
          }
          case 'diffWorkingTree':
            await bridge.send('git.diffWorkingTree', { ref: branchName });
            break;
          case 'pullIntoCurrentRebase':
          case 'pullIntoCurrentMerge': {
            const target = branches.find((b) => b.name === branchName);
            const pull = target ? resolvePullTarget(target) : null;
            if (!pull) break;
            await runMutation('git.pull', {
              remote: pull.remote,
              branch: pull.ref,
              options: { rebase: action === 'pullIntoCurrentRebase' },
            });
            break;
          }
```

`runMutation` (App.svelte:1165-1168) is only `progress?.start()` plus `bridge.send(...)` — the
mutation gate is taken once by `handleContextMenuAction` around the whole action, so the three
sequential calls in `checkoutAndRebase` are safe as written. Await each one so a failed checkout
never proceeds to the rebase.

- [ ] **Step 5: Register labels for the new actions**

`handleContextMenuAction` looks up `mutationLabels[action]` (App.svelte:1030-1060, 1068) and only
runs an action through the gate when a label exists. Add the four mutating actions to that map:

```typescript
    newBranchFrom: 'Creating branch…',
    checkoutAndRebase: 'Checking out and rebasing…',
    pullIntoCurrentRebase: 'Pulling…',
    pullIntoCurrentMerge: 'Pulling…',
```

Leave `diffWorkingTree` **out** of the map: it reads, it does not mutate, so it must not take the
mutation gate or paint the progress banner.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/webview/app-branch-menu-actions.test.ts tests/webview/app-delete-branch.test.ts tests/webview/app-sidebar-actions.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/webview/App.svelte tests/webview/app-branch-menu-actions.test.ts
git commit -m "feat(sidebar): add branch menu actions for new branch, rebase, pull and diff"
```

---

### Task D5: commit search in the toolbar

**Depends on:** A1, C2, C5

**Files:**
- Create: `src/webview/components/toolbar/CommitSearch.svelte`
- Modify: `src/webview/App.svelte` (toolbar ~1509-1525, row highlight classes ~1673-1682, CSS)
- Test: `tests/webview/commit-search-ui.test.ts` (create)

**Interfaces:**
- Consumes: `classifyQuery`, `nextMatchIndex`, `formatMatchCounter`; `LoadingSpinner`; methods `git.searchCommits`, `graph.getRow`
- Produces: `CommitSearch` events `search` (`{ query: string }`), `navigate` (`{ direction: 1 | -1 }`), `clear`

- [ ] **Step 1: Write the failing test**

Create `tests/webview/commit-search-ui.test.ts`:

```typescript
  it('stays collapsed until the search button is pressed', async () => {
    const { getByLabelText, queryByPlaceholderText } = await renderApp();
    expect(queryByPlaceholderText('Search commit message or hash...')).toBeNull();

    await fireEvent.click(getByLabelText('Search commits'));
    expect(queryByPlaceholderText('Search commit message or hash...')).not.toBeNull();
  });

  it('debounces typing into a single search request', async () => {
    vi.useFakeTimers();
    try {
      const { getByLabelText, getByPlaceholderText, send } = await renderApp();
      await fireEvent.click(getByLabelText('Search commits'));
      const input = getByPlaceholderText('Search commit message or hash...');

      await fireEvent.input(input, { target: { value: 'fi' } });
      await fireEvent.input(input, { target: { value: 'fix' } });
      await fireEvent.input(input, { target: { value: 'fix l' } });
      await vi.advanceTimersByTimeAsync(300);

      const searches = send.mock.calls.filter(([m]) => m === 'git.searchCommits');
      expect(searches).toHaveLength(1);
      expect(searches[0][1]).toEqual({ query: 'fix l' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolls to the matched row and shows the match counter', async () => {
    const { search, send, container } = await searchFor('fix', {
      hashes: ['a'.repeat(40), 'b'.repeat(40)],
      rows: { ['a'.repeat(40)]: 12, ['b'.repeat(40)]: 40 },
    });

    expect(send).toHaveBeenCalledWith('graph.getRow', { hash: 'a'.repeat(40), layoutVersion: 1 });
    expect(search.textContent).toContain('1/2');
    // The row is centred, matching the existing sidebar branch-select behaviour.
    expect((container.querySelector('.scroll-area') as HTMLElement).scrollTop)
      .toBe(Math.max(0, 12 * ROW_HEIGHT - Math.floor(DEFAULT_VIEWPORT_HEIGHT / 2)));
  });

  it('cycles to the next match and wraps', async () => {
    const { getByLabelText, send } = await searchFor('fix', {
      hashes: ['a'.repeat(40), 'b'.repeat(40)],
      rows: { ['a'.repeat(40)]: 12, ['b'.repeat(40)]: 40 },
    });

    await fireEvent.click(getByLabelText('Next match'));
    expect(send).toHaveBeenCalledWith('graph.getRow', { hash: 'b'.repeat(40), layoutVersion: 1 });

    await fireEvent.click(getByLabelText('Next match'));
    expect(send).toHaveBeenLastCalledWith('graph.getRow', { hash: 'a'.repeat(40), layoutVersion: 1 });
  });

  it('reports when nothing matches', async () => {
    const { search } = await searchFor('nothing', { hashes: [], rows: {} });
    expect(search.textContent).toContain('No commits found');
  });

  it('explains when the match is filtered out of the graph', async () => {
    const { search } = await searchFor('fix', {
      hashes: ['a'.repeat(40)],
      rows: { ['a'.repeat(40)]: null },
    });
    expect(search.textContent).toContain('outside the current branch filter');
  });

  it('clears results and highlight on Escape', async () => {
    const { getByPlaceholderText, container } = await searchFor('fix', {
      hashes: ['a'.repeat(40)],
      rows: { ['a'.repeat(40)]: 0 },
    });

    await fireEvent.keyDown(getByPlaceholderText('Search commit message or hash...'), { key: 'Escape' });
    expect(container.querySelector('.search-match')).toBeNull();
  });
```

`renderApp` mounts `App.svelte` with the standard bridge fixtures; `searchFor(query, fixtures)`
expands the search, types the query, flushes the debounce, and returns the search container plus
the `send` spy. `ROW_HEIGHT` is imported from `src/webview/lib/virtual-scroll`, and
`DEFAULT_VIEWPORT_HEIGHT` is the `window.innerHeight` jsdom reports for the render (declare it as
a local constant and set `window.innerHeight` to it before rendering, as
`tests/webview/app-panel-layout.test.ts` already does).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/webview/commit-search-ui.test.ts`
Expected: FAIL — no `Search commits` control exists

- [ ] **Step 3: Build the component**

Create `src/webview/components/toolbar/CommitSearch.svelte`:

```svelte
<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Icon from '../common/Icon.svelte';
  import LoadingSpinner from '../common/LoadingSpinner.svelte';
  import { formatMatchCounter } from '../../lib/commit-search';

  export let expanded = false;
  export let searching = false;
  export let total = 0;
  export let activeIndex = 0;
  export let message = '';

  const dispatch = createEventDispatcher<{
    search: { query: string };
    navigate: { direction: 1 | -1 };
    clear: void;
  }>();

  let query = '';
  let input: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const DEBOUNCE_MS = 300;

  $: counter = formatMatchCounter(total, activeIndex);

  export function focusInput(): void {
    input?.focus();
    input?.select();
  }

  function onInput(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => dispatch('search', { query }), DEBOUNCE_MS);
  }

  function reset(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    query = '';
    dispatch('clear');
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); reset(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      dispatch('navigate', { direction: event.shiftKey ? -1 : 1 });
    }
  }

  onDestroy(() => { if (debounceTimer !== undefined) clearTimeout(debounceTimer); });
</script>

{#if expanded}
  <div class="commit-search" role="search">
    <span class="search-glyph">
      {#if searching}<LoadingSpinner label="Searching commits…" />{:else}<Icon name="search" />{/if}
    </span>
    <input
      bind:this={input}
      bind:value={query}
      type="text"
      placeholder="Search commit message or hash..."
      aria-label="Search commits"
      on:input={onInput}
      on:keydown={onKeydown}
    />
    {#if counter}<span class="search-counter">{counter}</span>{/if}
    {#if message}<span class="search-message">{message}</span>{/if}
    <button type="button" aria-label="Previous match" disabled={total < 2}
            on:click={() => dispatch('navigate', { direction: -1 })}
    ><Icon name="arrow-small-up" /></button>
    <button type="button" aria-label="Next match" disabled={total < 2}
            on:click={() => dispatch('navigate', { direction: 1 })}
    ><Icon name="arrow-small-down" /></button>
    <button type="button" aria-label="Clear search" on:click={reset}><Icon name="close" /></button>
  </div>
{/if}
```

Style `.commit-search` as a flex row matching the existing `.toolbar-group` conventions.

- [ ] **Step 4: Wire it into `App.svelte`**

Add state and handlers:

```typescript
  import CommitSearch from './components/toolbar/CommitSearch.svelte';
  import { classifyQuery, nextMatchIndex } from './lib/commit-search';

  let searchExpanded = false;
  let searching = false;
  let searchHashes: string[] = [];
  let searchActiveIndex = 0;
  let searchMessage = '';
  let searchComponent: CommitSearch | undefined;
  const searchGate = new LatestRequestGate();

  $: searchMatchSet = new Set(searchHashes);
  $: activeSearchHash = searchHashes[searchActiveIndex] ?? null;

  async function handleCommitSearch(event: CustomEvent<{ query: string }>) {
    const { query } = event.detail;
    if (classifyQuery(query) === 'empty') { clearCommitSearch(); return; }

    const token = searchGate.issue();
    searching = true;
    searchMessage = '';
    try {
      const hashes = await bridge.send('git.searchCommits', { query }) as string[];
      if (!searchGate.isLatest(token)) return;
      searchHashes = hashes;
      searchActiveIndex = 0;
      if (hashes.length === 0) { searchMessage = 'No commits found'; return; }
      await revealSearchMatch();
    } catch (searchError) {
      if (!searchGate.isLatest(token)) return;
      searchHashes = [];
      searchMessage = searchError instanceof Error ? searchError.message : String(searchError);
    } finally {
      if (searchGate.isLatest(token)) searching = false;
    }
  }

  async function revealSearchMatch() {
    const hash = activeSearchHash;
    const requestedLayoutVersion = layoutVersion;
    if (hash === null || requestedLayoutVersion === null || !scrollContainer) return;
    try {
      const result = await bridge.send('graph.getRow', {
        hash, layoutVersion: requestedLayoutVersion,
      }) as { row: number | null };
      if (requestedLayoutVersion !== layoutVersion) return;
      if (result.row === null) {
        searchMessage = 'Commit is outside the current branch filter';
        return;
      }
      searchMessage = '';
      await scrollToGraphRow(result.row);
    } catch {
      // A layout change invalidated the lookup; the next search starts clean.
      clearCommitSearch();
    }
  }
```

`handleBranchSelect` (App.svelte:974-1005) already contains the exact scroll-to-row sequence:
working-row offset, centring on the viewport, assigning both `scrollTop` and
`scrollContainer.scrollTop`, then `updateGraphWindow`. Extract that block into a shared function
and call it from both places rather than writing a second copy:

```typescript
  async function scrollToGraphRow(row: number) {
    if (!scrollContainer) return;
    const workingRowOffset = hasWorkingChanges ? 1 : 0;
    const targetTop = (row + workingRowOffset) * ROW_HEIGHT;
    const nextScrollTop = Math.max(0, targetTop - Math.floor(viewportHeight / 2));
    scrollTop = nextScrollTop;
    scrollContainer.scrollTop = nextScrollTop;
    await updateGraphWindow(
      calculateVisibleRange({ scrollTop, viewportHeight, totalRows }),
      graphWindow,
    );
  }
```

In `handleBranchSelect`, replace those lines with `await scrollToGraphRow(result.row);`, keeping
its surrounding highlight bookkeeping (`clearBranchHighlight`, `selectedSidebarBranch`,
`focusedBranchHash`, `scheduleBranchHighlightClear`) untouched.

  function handleSearchNavigate(event: CustomEvent<{ direction: 1 | -1 }>) {
    if (searchHashes.length === 0) return;
    searchActiveIndex = nextMatchIndex(searchHashes.length, searchActiveIndex, event.detail.direction);
    void revealSearchMatch();
  }

  function clearCommitSearch() {
    searchGate.issue();
    searchHashes = [];
    searchActiveIndex = 0;
    searchMessage = '';
    searching = false;
  }
```

Render in the toolbar next to the `.status` span:

```svelte
    <button
      class="toolbar-icon-btn"
      aria-label="Search commits"
      aria-pressed={searchExpanded}
      title="Search commits (Ctrl+F)"
      on:click={toggleCommitSearch}
    ><Icon name="search" /></button>
    <CommitSearch
      bind:this={searchComponent}
      expanded={searchExpanded}
      {searching}
      total={searchHashes.length}
      activeIndex={searchActiveIndex}
      message={searchMessage}
      on:search={handleCommitSearch}
      on:navigate={handleSearchNavigate}
      on:clear={() => { clearCommitSearch(); searchExpanded = false; }}
    />
```

`toggleCommitSearch` flips `searchExpanded`, clears results when collapsing, and calls
`await tick()` then `searchComponent?.focusInput()` when expanding.

Bind the shortcut in the existing window `keydown` handling (the graph view is a `WebviewView`,
so VS Code's find widget is not in play):

```typescript
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      void toggleCommitSearch();
    }
```

Add the highlight classes to the commit row element:

```svelte
                class:search-match={searchMatchSet.has(node.hash)}
                class:search-match-active={activeSearchHash === node.hash}
```

```css
  .commit-row.search-match {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  }

  .commit-row.search-match-active {
    background: var(--vscode-editor-findMatchBackground, rgba(234, 92, 0, 0.56));
  }
```

Clear search state whenever the layout changes, so row indexes never outlive their layout. In
`refreshGraph`, after `layoutVersion = build.layoutVersion;`, add
`if (searchHashes.length > 0) clearCommitSearch();`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/webview/commit-search-ui.test.ts tests/webview/app-toolbar.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/toolbar/CommitSearch.svelte src/webview/App.svelte tests/webview/commit-search-ui.test.ts
git commit -m "feat(graph): search commits by message or hash from the toolbar"
```

---

### Task D6: multi-branch filter dropdown

**Depends on:** A3, C3

**Files:**
- Create: `src/webview/components/toolbar/BranchFilterDropdown.svelte`
- Modify: `src/webview/App.svelte` (filter `<select>` ~1509-1525, `selectedBranchFilter` state, `refreshGraph` build params ~538-540 and status ~575-577)
- Test: `tests/webview/branch-filter-dropdown.test.ts` (create)

**Interfaces:**
- Consumes: `formatBranchFilterLabel`, `formatFilterStatus`; `graph.build` with `{ branches: string[] }`
- Produces: `BranchFilterDropdown` event `change` (`{ selected: string[] }`)

- [ ] **Step 1: Write the failing test**

Create `tests/webview/branch-filter-dropdown.test.ts`:

```typescript
  it('starts on All branches and builds the graph unfiltered', async () => {
    const { getByLabelText, send } = await renderApp();
    expect(getByLabelText('Filter graph by branch').textContent).toContain('All branches');
    expect(send).toHaveBeenCalledWith('graph.build', { all: true });
  });

  it('sends every checked branch to graph.build', async () => {
    const { getByLabelText, getByRole, send } = await renderApp({
      branches: ['main', 'develop', 'feature/x'],
    });

    await fireEvent.click(getByLabelText('Filter graph by branch'));
    await fireEvent.click(getByRole('checkbox', { name: 'develop' }));
    await fireEvent.click(getByRole('checkbox', { name: 'feature/x' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.build', {
      branches: ['develop', 'feature/x'], all: false,
    }));
  });

  it('summarises a multi-branch selection on the trigger and in the status', async () => {
    const { getByLabelText, container } = await selectBranches(['develop', 'feature/x']);
    expect(getByLabelText('Filter graph by branch').textContent).toContain('2 branches');
    expect(container.querySelector('.status')!.textContent).toContain('commits on 2 branches');
  });

  it('clears back to all branches', async () => {
    const { getByRole, send } = await selectBranches(['develop']);
    await fireEvent.click(getByRole('button', { name: 'Clear All' }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith('graph.build', { all: true }));
  });

  it('filters the branch list inside the dropdown', async () => {
    const { getByLabelText, getByPlaceholderText, queryByRole } = await renderApp({
      branches: ['main', 'develop', 'feature/x'],
    });

    await fireEvent.click(getByLabelText('Filter graph by branch'));
    await fireEvent.input(getByPlaceholderText('Filter branches'), { target: { value: 'feat' } });

    expect(queryByRole('checkbox', { name: 'feature/x' })).not.toBeNull();
    expect(queryByRole('checkbox', { name: 'main' })).toBeNull();
  });

  it('closes on Escape', async () => {
    const { getByLabelText, queryByPlaceholderText } = await renderApp();
    const trigger = getByLabelText('Filter graph by branch');

    await fireEvent.click(trigger);
    await fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(queryByPlaceholderText('Filter branches')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/webview/branch-filter-dropdown.test.ts`
Expected: FAIL — the filter is still a native `<select>`

- [ ] **Step 3: Build the component**

Create `src/webview/components/toolbar/BranchFilterDropdown.svelte`:

```svelte
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../common/Icon.svelte';
  import { formatBranchFilterLabel } from '../../lib/branch-menu';

  export let branches: Array<{ name: string }> = [];
  export let selected: string[] = [];

  const dispatch = createEventDispatcher<{ change: { selected: string[] } }>();

  let open = false;
  let filter = '';

  $: label = formatBranchFilterLabel(selected);
  $: visible = filter.trim() === ''
    ? branches
    : branches.filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase()));

  function toggle(name: string): void {
    const next = selected.includes(name)
      ? selected.filter((entry) => entry !== name)
      : [...selected, name];
    dispatch('change', { selected: next });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) { event.preventDefault(); open = false; }
  }
</script>

<svelte:window on:click={(event) => {
  if (open && !(event.target as HTMLElement).closest('.branch-filter')) open = false;
}} />

<div class="branch-filter" on:keydown={onKeydown}>
  <button
    type="button"
    class="toolbar-select branch-filter-trigger"
    aria-label="Filter graph by branch"
    aria-expanded={open}
    on:click|stopPropagation={() => { open = !open; }}
  >
    <Icon name="filter" />
    <span>{label}</span>
  </button>

  {#if open}
    <div class="branch-filter-menu" role="group" aria-label="Branches">
      <input type="text" placeholder="Filter branches" aria-label="Filter branches" bind:value={filter} />
      <div class="branch-filter-actions">
        <button type="button" on:click={() => dispatch('change', { selected: visible.map((b) => b.name) })}>Select All</button>
        <button type="button" on:click={() => dispatch('change', { selected: [] })}>Clear All</button>
      </div>
      <ul>
        {#each visible as branch (branch.name)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(branch.name)}
                on:change={() => toggle(branch.name)}
              />
              <span class="branch-filter-name">{branch.name}</span>
            </label>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
```

Give the checkbox its accessible name through the wrapping `<label>` so
`getByRole('checkbox', { name: 'develop' })` resolves. Style `.branch-filter-menu` as an absolutely
positioned popover with `max-height: 320px; overflow: auto;`, matching the existing sidebar
popover conventions.

- [ ] **Step 4: Switch `App.svelte` to multi-select**

Replace the state:

```typescript
  let selectedBranchFilters: string[] = [];
```

Remove `selectedBranchFilter` and update every reader. In `refreshGraph`:

```typescript
    const branchFilters = selectedBranchFilters;
    ...
        bridge.send('graph.build', branchFilters.length > 0
          ? { branches: branchFilters, all: false }
          : { all: true }) as Promise<{ ... }>,
```

and the status line:

```typescript
      status = formatFilterStatus(build.totalRows, branchFilters, nextBranches.length);
```

Replace the `<select class="toolbar-select graph-branch-filter">` block with:

```svelte
      <BranchFilterDropdown
        branches={branches.map((branch) => ({ name: branch.name }))}
        selected={selectedBranchFilters}
        on:change={(event) => handleGraphBranchFilters(event.detail.selected)}
      />
```

Add the handler and update the single-branch entry point:

```typescript
  async function handleGraphBranchFilters(selected: string[]) {
    selectedBranchFilters = selected;
    await refreshGraph();
  }
```

`handleGraphBranchFilter(name)` is still called by the double-click-to-focus flow; keep it and
make it delegate: `await handleGraphBranchFilters(name ? [name] : []);`. Also import the label
helper: `import { formatBranchFilterLabel, formatFilterStatus } from './lib/branch-menu';`
(`formatBranchFilterLabel` is used by the dropdown, `formatFilterStatus` by the status line).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/webview/branch-filter-dropdown.test.ts tests/webview/app-toolbar.test.ts tests/webview/app-refresh-race.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Full verification**

Run: `npm run check`
Expected: tests pass, coverage thresholds met, typecheck clean, build succeeds

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/toolbar/BranchFilterDropdown.svelte src/webview/App.svelte tests/webview/branch-filter-dropdown.test.ts
git commit -m "feat(graph): filter the graph by multiple branches"
```

---

## Manual Verification

After D6, run the extension (`npm run dev`, then F5) and confirm:

1. Right-click a remote branch — all six new items appear with the correct branch names quoted.
2. `Checkout and Rebase onto '<current>'` on a remote branch leaves you on a **local** branch
   (`git status` shows a branch, not detached HEAD).
3. Push a branch — the banner shows a spinner and `Pushing…`, and the spinner disappears on
   completion and on failure.
4. Trigger a confirmation dialog — the banner shows `Awaiting confirmation…` with **no** spinner.
5. Open the panel on a busy repo — no error banner, no repeated console errors in the webview
   DevTools.
6. `Ctrl/Cmd+F`, search a commit subject and a short hash — the graph scrolls to the match and
   highlights it; `Enter` cycles matches.
7. Select two branches in the filter — the trigger reads `2 branches`, the status reads
   `N commits on 2 branches`, and the graph shows both branches' commits.
8. Narrow the panel — the subject and the chips both ellipsise, chips stay pinned right, and the
   HEAD chip is the last one to disappear.
