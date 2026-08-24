# Review Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Review tab with 3 distinct modes (1 Commit, 2 Commits, 2 Branches), combobox inputs with dropdown suggestions, a repo picker, and rate-limit detection.

**Architecture:** Single-component rewrite of `ReviewApp.svelte` with a new reusable `Combobox.svelte`. Host adds two new messages (`review.getRepos`, `review.getCommits`). Rate-limit detection added to `AIReviewService`. Graph context menu gains a "Review with selected" item.

**Tech Stack:** Svelte 4, TypeScript, Vitest, @testing-library/svelte

## Global Constraints

- All tests run via `npx vitest run` and must pass
- TypeScript strict: `npx tsc --noEmit` must pass
- Build: `npm run build` must succeed
- Existing review.* host messages remain backward-compatible
- Combobox keyboard nav must be ARIA-compliant (role=combobox, aria-expanded, aria-activedescendant)

---

### Task 1: Combobox.svelte Component

**Files:**
- Create: `src/webview/components/Combobox.svelte`
- Create: `tests/webview/combobox.test.ts`

**Interfaces:**
- Consumes: nothing (standalone component)
- Produces: `<Combobox items={items} bind:value={v} placeholder="..." aria-label="..." on:select />`
  - Props: `items: Array<{ label: string; value: string; detail?: string }>`, `value: string`, `placeholder: string`, `aria-label: string`
  - Events: `select` (detail: `{ value: string }`), `input`, `blur`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/webview/combobox.test.ts
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Combobox from '../../src/webview/components/Combobox.svelte';

afterEach(cleanup);

const items = [
  { label: 'main', value: 'main' },
  { label: 'feat/login', value: 'feat/login' },
  { label: 'fix/bug-42', value: 'fix/bug-42' },
];

