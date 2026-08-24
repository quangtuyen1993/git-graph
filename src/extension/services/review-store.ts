import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
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
  /** One write chain per body file, so streamed chunks land in call order. */
  private readonly bodyChains = new Map<string, Promise<unknown>>();
  private tempCounter = 0;

  constructor(private readonly rootDir: string) {}

  public bodyPath(repoId: string, id: string): string {
    return join(this.rootDir, repoId, `${id}.md`);
  }

  /**
   * Reads take the same lock as writes. An unsynchronised read can land in the
   * middle of a write and see a half-written (or, before the atomic rename
   * below, an empty) index — and `readIndex`'s recovery path *rewrites* the
   * file, so a single torn read would destroy every entry's metadata.
   */
  public async list(repoId: string): Promise<ReviewEntry[]> {
    const entries = await this.withIndexLock(repoId, () => this.readIndex(repoId));
    return [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public async get(repoId: string, id: string): Promise<ReviewEntry | undefined> {
    const entries = await this.withIndexLock(repoId, () => this.readIndex(repoId));
    return entries.find(e => e.id === id);
  }

  public async create(repoId: string, entry: ReviewEntry): Promise<void> {
    return this.withIndexLock(repoId, async () => {
      await mkdir(join(this.rootDir, repoId), { recursive: true });
      const entries = (await this.readIndex(repoId)).filter(e => e.id !== entry.id);
      entries.push(entry);
      // Body first: a crash between the two writes must leave an orphaned empty
      // body (invisible, harmless) rather than an indexed row whose `open`
      // throws because the file it points at was never created.
      await writeFile(this.bodyPath(repoId, entry.id), '', 'utf8');
      await this.writeIndex(repoId, await this.evict(repoId, entries));
    });
  }

  /**
   * Appends are serialised per body file. Two `appendFile` calls issued in the
   * same tick are two independent open/write/close cycles whose completion
   * order the libuv threadpool decides, so unchained writes genuinely arrive
   * scrambled under load — measured, not theoretical.
   */
  public async appendBody(repoId: string, id: string, chunk: string): Promise<void> {
    const key = `${repoId}/${id}`;
    const previous = this.bodyChains.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      await mkdir(join(this.rootDir, repoId), { recursive: true });
      await appendFile(this.bodyPath(repoId, id), chunk, 'utf8');
    });
    // Normalised so one failed append never poisons the chain for the next
    // chunk, and never surfaces as an unhandled rejection.
    const settled = result.catch(() => {});
    this.bodyChains.set(key, settled);
    void settled.then(() => {
      if (this.bodyChains.get(key) === settled) this.bodyChains.delete(key);
    });
    return result;
  }

  /**
   * Replaces the body wholesale. The streamed text is raw CLI stdout; the
   * provider-specific post-processing only exists on the value the service
   * returns, so the finished document must be rewritten from that.
   */
  public async writeBody(repoId: string, id: string, content: string): Promise<void> {
    const key = `${repoId}/${id}`;
    const previous = this.bodyChains.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      await mkdir(join(this.rootDir, repoId), { recursive: true });
      await writeFile(this.bodyPath(repoId, id), content, 'utf8');
    });
    const settled = result.catch(() => {});
    this.bodyChains.set(key, settled);
    void settled.then(() => {
      if (this.bodyChains.get(key) === settled) this.bodyChains.delete(key);
    });
    return result;
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

  /** Split out so a test can make a single read observe a transient state. */
  private async readIndexFile(repoId: string): Promise<string | null> {
    return readFile(this.indexPath(repoId), 'utf8').catch(() => null);
  }

  /**
   * `rebuildIndex` is destructive — it replaces every entry with an `unknown`
   * skeleton — so it must only ever run for a genuinely corrupt file. An empty
   * or unparseable read is treated as transient and retried once first.
   */
  private async readIndex(repoId: string, attempt = 0): Promise<ReviewEntry[]> {
    const raw = await this.readIndexFile(repoId);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as ReviewEntry[];
    } catch {
      // fall through to the retry / rebuild below
    }
    if (attempt === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
      return this.readIndex(repoId, attempt + 1);
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

  /**
   * Write-then-rename. A plain `writeFile` truncates before it writes, so any
   * reader landing in that window sees an empty file; `rename` is atomic on
   * POSIX and on NTFS, so a reader sees either the old index or the new one.
   */
  private async writeIndex(repoId: string, entries: ReviewEntry[]): Promise<void> {
    await mkdir(join(this.rootDir, repoId), { recursive: true });
    const target = this.indexPath(repoId);
    const temporary = `${target}.${process.pid}.${++this.tempCounter}.tmp`;
    await writeFile(temporary, JSON.stringify(entries, null, 2), 'utf8');
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
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
   * for that repoId, ensuring read-modify-write cycles are atomic.
   *
   * The stored promise is normalised with `.catch(() => {})` so a rejected critical
   * section never poisons the chain for the next caller on this repoId, and so
   * Node never logs an unhandled-rejection warning for a caller who doesn't await
   * the promise returned here.
   */
  private async withIndexLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.indexMutexes.get(repoId) ?? Promise.resolve();
    const result = current.then(() => fn());
    this.indexMutexes.set(repoId, result.catch(() => {}));
    return result;
  }
}
