# Git Graph VS Code Extension — Design Spec

**Date:** 2026-08-22  
**Status:** Approved  
**Distribution:** Private/internal use only  
**Reference codebase:** mhutchie/vscode-git-graph (gut & rebuild — reuse git parsing logic, rewrite UI + architecture)

---

## 1. Overview

A VS Code extension that provides a full Git workflow through an interactive commit graph visualization — similar to GitKraken but running natively inside VS Code. Includes AI-powered code review using any OpenAI-compatible endpoint.

### Key Features

- Interactive commit graph (branches, merges, tags) with virtual scrolling for unlimited repo size
- Full Git operations from UI: checkout, branch, merge, rebase, cherry-pick, stash, push/pull, reset, bisect
- AI code review: diff between branches → LLM review with summary + inline annotations
- Editor tab UI (opens like a file, supports split view)
- VS Code theme integration (dark/light/high-contrast)

---

## 2. Architecture — Service Layer

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────┐   │
│  │ GitService  │  │GraphService │  │AIReviewService│   │
│  └──────┬──────┘  └──────┬──────┘  └───────┬───────┘   │
│         │                │                  │           │
│  ┌──────┴──────────────────┴──────────────────┴───────┐  │
│  │              MessageRouter / Controller             │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │                               │
│  ┌──────────────────────┴─────────────────────────────┐  │
│  │              WebviewProvider                         │  │
│  └──────────────────────┬─────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────┘
                          │ postMessage (JSON-RPC style)
┌─────────────────────────┼───────────────────────────────┐
│                    Webview (Svelte)                      │
│                         │                               │
│  ┌──────────────────────┴─────────────────────────────┐  │
│  │              MessageBridge                          │  │
│  └──────┬───────────────┬──────────────────┬──────────┘  │
│         │               │                  │            │
│  ┌──────┴──────┐ ┌──────┴──────┐ ┌────────┴────────┐   │
│  │ GraphPanel  │ │ DetailPanel │ │ ReviewPanel     │   │
│  └─────────────┘ └─────────────┘ └─────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Principles:**
- Extension Host owns all data & logic — webview never calls git directly
- Communication via typed JSON-RPC-style messages (request/response + events)
- Services are independent — communicate via controller if needed
- Webview only renders + dispatches user actions

---

## 3. Extension Host Services

### 3.1 GitService

Wraps Git CLI with spawn + structured output parsing.

```
GitService
├── log(options)             → paginated commit history
├── branches()               → local + remote branches
├── tags()                   → tag list
├── show(hash)               → commit detail + file changes
├── diff(ref1, ref2)         → diff between 2 refs
├── checkout(ref)            → checkout branch/commit
├── createBranch(name, from?)
├── deleteBranch(name, force?)
├── merge(branch, options?)
├── rebase(onto, options?)   → basic + interactive
├── cherryPick(hash)
├── stash(action, options?)  → save/pop/drop/list
├── push(remote, branch, options?)
├── pull(remote, branch, options?)
├── fetch(remote?)
├── reset(mode, ref)         → soft/mixed/hard
├── bisect(action, ...)
├── status()                 → working tree status
└── config(key, value?)      → get/set git config
```

Internal helper `GitCLI`:
- Spawns child process with proper encoding
- Queues commands (prevents race conditions)
- Parses structured output (uses `--format` for git log)
- Handles errors + timeout

### 3.2 GraphService

Receives raw commit data → computes graph layout.

```
GraphService
├── buildGraph(commits[])          → nodes + edges with x,y positions
├── getVisibleWindow(offset, limit)→ paginated graph data for virtual scroll
├── search(query)                  → filter commits by message/author/hash
├── filter(options)                → filter by branch/author/date range
└── getLayout()                    → current layout metadata
```

Layout engine:
- Repos < 5000 commits → dagre (optimal aesthetics)
- Repos > 5000 commits → custom lane assignment algorithm (O(n), fast)
- Auto-detect and switch

### 3.3 AIReviewService

```
AIReviewService
├── reviewDiff(branch1, branch2, options?)  → ReviewResult
├── getConfig()             → { endpoint, apiKey, model }
├── setConfig(config)       → save to VS Code settings
└── cancelReview()          → abort ongoing request
```

### 3.4 ConfigService

```
ConfigService
├── get(key)                    → setting value
├── set(key, value)             → update VS Code settings
├── onDidChange(key, callback)  → watch setting changes
└── getAll()                    → full config object
```

---

## 4. Webview — Svelte Components

### 4.1 Component Structure

