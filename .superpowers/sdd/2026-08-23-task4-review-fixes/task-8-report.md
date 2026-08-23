# Task 8 report — coverage/package closure

## Baseline (RED)

`npm run coverage` at base `07ef42968f8b6587ecbae8a7041bf0891601c6c6` ran 17 files / 64 tests and failed the configured gate: statements/lines **58.29%**, functions **49.49%**, branches **71.42%**. The largest gaps were `graph.service.ts` (0%), webview graph/gravatar/message/virtual-scroll helpers, and uncovered GitService command branches.

## Changes and GREEN evidence

- Added `.superpowers/**`, `coverage/**`, `tests/**`, and `vitest.config.ts` to `.vscodeignore`.
- Added behavior-focused graph, GitService command/defensive, helper, and MessageBridge tests.
- Added a real temporary-repository `GitService.diff` two-stream regression test.
- Final `npm run coverage`: **83.06% statements, 83.06% lines, 84.87% functions, 79.65% branches**; gate 80/80/80/70 passes.
- `npm test`: 69 passed, 1 skipped (the App lifecycle harness test described below).

## Required deferred minor triage

`tests/webview/app-published-history.test.ts` contains the requested `vi.hoisted` bridge mock and published-history cancellation flow. It is currently skipped because the existing Svelte/Vitest harness renders the component markup but does not execute App's `onMount` callback (the bridge mock receives no `ping.hello` call), so the UI flow cannot reach the graph row without falsely asserting behavior. This remains an explicit follow-up gap; no production behavior was weakened.

The direct `GitService.diff` deferred minor is closed and green against a real Git repository with modified and added files, exercising reconciliation of numstat and name-status streams.

## Verification commands

- `npm test` — pass, 69 passed / 1 skipped.
- `npm run coverage` — pass, 83.06 / 83.06 / 84.87 / 79.65.
- `npm run typecheck` — pass.
- `npm run build` — pass; `dist/extension.cjs`, `dist/webview/assets/main.js`, and `main.css` produced.
- `git diff --check` — pass.
- `npm run package` — pass; VSIX contained 7 files and no `.superpowers`, `tests`, or `coverage` entries.
- `vsce ls --tree` — confirmed expected dist assets; generated `git-graph-pro-0.1.0.vsix` removed using exact-target unlink.
- `npm test -- tests/extension/git-rewrite.integration.test.ts --reporter=verbose` — 7 passed; published-history detection and descendant-preservation regressions green.
- `npm run check` — pass (tests/coverage/typecheck/build; 69 passed / 1 skipped).

## Files

- `.vscodeignore`
- `tests/coverage-closure.test.ts`
- `tests/extension/git-file-changes.integration.test.ts`
- `tests/webview/message-bridge.test.ts`
- `tests/webview/app-published-history.test.ts`

## Self-review

No thresholds were lowered, no source was excluded, and no force audit upgrade was used. No push or PR was made. The only unresolved item is the explicitly skipped App lifecycle test noted above.
