import type {
  CreatePullRequestInput, ForgeCapabilities, ForgeComment, ForgeError, ForgeProvider, ForgeRepoRef,
  ForgeSession, MergeStrategy, ParsedRemote, PullRequestDetail, PullRequestListState,
  PullRequestSummary,
} from '../../src/extension/services/forge/forge.types';

export interface FakeForgeOptions {
  id?: string;
  name?: string;
  host?: string;
  session?: ForgeSession | undefined;
  /** When set, `getSession({ createIfNone: true })` never establishes a session — simulates rejected credentials. */
  signInFails?: boolean;
  pullRequests?: PullRequestDetail[];
  diff?: string;
  comments?: ForgeComment[];
  capabilities?: Partial<ForgeCapabilities>;
}

export const FAKE_USER = { displayName: 'An Tran', accountId: 'acc-1' };

/** A PullRequestDetail with every field populated, overridable per test. */
export function fakePullRequest(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    id: '123', number: 123, title: 'fix(auth): refresh token race',
    state: 'open', author: FAKE_USER,
    sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
    reviewers: [{ user: FAKE_USER, status: 'approved' }],
    commentCount: 2, webUrl: 'https://bitbucket.org/acme/mpos/pull-requests/123',
    updatedAt: '2026-08-25T10:00:00Z',
    description: 'body', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
    mergeable: 'clean',
    ...overrides,
  };
}

/**
 * An in-memory ForgeProvider. Every controller and UI test runs against this,
 * which is what keeps those tests off the network.
 */
export class FakeForgeProvider implements ForgeProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly capabilities: ForgeCapabilities;
  public readonly calls: { method: string; args: unknown[] }[] = [];

  private session: ForgeSession | undefined;
  private readonly host: string;
  private readonly signInFails: boolean;
  private readonly pullRequests: PullRequestDetail[];
  private readonly diff: string;
  private readonly comments: ForgeComment[];

  constructor(options: FakeForgeOptions = {}) {
    this.id = options.id ?? 'fake';
    this.name = options.name ?? 'Fake';
    this.host = options.host ?? 'fake.test';
    this.session = options.session ?? { providerId: this.id, accountLabel: 'An Tran' };
    this.signInFails = options.signInFails ?? false;
    this.pullRequests = options.pullRequests ?? [fakePullRequest()];
    this.diff = options.diff ?? 'diff --git a/a.ts b/a.ts\n';
    this.comments = options.comments ?? [];
    this.capabilities = {
      createPullRequest: true, approve: true, requestChanges: true, merge: true,
      mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
      ...options.capabilities,
    };
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  public canHandle(remote: ParsedRemote): boolean { return remote.host === this.host; }

  public async getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined> {
    this.record('getSession', opts);
    if (!this.session && opts?.createIfNone && !this.signInFails) {
      this.session = { providerId: this.id, accountLabel: 'An Tran' };
    }
    return this.session;
  }

  public async signOut(): Promise<void> {
    this.record('signOut');
    this.session = undefined;
  }

  public async listPullRequests(repo: ForgeRepoRef, opts: { state: PullRequestListState }): Promise<PullRequestSummary[]> {
    this.record('listPullRequests', repo, opts);
    return this.pullRequests.filter((pr) =>
      opts.state === 'open' ? pr.state === 'open' || pr.state === 'draft' : pr.state === opts.state);
  }

  public async getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail> {
    this.record('getPullRequest', repo, id);
    const found = this.pullRequests.find((pr) => pr.id === id);
    if (!found) throw new Error(`No such pull request: ${id}`);
    return found;
  }

  public async getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string> {
    this.record('getPullRequestDiff', repo, id);
    return this.diff;
  }

  public async listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]> {
    this.record('listComments', repo, id);
    return this.comments;
  }

  public async createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail> {
    this.record('createPullRequest', repo, input);
    return fakePullRequest({ title: input.title, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch });
  }

  public async setReviewStatus(
    repo: ForgeRepoRef,
    id: string,
    status: 'approved' | 'changes_requested',
    opts?: { body?: string },
  ): Promise<void> {
    this.record('setReviewStatus', repo, id, status, opts);
  }

  public async merge(repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void> {
    this.record('merge', repo, id, opts);
  }

  public describeError(error: ForgeError): string {
    this.record('describeError', error);
    return `${this.name}: ${error.kind} (${error.hostMessage})`;
  }
}
