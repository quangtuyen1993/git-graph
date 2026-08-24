# Git Graph Pro

Interactive Git graph visualization for VS Code with full workflow operations and AI-powered code review.

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue)
![Version](https://img.shields.io/badge/version-0.1.0-green)

## Features

### 📊 Interactive Git Graph

- Visualize commit history as a colorful branch graph
- Navigate branches, merges, and rebases visually
- Branch lanes with automatic layout and color assignment
- Ref badges for branches and tags on commit nodes
- Virtual scrolling for large repositories

### 🌿 Branch & Tag Management

- Branch sidebar with tree view (local & remote)
- Create, checkout, rename, and delete branches
- Merge and rebase workflows
- Push, pull, and fetch operations
- Tag creation and management
- Stash support (save, pop, apply, drop)

### 📋 Commit Detail Panel

- View full commit metadata (author, date, message, parents)
- File change list with additions/deletions stats
- Inline diff viewer with VS Code's native diff editor
- Support for renamed, copied, and binary files

### 🤖 AI Code Review

Review diffs using AI providers directly from the graph:

- **Claude** (CLI) — Anthropic's Claude via `claude` CLI
- **Codex** (CLI) — OpenAI Codex CLI
- **Kiro** (CLI) — Kiro CLI
- **OpenAI** (API) — GPT models via API
- **DeepSeek** (API) — DeepSeek models via API

Auto-detects available CLI tools. Reviews provide summary, issues (critical/important/minor), suggestions, and a verdict (approve/request changes/comment).

### 🔧 Git Operations

- Context menu actions on commits (cherry-pick, revert, reset, rebase onto)
- Interactive rebase with drag-and-drop reorder
- Multi-repository support with workspace folder detection
- Submodule and worktree awareness

## Requirements

- VS Code ≥ 1.85.0
- Git installed and accessible in PATH

For AI Review (optional):
- `claude`, `codex`, or `kiro` CLI installed — or —
- DeepSeek API key configured in settings

## Installation

### From Source

```bash
git clone <repo-url>
cd git-graph
npm install
npm run build
npm run package
```

Then install the generated `.vsix` file:

```
code --install-extension git-graph-pro-0.1.0.vsix
```

## Usage

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **Git Graph Pro: Open**
3. The graph panel opens showing your repository's commit history

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `gitGraphPro.aiReview.defaultProvider` | `auto` | AI provider for code review (`auto`, `claude`, `codex`, `kiro`, `openai`, `deepseek`) |
| `gitGraphPro.aiReview.defaultModel` | `""` | Model to use (e.g. `sonnet`, `gpt-4o`, `deepseek-chat`). Empty = provider default |
| `gitGraphPro.aiReview.deepseekApiKey` | `""` | DeepSeek API key |
| `gitGraphPro.aiReview.timeoutSeconds` | `0` | Silence timeout in seconds. `0` = no timeout |
| `gitGraphPro.aiReview.maxDiffChars` | `0` | Max diff size in characters. `0` = send full diff |

## Development

### Tech Stack

- **Extension host:** TypeScript + esbuild (CJS output for VS Code)
- **Webview UI:** Svelte 4 + Vite
- **Graph layout:** Custom lane-based algorithm
- **Testing:** Vitest + Testing Library
- **Packaging:** @vscode/vsce

### Scripts

```bash
npm run dev          # Start dev mode (host + webview watch)
npm run build        # Production build
npm run test         # Run tests
npm run test:watch   # Tests in watch mode
npm run coverage     # Tests with coverage report
npm run typecheck    # TypeScript type checking
npm run check        # Full CI check (test + coverage + typecheck + build)
npm run package      # Package as .vsix
```

### Project Structure

```
src/
├── extension/              # VS Code extension host (Node.js)
│   ├── controllers/        # Message routing & session management
│   ├── providers/          # Webview panel provider
│   ├── services/           # Git, Graph, AI Review business logic
│   ├── types/              # TypeScript interfaces
│   └── utils/              # Parsers and helpers
└── webview/                # Svelte webview UI (browser)
    ├── components/
    │   ├── actions/        # Context menus
    │   ├── detail/         # Commit detail panel
    │   ├── graph/          # Graph canvas, nodes, edges, badges
    │   ├── review/         # AI review panel
    │   └── sidebar/        # Branch tree sidebar
    ├── lib/                # Shared utilities
    ├── styles/             # CSS/theme styles
    └── types/              # Webview-side types
```

## License

Private — not published to marketplace.
