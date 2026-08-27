import type {
  CreatePullRequestInput, ForgeCapabilities, ForgeComment, ForgeError, ForgeProvider, ForgeRepoRef,
  ForgeSession, MergeStrategy, ParsedRemote, PullRequestDetail, PullRequestFile, PullRequestListState,
  PullRequestSummary,
} from '../../src/extension/services/forge/forge.types';

export interface FakeForgeOptions {
  id?: string;
  name?: string;
  host?: string;
  session?: ForgeSession | undefined;
  /** When set, `getSession({ createIfNone: true })` never establishes a session — simulates rejected credentials. */
  signInFails?: boolean;
  /**
   * When `false`, this provider has no `signOut` member at all — simulates a
   * provider (e.g. GitHub, via VS Code's built-in `github` provider) that
   * consumes a session it does not own and so has no API to remove one.
   * Defaults to `true`.
   */
  signOutSupported?: boolean;
  pullRequests?: PullRequestDetail[];
  diff?: string;
  files?: PullRequestFile[];
  comments?: ForgeComment[];
  capabilities?: Partial<ForgeCapabilities>;
}

export const FAKE_USER = { displayName: 'An Tran', accountId: 'acc-1' };

export const FAKE_PR_FILES: PullRequestFile[] = [
  { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 4, deletions: 1, binary: false },
];

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
  public readonly filesResult: PullRequestFile[];
  /** Optional, per the amended ForgeProvider interface — see FakeForgeOptions.signOutSupported. */
  public signOut?: () => Promise<void>;

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
    // 'session' in options (rather than ??) so an explicit `session: undefined`
    // simulates a signed-out provider instead of falling through to the default
    // signed-in session — the two must be distinguishable for tests that need
    // "no session, and don't prompt for one".
    this.session = 'session' in options ? options.session : { providerId: this.id, accountLabel: 'An Tran' };
    this.signInFails = options.signInFails ?? false;
    this.pullRequests = options.pullRequests ?? [fakePullRequest()];
    this.diff = options.diff ?? 'diff --git a/a.ts b/a.ts\n';
    this.filesResult = options.files ?? FAKE_PR_FILES;
    this.comments = options.comments ?? [];
    this.capabilities = {
      createPullRequest: true, approve: true, requestChanges: true, merge: true,
      mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
      ...options.capabilities,
    };
    if (options.signOutSupported ?? true) {
      this.signOut = async () => {
        this.record('signOut');
        this.session = undefined;
      };
    }
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

  public async getPullRequestFiles(repo: ForgeRepoRef, id: string): Promise<PullRequestFile[]> {
    this.record('getPullRequestFiles', repo, id);
    return this.filesResult;
  }

  public async listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]> {
    this.record('listComments', repo, id);
    return this.comments;
  }

  public async createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail> {
    this.record('createPullRequest', repo, input);
    return fakePullRequest({ title: input.title, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch });
  }

  /**
   * Mutates the matching pull request's reviewers so a subsequent
   * getPullRequest/listPullRequests call (in the common, lag-free case)
   * reflects the write — the same way a real host does most of the time.
   * The reviewer patched is whoever this fake's current session claims to
   * be, matched by display name; a test that wants to simulate the host's
   * read side lagging behind the write overrides getPullRequest/
   * listPullRequests directly afterwards (see forge-method-handler.test.ts).
   */
  public async setReviewStatus(
    repo: ForgeRepoRef,
    id: string,
    status: 'approved' | 'changes_requested',
    opts?: { body?: string },
  ): Promise<void> {
    this.record('setReviewStatus', repo, id, status, opts);
    const pr = this.pullRequests.find((candidate) => candidate.id === id);
    if (!pr) return;
    const label = this.session?.accountLabel;
    const idx = pr.reviewers.findIndex((reviewer) => reviewer.user.displayName === label);
    const user = idx === -1 ? { ...FAKE_USER, displayName: label ?? FAKE_USER.displayName } : pr.reviewers[idx].user;
    pr.reviewers = idx === -1
      ? [...pr.reviewers, { user, status }]
      : pr.reviewers.map((reviewer, i) => (i === idx ? { ...reviewer, status } : reviewer));
  }

  public async merge(repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void> {
    this.record('merge', repo, id, opts);
    const idx = this.pullRequests.findIndex((candidate) => candidate.id === id);
    if (idx !== -1) this.pullRequests[idx] = { ...this.pullRequests[idx], state: 'merged' };
  }

  public describeError(error: ForgeError): string {
    this.record('describeError', error);
    return `${this.name}: ${error.kind} (${error.hostMessage})`;
  }
}
