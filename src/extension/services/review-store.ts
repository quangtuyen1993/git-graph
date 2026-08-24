import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

export type ReviewStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface ReviewEntry {
  id: string;
  /** Base of the comparison. Diff reads sourceBranch..targetBranch. */
  sourceBranch: string;
  sourceSha: string;
  /** Head of the comparison. */
  targetBranch: string;
  targetSha: string;
  provider: string;
  model: string;
  status: ReviewStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export const MAX_ENTRIES_PER_REPO = 50;

export class ReviewStore {
  private readonly indexMutexes = new Map<string, Promise<unknown>>();

  constructor(private readonly rootDir: string) {}

  public bodyPath(repoId: string, id: string): string {
    return join(this.rootDir, repoId, `${id}.md`);
  }

  public async list(repoId: string): Promise<ReviewEntry[]> {
    const entries = await this.readIndex(repoId);
    return [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public async get(repoId: string, id: string): Promise<ReviewEntry | undefined> {
    return (await this.readIndex(repoId)).find(e => e.id === id);
  }

  public async create(repoId: string, entry: ReviewEntry): Promise<void> {
    return this.withIndexLock(repoId, async () => {
      await mkdir(join(this.rootDir, repoId), { recursive: true });
      const entries = (await this.readIndex(repoId)).filter(e => e.id !== entry.id);
      entries.push(entry);
      await this.writeIndex(repoId, await this.evict(repoId, entries));
      await writeFile(this.bodyPath(repoId, entry.id), '', 'utf8');
    });
  }

  public async appendBody(repoId: string, id: string, chunk: string): Promise<void> {
    await mkdir(join(this.rootDir, repoId), { recursive: true });
    await appendFile(this.bodyPath(repoId, id), chunk, 'utf8');
  }

  public async readBody(repoId: string, id: string): Promise<string> {
    return readFile(this.bodyPath(repoId, id), 'utf8').catch(() => '');
  }

  public async finish(repoId: string, id: string, patch: Partial<ReviewEntry>): Promise<void> {
    return this.withIndexLock(repoId, async () => {
      const entries = await this.readIndex(repoId);
      const index = entries.findIndex(e => e.id === id);
      if (index === -1) return;
      entries[index] = { ...entries[index], ...patch };
      await this.writeIndex(repoId, entries);
    });
  }

  public async remove(repoId: string, id: string): Promise<void> {
    return this.withIndexLock(repoId, async () => {
      const entries = (await this.readIndex(repoId)).filter(e => e.id !== id);
      await this.writeIndex(repoId, entries);
      await rm(this.bodyPath(repoId, id), { force: true });
    });
  }

  /**
   * Called once at activation. No child process outlives the extension host, so
   * an entry still marked `running` is the debris of a killed run. Reporting it
   * as `interrupted` is the honest state; it must never read as `done`.
   */
  public async reconcileOrphans(): Promise<string[]> {
    const repoIds = await readdir(this.rootDir).catch(() => [] as string[]);
    const rewritten: string[] = [];

    for (const repoId of repoIds) {
      await this.withIndexLock(repoId, async () => {
        const entries = await this.readIndex(repoId);
        let changed = false;
        for (const entry of entries) {
          if (entry.status !== 'running') continue;
          entry.status = 'interrupted';
          entry.finishedAt = new Date().toISOString();
          rewritten.push(entry.id);
          changed = true;
        }
        if (changed) await this.writeIndex(repoId, entries);
      });
    }

    return rewritten;
  }

  private indexPath(repoId: string): string {
    return join(this.rootDir, repoId, 'index.json');
  }

  private async readIndex(repoId: string): Promise<ReviewEntry[]> {
    const raw = await readFile(this.indexPath(repoId), 'utf8').catch(() => null);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as ReviewEntry[];
    } catch {
      // fall through to the rebuild below
    }
    return this.rebuildIndex(repoId);
  }

  /**
   * A corrupt index must never take the view down with it. Body files carry the
   * ids, so the list is recoverable; everything else is unknown, and an entry we
   * cannot vouch for is reported as `interrupted` rather than `done`.
   */
  private async rebuildIndex(repoId: string): Promise<ReviewEntry[]> {
    const files = await readdir(join(this.rootDir, repoId)).catch(() => [] as string[]);
    const recovered: ReviewEntry[] = files
      .filter(name => name.endsWith('.md'))
      .map(name => {
        const id = name.slice(0, -3);
        return {
          id,
          sourceBranch: 'unknown',
          sourceSha: '',
          targetBranch: 'unknown',
          targetSha: '',
          provider: 'unknown',
          model: 'unknown',
          status: 'interrupted' as const,
          startedAt: new Date(0).toISOString(),
        };
      });
    await this.writeIndex(repoId, recovered);
    return recovered;
  }

  private async writeIndex(repoId: string, entries: ReviewEntry[]): Promise<void> {
    await mkdir(join(this.rootDir, repoId), { recursive: true });
    await writeFile(this.indexPath(repoId), JSON.stringify(entries, null, 2), 'utf8');
  }

  /** Drop the oldest finished entries past the cap. A running review is never evicted. */
  private async evict(repoId: string, entries: ReviewEntry[]): Promise<ReviewEntry[]> {
    if (entries.length <= MAX_ENTRIES_PER_REPO) return entries;

    const running = entries.filter(e => e.status === 'running');
    const finished = entries
      .filter(e => e.status !== 'running')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const keepFinished = finished.slice(0, Math.max(0, MAX_ENTRIES_PER_REPO - running.length));
    for (const dropped of finished.slice(keepFinished.length)) {
      await rm(this.bodyPath(repoId, dropped.id), { force: true });
    }
    return [...running, ...keepFinished];
  }

  /**
   * Serialize index mutations per repo. Chains each critical section onto the tail
   * for that repoId, ensuring read-modify-write cycles are atomic. A rejected
   * critical section does not poison the chain for later callers.
   */
  private async withIndexLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.indexMutexes.get(repoId) ?? Promise.resolve();
    const result = current.then(() => fn(), () => fn());
    this.indexMutexes.set(repoId, result.catch(() => {}));
    return result;
  }
}
