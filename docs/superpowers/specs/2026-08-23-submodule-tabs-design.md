# Submodule Repository Tabs Design

**Date:** 2026-08-23

## Goal

Add a `SUBMODULES` section to the left sidebar. Selecting an initialized
submodule opens a separate Git Graph editor tab whose graph and Git actions are
scoped to that submodule repository. The original tab remains scoped to the
root repository.

## Scope

The first version will:

- List the direct submodules configured by the repository shown in each tab.
- Show each submodule's name, relative path, checked-out commit, and state.
- Open an initialized submodule in a separate Git Graph webview panel.
- Reuse the full existing graph UI and Git actions in the submodule tab.
- Focus an existing tab when the same repository is selected again.
- Allow a submodule tab to list and open its own direct submodules.
- Keep repository state, graph state, requests, invalidation, and mutations
  isolated between tabs.

The first version will not initialize, add, remove, deinitialize, or update
submodules. Selecting an uninitialized or invalid submodule reports a clear
error and does not perform a Git mutation. It will not render a recursive tree
inside one sidebar; nested submodules are reached through the selected
submodule's tab.

## User Experience

Each sidebar gains a collapsible `SUBMODULES` section with a count. Rows use the
submodule name as the primary label and the relative path as their accessible
description/title. A compact state indicator distinguishes an initialized
submodule from an uninitialized, modified, or conflicted one.

Activating an initialized row with click, Enter, or Space asks the extension
host to open that repository. The host either reveals the panel already keyed
to that canonical repository path or creates a panel titled
`Git Graph: <submodule-name>`. The root panel stays open and unchanged.

If the repository cannot be opened, the current tab shows the error through
its existing error banner. No repository context is switched as part of a
failed open.

## Architecture

### Repository panel registry

Replace the single-panel ownership model with a registry. The existing root
workspace panel keeps a stable `workspace-root` key so its current multi-root
repository selector remains backward compatible. Each submodule panel is keyed
by canonical repository path. The registry owns one session per open panel:

```text
RepositoryPanelRegistry
  workspace-root or canonical submodule repository path
    -> WebviewPanel
    -> MessageRouter
    -> GitService
    -> GraphService / GraphMethodHandler
    -> repository-scoped Git metadata watcher
```

`openSubmoduleRepository(path, title)` canonicalizes and validates the
repository path before consulting the registry. If a live submodule session
exists it calls `reveal()`; otherwise it constructs a new isolated session.
Disposing a panel disposes its watcher and removes only that registry entry.

This avoids adding a `repoId` to every request and prevents a late response or
mutation in one tab from being applied to another tab. The existing workspace
repository selector remains available only in the root panel. When it switches
between workspace roots, the root session rebinds its Git and graph services
and metadata watcher. A submodule session exposes only its fixed repository,
so its UI does not show a repository selector. Opening a submodule never
changes another panel's `GitService` path.

### Session-scoped handlers

Git, graph, UI, ping, and AI handlers are registered against the session's
router. Git and graph handlers close over that session's services. UI methods
that read repository data, including branch selection and diffs, use the same
session service. The AI provider detector may remain shared because it has no
repository context, while comparison and review inputs remain session-scoped.

The existing global virtual-document content provider remains shared; its URIs
continue to carry unique commit/path/timestamp data and do not determine which
repository receives Git commands.

### Submodule discovery

`GitService.submoduleList()` returns direct submodules as typed entries:

```ts
interface SubmoduleEntry {
  name: string;
  path: string;
  absolutePath: string;
  head: string | null;
  state: 'initialized' | 'uninitialized' | 'modified' | 'conflicted';
}
```

Discovery uses Git's submodule configuration/status rather than walking the
filesystem, so unrelated nested Git repositories are not exposed as
submodules. Absolute paths are resolved from the owning repository and remain
host-only data used for opening a panel. Before opening, the host verifies that
the requested path still belongs to the current repository's direct submodule
list and that Git recognizes it as a work tree.

The sidebar fetch is included in the same latest-wins metadata refresh as
branches, tags, stashes, and worktrees. Switching the workspace repository or
refreshing a tab replaces its submodule list atomically with the rest of that
tab's metadata.

### Repository-scoped invalidation

Each session observes the actual Git directory returned for its repository,
which also handles the `.git` file layout commonly used by submodules. Changes
invalidate and refresh only that session's graph. Existing mutations continue
to refresh their initiating webview after completion.

## Data Flow

1. A webview requests `git.submoduleList` during metadata refresh.
2. Its session-specific `GitService` returns direct submodules for that repo.
3. `BranchSidebar` renders the rows and dispatches `submoduleOpen` on activation.
4. The webview calls `ui.openSubmodule` with the selected relative path.
5. The session host resolves the path from a fresh direct-submodule list,
   verifies the repository, and calls the shared panel registry.
6. The registry reveals an existing canonical-path session or creates a new
   isolated one.
7. The new webview performs its normal initial load against its own services.

## Error Handling and Safety

- Webview-supplied absolute paths are not trusted; the host resolves a relative
  path against a fresh Git-derived submodule list.
- Uninitialized, missing, or invalid work trees are rejected without running
  `git submodule init` or another mutation.
- Canonical paths provide deduplication even when the same repository is
  reachable through path aliases.
- A failed submodule metadata request is handled by the normal refresh error
  path and cannot partially switch a tab's repository context.
- Panel disposal removes its registry entry and watcher so reopening creates a
  clean session.

## Testing

Tests will cover:

- Parsing initialized, uninitialized, modified, and conflicted submodule state.
- `GitService` and Git method routing for `git.submoduleList`.
- Sidebar rendering, collapsing, mouse activation, keyboard activation, and
  state labels.
- App refresh integration and `ui.openSubmodule` dispatch.
- Registry deduplication by canonical path and cleanup on panel disposal.
- Isolation: requests and mutations from two panels use different repository
  services, and late graph results cannot cross panel boundaries.
- Rejection of stale, uninitialized, and non-submodule paths.
- Existing test suite, coverage checks, typecheck, and production build.

## Success Criteria

- The root tab remains bound to its original repository after opening a
  submodule.
- An initialized submodule opens with the same graph and actions as a root repo.
- Every Git action in a submodule tab executes with that submodule as its
  working directory.
- Repeated activation of the same submodule reveals one existing tab.
- Two repository tabs can refresh and run actions without sharing mutable graph
  or repository state.
- Uninitialized or invalid entries never trigger an implicit mutation.
