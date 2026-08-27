import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

// ---------------------------------------------------------------------------
// Phase 7 (GitHub provider) scope guard.
//
// The whole forge provider layer was built to one acceptance criterion,
// stated in the design spec and restated in the phase 4-8 completion plan:
// adding the GitHub provider must require no change outside
// `src/extension/services/forge/github/`, plus one registry registration in
// `extension.ts` and the coverage lines in `vitest.config.ts`. Everything in
// phases 1-6 (the provider-neutral domain model, ForgeErrorKind, capability
// gating, the optional signOut) was shaped by that promise. This test is
// what makes the promise checkable instead of remembered — the phase 3.7
// findings show exactly how shared-code leaks happen: one small handler
// fallback at a time, each individually defensible.
//
// WHAT IT CHECKS
// It diffs a recorded base commit against the *current working tree* —
// staged, unstaged and untracked changes together (via `git diff <base>`
// plus `git status --porcelain`) — not just committed history. That means
// it catches a violation while phase 7's author is iterating, before they
// even commit it, and it re-checks correctly as commits accumulate on top
// of the base.
//
// HOW THE RANGE IS DETERMINED
// PHASE7_BASE_SHA below is the commit phase 7 starts from (the tip of
// phase 5 task 3). Override it with the FORGE_GITHUB_SCOPE_BASE env var if
// this branch gets rebased and the recorded sha stops resolving, or to
// re-point the check at a different range entirely.
//
// BEHAVIOUR OUTSIDE PHASE-7 CONTEXT
// Two conditions gate enforcement: the base ref must resolve to a real
// commit, and it must be an ancestor of HEAD. Either failing means "not in
// phase-7 context" — e.g. running on `main`, on an unrelated branch, in a
// shallow clone, or (once phase 7 has shipped and merged) any later,
// unrelated commit on this same branch's descendants. In that case the test
// calls `ctx.skip()` with a logged reason: a *skip*, not a pass — vitest
// reports it distinctly from a green test, so an unattended run never reads
// as "checked and clean" when nothing was actually checked.
//
// RETIREMENT
// This guard is only meaningful while phase 7 is in flight. Once the
// GitHub provider ships and this branch merges, delete this file (phase 8's
// ledger is the natural place to record that) — a scope guard nobody
// retires eventually degrades into either permanent skips (harmless but
// dead weight) or, if the base sha is ever reused/misconfigured, spurious
// failures on unrelated work.
// ---------------------------------------------------------------------------

const PHASE7_BASE_SHA = '3a3d9b1d2a7405c0bdeaeb809f940925708db360';

const repoRoot = path.resolve(__dirname, '../..');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function resolvesToCommit(ref: string): boolean {
  try {
    git(['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

// Undoes git's quoting of "unusual" characters (unicode, spaces, quotes) in
// porcelain output for untracked paths.
function unquotePath(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function changedFiles(baseRef: string): string[] {
  const tracked = git(['diff', '--name-only', baseRef])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const untracked = git(['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => unquotePath(line.slice(3).trim()));

  return Array.from(new Set([...tracked, ...untracked])).sort();
}

// Allowed paths, git-relative with forward slashes. This is the acceptance
// criterion, written down as a predicate instead of a sentence someone has
// to remember.
function isAllowed(file: string): boolean {
  if (file.startsWith('src/extension/services/forge/github/')) return true;
  if (file === 'src/extension/extension.ts') return true;
  if (file === 'vitest.config.ts') return true;
  // The recognised test surface for extension.ts's forge registration
  // wiring — Task 2 registering the GitHub provider there legitimately
  // extends this file's assertions.
  if (file === 'tests/extension/forge-host-wiring.test.ts') return true;
  // New test files and fixtures written specifically for the GitHub
  // provider (this guard's own test file matches this rule too).
  if (file.startsWith('tests/') && /github/i.test(file)) return true;
  return false;
}

describe('phase 7 scope guard: GitHub provider touches only forge/github/', () => {
  it('the diff against the phase-7 base touches only the allowed paths', (ctx) => {
    const baseRef = process.env.FORGE_GITHUB_SCOPE_BASE?.trim() || PHASE7_BASE_SHA;

    if (!resolvesToCommit(baseRef)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge-github-scope-guard] SKIPPED: base ref "${baseRef}" does not resolve to a commit in this repository ` +
          `(shallow clone, or unrelated history). Not enforceable here.`
      );
      ctx.skip();
      return;
    }

    if (!isAncestor(baseRef, 'HEAD')) {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge-github-scope-guard] SKIPPED: HEAD does not descend from the phase-7 base commit ${baseRef}. ` +
          `Not in phase-7 context (e.g. running on main, or an unrelated branch/CI range) — guard skipped, not enforced.`
      );
      ctx.skip();
      return;
    }

    const files = changedFiles(baseRef);
    const violations = files.filter((file) => !isAllowed(file));

    if (violations.length > 0) {
      throw new Error(
        `Phase 7 must touch only src/extension/services/forge/github/, src/extension/extension.ts, ` +
          `vitest.config.ts, and tests/fixtures for those. Offending path(s):\n  ${violations.join('\n  ')}`
      );
    }

    expect(violations).toEqual([]);
  });
});
