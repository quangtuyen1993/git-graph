import * as vscode from 'vscode';
import type { ReviewEntry, ReviewStatus, ReviewStore } from '../services/review-store';

export function statusIcon(status: ReviewStatus): string {
  switch (status) {
    case 'running': return 'loading~spin';
    case 'done': return 'check';
    case 'failed': return 'error';
    case 'cancelled': return 'circle-slash';
    case 'interrupted': return 'warning';
  }
}

function elapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * A running row counts up so the user can see it is alive; a finished row shows
 * how long ago it landed. Anything other than `done` names its status first,
 * because "8m ago" alone reads as success.
 */
export function formatDescription(entry: ReviewEntry, now: number): string {
  if (entry.status === 'running') {
    return elapsed(now - Date.parse(entry.startedAt));
  }
  const finishedAt = entry.finishedAt ?? entry.startedAt;
  const stamp = Date.parse(finishedAt);
  // An entry recovered by rebuildIndex() has no real timestamps — startedAt is
  // the epoch — and "interrupted · 20000d ago" is noise dressed up as fact.
  // Name the status and say nothing about when.
  if (!Number.isFinite(stamp) || stamp <= 0) {
    return entry.status === 'done' ? '' : entry.status;
  }
  const relative = ago(now - stamp);
  return entry.status === 'done' ? relative : `${entry.status} · ${relative}`;
}

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewEntry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: ReviewStore,
    private readonly getRepoId: () => string | undefined,
  ) {}

  public refresh(): void {
    this.changed.fire();
  }

  /** Pushed into context.subscriptions, so the emitter dies with the extension. */
  public dispose(): void {
    this.changed.dispose();
  }

  public getTreeItem(entry: ReviewEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(`${entry.baseRef} ← ${entry.headRef}`);
    item.description = formatDescription(entry, Date.now());
    item.iconPath = new vscode.ThemeIcon(statusIcon(entry.status));
    item.contextValue = entry.status;
    item.tooltip = `${entry.provider} · ${entry.model}\n${entry.baseSha.slice(0, 7)}..${entry.headSha.slice(0, 7)}`;
    item.command = {
      command: 'gitGraphPro.review.open',
      title: 'Open Review',
      arguments: [entry],
    };
    return item;
  }

  public async getChildren(): Promise<ReviewEntry[]> {
    let repoId: string | undefined;
    try {
      // getRepoId() resolves the real filesystem path (realpathSync) under the
      // hood, so a repo deleted or unmounted while its rows are on screen makes
      // this throw. The row commands already guard it; without the same guard
      // here the whole view becomes a tree-loading error instead of an empty
      // list.
      repoId = this.getRepoId();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[review-tree] Failed to resolve active repository: ${message}`);
      return [];
    }
    if (!repoId) return [];
    return this.store.list(repoId);
  }
}