```
src/webview/
├── App.svelte
├── components/
│   ├── graph/
│   │   ├── GraphCanvas.svelte   ← SVG container + virtual scroll
│   │   ├── CommitNode.svelte    ← single commit dot + message
│   │   ├── BranchLine.svelte    ← edge/path between commits
│   │   ├── BranchLabel.svelte   ← branch/tag labels
│   │   └── RefBadge.svelte      ← HEAD, remote refs
│   ├── detail/
│   │   ├── CommitDetail.svelte
│   │   ├── FileList.svelte
│   │   └── DiffView.svelte
│   ├── review/
│   │   ├── ReviewPanel.svelte
│   │   ├── ReviewSummary.svelte
│   │   └── AnnotationList.svelte
│   ├── actions/
│   │   ├── ContextMenu.svelte
│   │   ├── BranchDialog.svelte
│   │   ├── MergeDialog.svelte
│   │   ├── RebaseDialog.svelte
│   │   └── StashDialog.svelte
│   └── shared/
│       ├── Toolbar.svelte
│       ├── BranchSelector.svelte
│       └── Toast.svelte
├── stores/
│   ├── graph.ts
│   ├── selection.ts
│   ├── review.ts
│   └── config.ts
├── lib/
│   ├── message-bridge.ts
│   ├── virtual-scroll.ts
│   └── svg-renderer.ts
└── main.ts
```

### 4.2 Virtual Scrolling

- SVG height = totalCommits × ROW_HEIGHT (virtual)
- Only render commits in viewport + buffer (±20 rows)
- Scroll event → calculate visible range → request GraphService if needed
- GraphService caches pages — webview does not re-request existing data

### 4.3 Context Menus

**On commit node:** Checkout, Create branch, Create tag, Cherry-pick, Reset to here, Copy SHA, View diff with...

**On branch label:** Checkout, Merge into current, Rebase onto..., Delete branch, Push/Pull, AI Review

**On empty area:** Fetch all, Create branch, Stash changes

---

## 5. Communication Protocol

### 5.1 Message Format

```typescript
// Request: Webview → Host
interface Request {
  id: string;
  type: 'request';
  method: string;      // e.g. "git.log", "graph.getWindow"
  params?: any;
}

// Response: Host → Webview
interface Response {
  id: string;
  type: 'response';
  result?: any;
  error?: { code: number; message: string };
}

// Event: Host → Webview (push)
interface Event {
  type: 'event';
  event: string;       // e.g. "git.statusChanged"
  data?: any;
}
```

### 5.2 Method Namespaces

- `git.*` — all git operations
- `graph.*` — graph layout and windowing
- `review.*` — AI review lifecycle
- `config.*` — settings management

### 5.3 Events (Host → Webview)

- `git.statusChanged` — working tree changed
- `git.refsChanged` — branches/tags/HEAD changed
- `review.progress` — AI review streaming partial result
- `review.complete` — AI review done
- `graph.invalidated` — graph needs refresh after operation

---

## 6. AI Code Review

### 6.1 Flow

1. User selects 2 branches (right-click or toolbar)
2. Dialog confirms: "Review diff: feature-x → main"
3. Host fetches diff, chunks by file boundary (≤ 6000 tokens/chunk)
4. Each chunk sent to LLM with review system prompt
5. Streaming results displayed in ReviewPanel
6. Final: Summary markdown + inline annotations (file:line + severity + comment)

### 6.2 Chunking Strategy

1. Get full diff (`git diff branch1...branch2`)
2. Split by file boundaries
3. Group files into chunks ≤ token budget
4. Each chunk = 1 API request with context
5. Merge annotations from all chunks
6. Final summary request: all annotations → LLM generates overview

### 6.3 Output Format

```typescript
interface ReviewResult {
  summary: string;           // markdown overview
  annotations: Annotation[];
}

interface Annotation {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info' | 'suggestion';
  comment: string;
}
```

### 6.4 Configuration

```json
{
  "gitGraph.ai.enabled": true,
  "gitGraph.ai.endpoint": "https://api.openai.com/v1",
  "gitGraph.ai.model": "gpt-4",
  "gitGraph.ai.maxTokensPerChunk": 6000,
  "gitGraph.ai.temperature": 0.2,
  "gitGraph.ai.systemPrompt": "",
  "gitGraph.ai.excludePatterns": ["*.env", "secrets/**"]
}
```

API key stored in `vscode.SecretStorage` (OS keychain encrypted).

---

## 7. Project Structure & Build

### 7.1 Directory Layout

```
git-graph/
├── src/
│   ├── extension/                ← Extension Host (TypeScript)
│   │   ├── extension.ts
│   │   ├── services/
│   │   │   ├── git.service.ts
│   │   │   ├── git-cli.ts
│   │   │   ├── graph.service.ts
│   │   │   ├── review.service.ts
│   │   │   └── config.service.ts
│   │   ├── controllers/
│   │   │   └── message-router.ts
│   │   ├── providers/
│   │   │   └── webview-provider.ts
│   │   ├── types/
│   │   │   ├── git.types.ts
│   │   │   ├── graph.types.ts
│   │   │   ├── messages.types.ts
│   │   │   └── review.types.ts
│   │   └── utils/
│   │       ├── git-parser.ts
│   │       └── queue.ts
│   │
│   └── webview/                  ← Svelte App
│       ├── App.svelte
│       ├── main.ts
│       ├── components/
│       ├── stores/
│       ├── lib/
│       └── styles/
│
├── package.json
├── tsconfig.json
├── svelte.config.js
├── vite.config.ts
├── esbuild.config.mjs
└── .vscodeignore
```

