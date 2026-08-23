# Task 4 Review Fixes Design

**Date:** 2026-08-23
**Status:** Approved in conversation; pending written-spec review
**Scope:** Resolve the seven findings from the Phase 1–4 review on the current codebase.

## Goals

- Make `reword` and `squash` preserve every descendant commit after the rewritten range.
- Complete the missing `git.revert` operation end to end.
- Show working-tree changes from the actual `GitStatus` contract.
- Remove the 500-commit history ceiling while retaining 500-commit Git CLI batches and virtualized DOM rendering.
- Report added, modified, deleted, renamed, copied, and binary files accurately, including unusual filenames.
- Make virtual scrolling converge on the latest requested window during rapid scrolling.
- Make context menus, sidebar items, resize handles, and long-running Git operations usable and understandable with keyboard and assistive technology.
- Establish automated regression tests and an enforceable coverage gate.

## Safe History Rewrite

For a history `A -> B -> C -> D`, rewording `B` must produce `A -> B' -> C' -> D'`. Squashing `B` and `C` must produce `A -> BC' -> D'`.

The implementation will use an interactive-rebase sequence editor that receives Git's complete todo file and transforms only the selected lines:

- `reword`: change the selected commit from `pick` to `reword`; retain every other todo line.
- `squash`: keep the oldest selected commit as `pick`, change the remaining selected commits to `squash`, and retain every unselected todo line.
- Reject non-consecutive squash selections before invoking rebase.
- Preserve descendants by allowing Git to replay all unselected commits after the rewritten range.
- Surface conflicts without automatically aborting, so the user can resolve or explicitly abort using the existing operations.
- Warn before rewriting commits that are already reachable from the configured upstream. Rewriting published commits requires explicit confirmation because it changes descendant hashes and may require force-push.
- Use temporary editor scripts/files with collision-safe names and guaranteed cleanup.

Integration tests will create isolated temporary Git repositories. They must prove that descendants remain reachable after reword and squash, messages are correct, invalid selections are rejected, and conflicts/errors are surfaced.

## Git Operations and Data Contracts

### Revert

Add `GitService.revert(hash): Promise<void>`, register `git.revert` in the extension router, and retain the existing webview action. A temporary-repository integration test will assert that revert creates a new commit and restores the previous tree state.

### Working Changes

The webview will derive `hasWorkingChanges` from `staged`, `unstaged`, `untracked`, and `conflicted`. The working-changes row will not reuse commit-only actions; it will expose working-tree-appropriate actions such as stash and refresh. The derivation will live in a pure helper with unit tests.

### File Changes

GitService will collect NUL-delimited `--numstat -z` and `--name-status -z` output with rename/copy detection enabled. The parser will merge statistics and status records into `FileChange` values without relying on whitespace or quoted paths. Tests will cover additions, deletions, modifications, renames, copies, binary files, spaces, tabs, and non-ASCII filenames.

## Graph Loading and Virtual Scrolling

Graph construction will fetch commit history in 500-commit batches using `maxCount` and `skip` until the final short batch. The host will build one layout after all batches are collected, while the webview continues to render only the viewport plus buffer rows. This removes the user-visible 500-commit cap without expanding DOM usage.

Window requests will use latest-request-wins semantics. A slow response for an older viewport must not replace a newer response, and a request made while another is pending must not be discarded. The coordination logic will be extracted into a testable helper.

## UI and Accessibility

- Clamp context menus to the visible viewport after their dimensions are known.
- Move focus to the first enabled menu item when a menu opens; support Arrow Up, Arrow Down, Home, End, Enter, Space, and Escape; restore focus when closing.
- Give separators appropriate semantics and keep disabled actions out of keyboard navigation.
- Make branch, tag, stash, and worktree rows keyboard-focusable. Support Enter/Space for their primary action and Shift+F10/ContextMenu for their context menu.
- Make resize separators focusable and adjustable with arrow keys, with accurate ARIA values and labels.
- Show an `aria-live` operation state while a Git mutation is running and prevent duplicate mutation dispatches until it settles.
- Clamp panel widths when the available viewport is narrower than the configured side panels.

## Test and Coverage Gate

Use Vitest with the V8 coverage provider. Tests will include:

- Unit tests for Git parsing, graph layout/windowing, virtual scrolling, working-change derivation, context-menu placement, and rebase-todo transformation.
- Temporary-repository integration tests for reword, squash, revert, and commit batching.
- DOM/component tests for context-menu keyboard behavior and resize-handle keyboard behavior.
- RPC contract tests ensuring every webview Git method has a registered host route.

Coverage thresholds:

- Statements: 80%
- Lines: 80%
- Functions: 80%
- Branches: 70%

Coverage will include the extracted core and UI behavior modules. VS Code lifecycle glue that requires an Extension Development Host may be excluded only when its behavior is covered through routing contract tests; exclusions must be explicit in the Vitest configuration.

Required package scripts:

- `test`: run the complete suite once.
- `test:watch`: run Vitest in watch mode.
- `coverage`: run tests with coverage thresholds enforced.
- `check`: run tests, coverage, TypeScript checking, and production build.

## Packaging

Exclude `.superpowers/**` and generated local review artifacts from VSIX packaging. Packaging may still warn about optional repository/license metadata, but internal planning files must not be included.

## Acceptance Criteria

- Rewording or squashing an older commit retains every later commit in branch history.
- Published-history rewrites require explicit confirmation.
- Revert succeeds through the current context menu.
- Working changes appear whenever any GitStatus change collection is non-empty.
- Repositories with more than 500 commits expose the complete loaded history.
- Commit detail reports correct file statuses and rename paths.
- Rapid scrolling settles on the most recently requested graph window.
- All affected controls are keyboard operable and expose appropriate ARIA state.
- `npm test`, `npm run coverage`, TypeScript checking, production build, and VSIX packaging succeed.
- The coverage thresholds are enforced, and the workspace is clean after verification.
