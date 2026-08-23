# UI Rewrite Report — HTML Table Layout with SVG Graph Column

**Date:** 2026-08-22
**Status:** ✅ Complete — builds with zero errors/warnings

---

## Summary

Rewrote the Git Graph Pro webview from an all-SVG rendering approach to an **HTML table layout with a narrow SVG graph column**. This resolves font rendering issues and improves interactivity, matching the layout style of mhutchie/vscode-git-graph and GitLens.

Also replaced all `prompt()`/`confirm()` calls with VS Code native dialogs via a new `ui` namespace in the extension message router.

---

## Files Modified

| File | Change |
|------|--------|
| `src/webview/App.svelte` | Complete rewrite: removed sidebar, added flex-based row layout with graph/message/date/SHA columns, inline ref badges, virtual scroll, relative time, working changes row |
| `src/webview/components/graph/GraphCanvas.svelte` | Stripped to pure SVG graph lines (edges + node circles). No text, no hit areas, no events — just visual graph rendering |
| `src/extension/extension.ts` | Added `ui` namespace handler with `ui.inputBox` and `ui.confirm` methods |

## Files Preserved (unchanged)

- `src/webview/lib/message-bridge.ts` — singleton bridge
- `src/webview/lib/virtual-scroll.ts` — ROW_HEIGHT, BUFFER_ROWS, calculateVisibleRange
- `src/webview/lib/graph-colors.ts` — 10-color palette
- `src/webview/components/actions/ContextMenu.svelte` — floating context menu
- `src/webview/components/graph/CommitNode.svelte` — still available (unused by new canvas)
- `src/webview/components/graph/BranchLine.svelte` — still available (unused by new canvas)
- `src/webview/components/graph/RefBadge.svelte` — still available (unused, replaced by inline HTML badges)

---

## Architecture Changes

### Before (all-SVG)
```
scrollContainer
  └─ single large <svg>
       ├─ rect hit areas (per row)
       ├─ BranchLine (paths)
       ├─ CommitNode (circles)
       ├─ RefBadge (SVG g+rect+text)
       └─ <text> elements (hash, message, author, date)
```

### After (HTML table + narrow SVG)
```
container
  ├─ toolbar
  ├─ table-header (flex row: graph | MESSAGE | DATE | SHA)
  └─ scroll-area
       └─ scroll-content (virtual height)
            ├─ graph-svg-overlay (position: absolute, left:0, pointer-events: none)
            │    └─ <svg> with edges (paths) + nodes (circles)
            ├─ working-changes row (if uncommitted changes)
            └─ commit-row (per visible node)
                 ├─ col-graph (spacer, same width as SVG)
                 ├─ col-message (ref badges as <span> + subject text)
                 ├─ col-date (relative time)
                 └─ col-sha (abbreviated hash)
```

### Key Design Decisions

1. **CSS flex rows, not `<table>`** — easier to absolutely position for virtual scrolling
2. **Single SVG overlay** for graph lines — `position: absolute; pointer-events: none` so click events pass through to the HTML rows beneath
3. **Graph column width** = `(maxLane + 1) * 16px + 24px` — dynamic based on graph width
4. **ROW_HEIGHT = 32px**, **LANE_WIDTH = 16px** (unchanged from virtual-scroll.ts)
5. **Relative time** via simple function (just now → minutes → hours → days → months → years)
6. **Ref badges** as inline colored `<span>` elements with CSS classes for branch/tag/HEAD
7. **No sidebar** — branches shown as badges on their tip commits
8. **Working Changes** special row at top when `git.status` returns files

---

## VS Code Native Dialogs

Replaced unsafe `prompt()`/`confirm()` with bridge calls:

| Old | New |
|-----|-----|
| `prompt('Branch name:')` | `bridge.send('ui.inputBox', { prompt, placeholder })` |
| `confirm('Delete?')` | `bridge.send('ui.confirm', { message })` |

Extension handler uses:
- `vscode.window.showInputBox()` for text input (returns `null` on cancel)
- `vscode.window.showWarningMessage(..., { modal: true }, 'Yes')` for confirmations (returns boolean)

---

## Build Output

```
dist/extension.cjs   14.7kb  (esbuild, CJS, node)
dist/webview/
  assets/main.css     5.99kb
  assets/main.js     25.19kb
```

Zero errors, zero warnings.

---

## Accessibility

- All commit rows have `role="row"`, `tabindex="0"`, and `on:keydown` for keyboard navigation
- Context menu has `role="menu"` and Escape-to-close
- Proper ARIA compliance per Svelte a11y checks