### 7.2 Build Pipeline

- **Extension Host:** esbuild → `dist/extension.js` (Node.js target, single bundle)
- **Webview:** Vite + Svelte plugin → `dist/webview/` (index.html + assets)
- **Dev:** `npm run dev` runs both watchers in parallel; F5 launches Extension Development Host

### 7.3 Key Dependencies

```
esbuild, typescript, @types/vscode     (host tooling)
svelte, @sveltejs/vite-plugin-svelte, vite  (webview tooling)
dagre, @types/dagre                    (graph layout)
```

---

## 8. Performance & Scalability

### 8.1 Three-Layer Pagination

| Layer | Scope | Size |
|-------|-------|------|
| Git CLI | Data fetch (`--skip`, `--max-count`) | 500 commits/batch |
| GraphService | Layout cache (LRU) | ~5 pages (2500 commits) |
| Webview | DOM render (viewport + buffer) | ~70-90 nodes max |

### 8.2 Graph Layout Strategy

- Git graphs are inherently timeline-based (Y = commit order)
- Only X position (lane/column) needs computation
- Custom lane assignment algorithm: O(n), assigns each branch a column, reuses freed lanes after merge
- dagre used for small repos (< 5000 commits) where aesthetics matter more

### 8.3 Search & Filter

All filtering uses native git CLI options (`--grep`, `--author`, `--after`, `--before`, branch refs) for performance. No in-memory filtering of large datasets.

---

## 9. Error Handling

### 9.1 Error Codes

```typescript
enum GitErrorCode {
  MERGE_CONFLICT = 1,
  REBASE_CONFLICT = 2,
  PUSH_REJECTED = 3,
  BRANCH_EXISTS = 4,
  BRANCH_NOT_FOUND = 5,
  DIRTY_WORKING_TREE = 6,
  DETACHED_HEAD = 7,
  LOCK_FILE_EXISTS = 8,
  AUTH_FAILED = 9,
  TIMEOUT = 10,
  UNKNOWN = 99
}
```

### 9.2 Conflict Resolution

Merge/rebase conflict → show conflict file list → user opens VS Code merge editor → clicks "Continue" → host runs `git add` + continue.

### 9.3 Dirty Working Tree Guard

Before destructive operations: check `git status`. If dirty → offer [Stash & Continue] [Commit First] [Cancel]. Auto-unstash after operation.

### 9.4 Graceful Degradation

- Git not installed → error + install link
- Git version too old → warn, disable unsupported features
- No repo in workspace → "Open a folder with git repo"
- Large repo detected → auto-switch to custom lane algorithm

### 9.5 File Watcher

Watch `.git/HEAD`, `.git/refs/`, `.git/index`, working tree → emit events → webview auto-refresh affected areas.

---

## 10. Security

### 10.1 API Key Storage

`vscode.SecretStorage` (OS keychain) — never plaintext in settings.json.

### 10.2 Webview CSP

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'nonce-${nonce}';
  style-src ${webview.cspSource} 'unsafe-inline';
  img-src ${webview.cspSource} data:;
  font-src ${webview.cspSource};
">
```

### 10.3 Git Command Injection Prevention

Always use `spawn('git', [args...])` — never string interpolation. Validate all user inputs (branch names, hashes, file paths).

### 10.4 AI Privacy

- User must opt-in explicitly before code is sent to AI endpoint
- First-time warning dialog
- Configurable exclude patterns (`gitGraph.ai.excludePatterns`)
- Never send: credentials, API keys, file content outside diff

---

## 11. Tech Stack Summary

| Component | Technology |
|-----------|-----------|
| Extension Host | TypeScript, Node.js |
| Webview UI | Svelte 4 |
| Graph Layout | dagre + custom lane algorithm |
| SVG Rendering | Custom (in Svelte components) |
| Git Access | VS Code Git API (discovery) + CLI spawn (operations) |
| AI Integration | OpenAI-compatible REST API |
| Build (host) | esbuild |
| Build (webview) | Vite |
| Secret Storage | vscode.SecretStorage |

---

## 12. Reference

- **mhutchie/vscode-git-graph** — git parsing logic, command patterns, edge case handling
- **dagre** — graph layout algorithm
- **VS Code Webview API** — extension ↔ webview communication patterns