describe('Combobox', () => {
  it('shows dropdown on focus with all items', async () => {
    const { getByRole, getAllByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    const options = getAllByRole('option');
    expect(options).toHaveLength(3);
  });

  it('filters items as user types', async () => {
    const { getByRole, getAllByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'feat' } });
    const options = getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('feat/login');
  });

  it('selects item on click and closes dropdown', async () => {
    const { getByRole, getAllByRole, queryAllByRole, component } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const selected: string[] = [];
    component.$on('select', (e: CustomEvent) => selected.push(e.detail.value));
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    const options = getAllByRole('option');
    await fireEvent.click(options[1]);
    expect(selected).toEqual(['feat/login']);
    expect(queryAllByRole('option')).toHaveLength(0);
  });

  it('navigates with arrow keys and selects with Enter', async () => {
    const { getByRole, component } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const selected: string[] = [];
    component.$on('select', (e: CustomEvent) => selected.push(e.detail.value));
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(selected).toEqual(['feat/login']);
  });

  it('closes dropdown on Escape', async () => {
    const { getByRole, queryAllByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    expect(queryAllByRole('option').length).toBeGreaterThan(0);
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(queryAllByRole('option')).toHaveLength(0);
  });

  it('allows free text entry without selecting from list', async () => {
    const { getByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox') as HTMLInputElement;
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'abc1234' } });
    await fireEvent.blur(input);
    expect(input.value).toBe('abc1234');
  });

  it('sets aria-expanded and aria-activedescendant correctly', async () => {
    const { getByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.focus(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/webview/combobox.test.ts`
Expected: FAIL — cannot resolve Combobox.svelte

- [ ] **Step 3: Implement Combobox.svelte**

```svelte
<!-- src/webview/components/Combobox.svelte -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let items: Array<{ label: string; value: string; detail?: string }> = [];
  export let value = '';
  export let placeholder = '';

  const dispatch = createEventDispatcher<{
    select: { value: string };
    input: { value: string };
    blur: { value: string };
  }>();

  let open = false;
  let highlightIndex = -1;
  let inputEl: HTMLInputElement;

  $: filtered = value
    ? items.filter(item =>
        item.label.toLowerCase().includes(value.toLowerCase()) ||
        item.value.toLowerCase().includes(value.toLowerCase())
      )
    : items;

  $: capped = filtered.slice(0, 50);

  function handleFocus() {
    open = true;
    highlightIndex = -1;
  }

  function handleInput(e: Event) {
    value = (e.target as HTMLInputElement).value;
    open = true;
    highlightIndex = -1;
    dispatch('input', { value });
  }

  function handleBlur() {
    // Delay to allow click on option to fire first
    setTimeout(() => {
      open = false;
      highlightIndex = -1;
      dispatch('blur', { value });
    }, 150);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!open && e.key !== 'Escape') {
      open = true;
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        highlightIndex = Math.min(highlightIndex + 1, capped.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        highlightIndex = Math.max(highlightIndex - 1, 0);
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < capped.length) {
          selectItem(capped[highlightIndex]);
        }
        break;
      case 'Escape':
        open = false;
        highlightIndex = -1;
        break;
    }
  }

  function selectItem(item: { label: string; value: string }) {
    value = item.value;
    open = false;
    highlightIndex = -1;
    dispatch('select', { value: item.value });
  }

  $: activeDescendant = highlightIndex >= 0 ? `combobox-option-${highlightIndex}` : undefined;
</script>

<div class="combobox-wrapper">
  <input
    bind:this={inputEl}
    type="text"
    role="combobox"
    aria-expanded={open}
    aria-activedescendant={activeDescendant}
    aria-autocomplete="list"
    aria-controls="combobox-listbox"
    {placeholder}
    {value}
    on:focus={handleFocus}
    on:blur={handleBlur}
    on:input={handleInput}
    on:keydown={handleKeyDown}
  />
  {#if open && capped.length > 0}
    <ul id="combobox-listbox" role="listbox" class="dropdown">
      {#each capped as item, i (item.value)}
        <li
          id="combobox-option-{i}"
          role="option"
          class="option"
          class:highlighted={i === highlightIndex}
          aria-selected={i === highlightIndex}
          on:mousedown|preventDefault={() => selectItem(item)}
        >
          <span class="option-label">{item.label}</span>
          {#if item.detail}<span class="option-detail">{item.detail}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .combobox-wrapper { position: relative; display: inline-block; width: 100%; }
  input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 3px 6px;
    font-size: 12px;
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    max-height: 200px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 2px;
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
    z-index: 100;
  }
  .option {
    padding: 3px 6px;
    cursor: pointer;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .option:hover, .option.highlighted {
    background: var(--vscode-list-hoverBackground);
  }
  .option-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .option-detail { opacity: 0.7; font-size: 11px; flex: none; }
</style>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webview/combobox.test.ts`
Expected: all 7 tests PASS

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/Combobox.svelte tests/webview/combobox.test.ts
git commit -m "feat(review): add reusable Combobox component with filter and keyboard nav"
```

---

### Task 2: Host messages — review.getRepos and review.getCommits

**Files:**
- Modify: `src/extension/controllers/review-method-handler.ts`
- Create: `tests/extension/review-namespace.test.ts` (add cases to existing)
- Modify: `src/extension/controllers/repository-session.ts` (expose repos for review handler)

**Interfaces:**
- Consumes: `RepositorySession.repositories` (list of repos), `GitService.log()` (commit list)
- Produces:
  - `review.getRepos` → `Array<{ path: string; name: string; active: boolean }>`
  - `review.getCommits` → `Array<{ hash: string; abbreviatedHash: string; subject: string; authorDate: string }>`

- [ ] **Step 1: Write failing tests**

Add to `tests/extension/review-namespace.test.ts`:

```typescript
it('review.getRepos returns all repos with active flag', async () => {
  const { handler } = harness();
  const result = await handler('review.getRepos', {});
  expect(result).toEqual([
    expect.objectContaining({ name: expect.any(String), path: expect.any(String), active: expect.any(Boolean) }),
  ]);
});

it('review.getCommits returns recent commits', async () => {
  const { handler, git } = harness();
  git.log.mockResolvedValue([
    { hash: 'a'.repeat(40), abbreviatedHash: 'aaaaaaa', subject: 'First', authorDate: '2026-08-24T00:00:00Z', parents: [], author: 'A', authorEmail: '', committer: '', committerEmail: '', committerDate: '', message: '', refs: [] },
  ]);
  const result = await handler('review.getCommits', { limit: 50 });
  expect(result).toEqual([
    { hash: 'a'.repeat(40), abbreviatedHash: 'aaaaaaa', subject: 'First', authorDate: '2026-08-24T00:00:00Z' },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/review-namespace.test.ts`
Expected: FAIL — unknown method

- [ ] **Step 3: Add `review.getRepos` and `review.getCommits` to review-method-handler**

In `src/extension/controllers/review-method-handler.ts`, add to `ReviewHandlerDeps`:

```typescript
getRepos: () => Array<{ path: string; name: string; active: boolean }>;
```

Add cases:

```typescript
case 'review.getRepos':
  return deps.getRepos();

case 'review.getCommits': {
  const git = deps.getGitService();
  if (!git) throw new Error('No git repository found');
  const limit = typeof p.limit === 'number' ? p.limit : 100;
  const commits = await git.log({ maxCount: limit });
  return commits.map(c => ({
    hash: c.hash,
    abbreviatedHash: c.abbreviatedHash,
    subject: c.subject,
    authorDate: c.authorDate,
  }));
}
```

- [ ] **Step 4: Wire getRepos in the activation site**

Where `createReviewHandler` is called (likely `extension.ts` or a wiring module), pass `getRepos` that reads from `RepositorySession`:

```typescript
getRepos: () => session.repositories.map(r => ({
  ...r,
  active: r.path === session.getCurrentRepository()?.path,
})),
```

Expose `repositories` as a public getter on `RepositorySession`:

```typescript
public getRepositories(): readonly RepositoryInfo[] {
  return this.repositories;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/extension/review-namespace.test.ts`
Expected: PASS

- [ ] **Step 6: TypeScript check and commit**

Run: `npx tsc --noEmit`

```bash
git add src/extension/controllers/review-method-handler.ts src/extension/controllers/repository-session.ts tests/extension/review-namespace.test.ts
git commit -m "feat(review): add review.getRepos and review.getCommits host messages"
```

---

### Task 3: Rate-limit detection in AIReviewService

**Files:**
- Modify: `src/extension/services/ai-review.service.ts`
- Modify: `tests/extension/ai-review-stream.test.ts` (add rate-limit test cases)

**Interfaces:**
- Consumes: CLI stdout (string)
- Produces: throws `Error` with rate-limit message when detected (instead of returning garbage content)

- [ ] **Step 1: Write failing tests**

Add to `tests/extension/ai-review-stream.test.ts`:

```typescript
describe('rate-limit detection', () => {
  it('rejects with a rate-limit error when CLI returns a short quota message', async () => {
    // Mock the spawn to emit the rate-limit message and exit 0
    const service = createTestService();
    mockSpawn({ stdout: "You've hit your session limit · resets 2:40am (Asia/Saigon)\n", exitCode: 0 });

    await expect(service.review({
      diff: 'some diff',
      provider: 'claude',
    })).rejects.toThrow(/session limit/i);
  });

  it('does not flag a long review that happens to mention rate limit', async () => {
    const service = createTestService();
    const longReview = '# Review\n'.repeat(100) + 'Note: watch for rate limit issues in production\n';
    mockSpawn({ stdout: longReview, exitCode: 0 });

    const result = await service.review({ diff: 'diff', provider: 'claude' });
    expect(result.content).toContain('# Review');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/ai-review-stream.test.ts -t "rate-limit"`
Expected: FAIL — the service resolves instead of rejecting

- [ ] **Step 3: Implement rate-limit detection**

In `src/extension/services/ai-review.service.ts`, add after the `review()` method assembles `content`:

```typescript
private detectRateLimit(output: string): string | null {
  // Real reviews are substantially longer than a one-line error.
  if (output.length > 500) return null;
  const patterns = [
    /session limit/i,
    /rate limit/i,
    /too many requests/i,
    /quota exceeded/i,
    /resets? \d/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(output)) return output.trim();
  }
  return null;
}
```

Call it in `review()` after getting `content` from the provider:

```typescript
const rateLimitMsg = this.detectRateLimit(content);
if (rateLimitMsg) {
  throw new Error(`AI provider rate-limited: ${rateLimitMsg}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/ai-review-stream.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/ai-review.service.ts tests/extension/ai-review-stream.test.ts
git commit -m "fix(review): detect CLI rate-limit responses and fail the entry instead of saving garbage"
```

---

### Task 4: Graph context menu — "Review with selected"

**Files:**
- Modify: `src/webview/App.svelte` (context menu items + handler)
- Modify: `tests/webview/app-review-jobs.test.ts` (add test)

**Interfaces:**
- Consumes: existing `selectedForCompare` state, existing `bridge.send('review.setTarget', ...)`
- Produces: new menu item "Review with selected [hash7]" that sends `review.setTarget` with `kind: 'range'`

- [ ] **Step 1: Write failing test**

Add to `tests/webview/app-review-jobs.test.ts`:

```typescript
it('"Review with selected" sends a range target using the previously selected commit', async () => {
  stubApp();
  const rendered = render(App);

  // First: select a commit for compare
  await contextMenuOnCommit(rendered, 'first');
  await waitFor(() => expect(rendered.getByRole('menuitem', { name: 'Select for compare' })).toBeInTheDocument());
  await fireEvent.click(rendered.getByRole('menuitem', { name: 'Select for compare' }));

  // Second: right-click another commit — should show "Review with selected"
  await contextMenuOnCommit(rendered, 'second');
  await waitFor(() => expect(rendered.getByRole('menuitem', { name: /Review with selected/ })).toBeInTheDocument());
  await fireEvent.click(rendered.getByRole('menuitem', { name: /Review with selected/ }));

  await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
    kind: 'range', baseRef: SHA_1, headRef: SHA_2,
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/app-review-jobs.test.ts -t "Review with selected"`
Expected: FAIL — menu item not found

- [ ] **Step 3: Add menu item in App.svelte**

In the commit context menu construction (around line 684), add after the `reviewCommit` item:

```typescript
selectedForCompare && selectedForCompare !== hash
  ? { label: `Review with selected ${selectedForCompare.slice(0, 7)}`, action: 'reviewWithSelected' }
  : null,
```

Filter out nulls from the array.

In the action handler (around line 1128), add:

```typescript
case 'reviewWithSelected':
  if (selectedForCompare) {
    await bridge.send('review.setTarget', { kind: 'range', baseRef: selectedForCompare, headRef: hash });
    selectedForCompare = null;
  }
  break;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webview/app-review-jobs.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/App.svelte tests/webview/app-review-jobs.test.ts
git commit -m "feat(graph): add 'Review with selected' context menu item for commit range review"
```

---

### Task 5: Rewrite ReviewApp.svelte

**Files:**
- Rewrite: `src/webview/ReviewApp.svelte`
- Rewrite: `tests/webview/review-app.test.ts`

**Interfaces:**
- Consumes: `Combobox.svelte`, `bridge.send('review.getRepos')`, `bridge.send('review.getCommits')`, `bridge.send('git.branches')`, all existing `review.*` messages
- Produces: the full redesigned Review tab UI

- [ ] **Step 1: Write failing tests for the new layout**

Rewrite `tests/webview/review-app.test.ts`:

```typescript
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import ReviewApp from '../../src/webview/ReviewApp.svelte';

const branches = [
  { name: 'main', current: false },
  { name: 'feat/x', current: true },
];
const commits = [
  { hash: 'a'.repeat(40), abbreviatedHash: 'aaaaaaa', subject: 'First commit', authorDate: '2026-08-24T00:00:00Z' },
  { hash: 'b'.repeat(40), abbreviatedHash: 'bbbbbbb', subject: 'Second commit', authorDate: '2026-08-24T01:00:00Z' },
];
const repos = [
  { path: '/repo/one', name: 'one', active: true },
  { path: '/repo/two', name: 'two', active: false },
];

function stub(overrides: Record<string, unknown> = {}) {
  send.mockImplementation(async (method: string) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case 'review.getRepos': return repos;
      case 'review.getCommits': return commits;
      case 'git.branches': return branches;
      case 'ai.providers': return [{ id: 'claude', name: 'Claude', available: true, group: 'cli' }];
      case 'ui.getState': return null;
      case 'ui.setState': return { success: true };
      case 'review.getTarget': return null;
      case 'review.list': return [];
      case 'review.compare': return { files: [
        { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
      ] };
      case 'review.start': return { id: 'new-id', cached: false };
      case 'review.saveTarget': return { success: true };
      default: return null;
    }
  });
}

afterEach(cleanup);

describe('ReviewApp redesign', () => {
  it('renders repo picker with repos from host', async () => {
    stub();
    const { getByLabelText } = render(ReviewApp);
    await waitFor(() => {
      const select = getByLabelText('Repository') as HTMLSelectElement;
      expect(select.options).toHaveLength(2);
    });
  });

  it('renders mode tabs and defaults to Branches mode', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => {
      expect(getByRole('tab', { name: '1 Commit' })).toBeInTheDocument();
      expect(getByRole('tab', { name: '2 Commits' })).toBeInTheDocument();
      expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument();
      expect(getByRole('tab', { name: '2 Branches' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('Branches mode shows two comboboxes for base and head', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => {
      expect(getByRole('combobox', { name: 'Base branch' })).toBeInTheDocument();
      expect(getByRole('combobox', { name: 'Head branch' })).toBeInTheDocument();
    });
  });

  it('switching to 1 Commit mode shows one commit combobox', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '1 Commit' })).toBeInTheDocument());
    await fireEvent.click(getByRole('tab', { name: '1 Commit' }));
    await waitFor(() => {
      expect(getByRole('combobox', { name: 'Commit' })).toBeInTheDocument();
    });
  });

  it('switching to 2 Commits mode shows two commit comboboxes', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '2 Commits' })).toBeInTheDocument());
    await fireEvent.click(getByRole('tab', { name: '2 Commits' }));
    await waitFor(() => {
      expect(getByRole('combobox', { name: 'Base commit' })).toBeInTheDocument();
      expect(getByRole('combobox', { name: 'Head commit' })).toBeInTheDocument();
    });
  });

  it('review.target event with kind commit switches to 1 Commit mode', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    const targetHandler = on.mock.calls.find(c => c[0] === 'review.target')?.[1];
    expect(targetHandler).toBeDefined();
    targetHandler!({ kind: 'commit', baseRef: '', headRef: 'a'.repeat(40), subject: 'First commit' });
    await waitFor(() => {
      expect(getByRole('tab', { name: '1 Commit' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('review.target event with kind range switches to 2 Commits mode', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    const targetHandler = on.mock.calls.find(c => c[0] === 'review.target')?.[1];
    targetHandler!({ kind: 'range', baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40) });
    await waitFor(() => {
      expect(getByRole('tab', { name: '2 Commits' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('starts a review with current mode and inputs', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('combobox', { name: 'Base branch' })).toBeInTheDocument());
    // Default: head=feat/x, base=main → can review
    await waitFor(() => expect(getByRole('button', { name: 'Review' })).not.toBeDisabled());
    await fireEvent.click(getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.start', expect.objectContaining({
      kind: 'branch',
      provider: 'claude',
    })));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/webview/review-app.test.ts`
Expected: FAIL — current ReviewApp doesn't match new assertions

- [ ] **Step 3: Rewrite ReviewApp.svelte**

Full rewrite of `src/webview/ReviewApp.svelte` implementing:
- Repo picker (`<select>`) at top
- Mode tabs (tablist with 3 tabs)
- Input area that changes per mode (uses `Combobox` component)
- Action bar (provider select, model input, Review button)
- Changed files pane (reuse existing `FileTreeList`)
- Reviews history pane (reuse existing row rendering)
- All event handlers (`review.target`, `review.changed`, `repo.changed`)
- State persistence (`review.mode`, target, provider, model)

The component loads `review.getRepos` and `review.getCommits` on mount, reloads when repo changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webview/review-app.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Run full test suite + typecheck + build**

Run: `npx vitest run tests/webview/ && npx tsc --noEmit && npm run build`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/webview/ReviewApp.svelte tests/webview/review-app.test.ts
git commit -m "feat(review): rewrite Review tab with 3 modes, combobox inputs, and repo picker"
```

---

### Task 6: Integration — end-to-end verification

**Files:**
- No new files. Verify all pieces work together.

**Interfaces:**
- Consumes: all previous tasks
- Produces: passing full suite, clean build

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: all tests PASS (excluding known-slow integration tests that may timeout)

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: clean build

- [ ] **Step 4: Verify graph interaction still works**

Run: `npx vitest run tests/webview/app-review-jobs.test.ts`
Expected: all tests PASS including "Review with selected"

- [ ] **Step 5: Commit spec doc**

```bash
git add docs/superpowers/specs/2026-08-25-review-tab-redesign.md docs/superpowers/plans/2026-08-25-review-tab-redesign.md
git commit -m "docs: review tab redesign spec and implementation plan"
```
