import { parseRemoteUrl } from '../services/forge/remote-url';
import { DIFF_TTL_MS, PR_DETAIL_TTL_MS, PR_LIST_TTL_MS, REPO_INFO_TTL_MS } from '../services/forge/forge-store';
import type { ForgeStore } from '../services/forge/forge-store';
import type { ForgeRegistry } from '../services/forge/forge-registry';
import { ForgeError } from '../services/forge/forge.types';
import type {
  CreatePullRequestInput, ForgeCapabilities, ForgeProvider, ForgeRepoRef, MergeStrategy, PullRequestDetail,
  PullRequestListState, PullRequestSummary, ReviewStatus,
} from '../services/forge/forge.types';

export interface ForgeStatus {
  available: boolean;
  providerId?: string;
  providerName?: string;
  signedIn?: boolean;
  accountLabel?: string;
  repo?: ForgeRepoRef;
  capabilities?: ForgeCapabilities;
}

/**
 * `forge.signOut`'s result. `guidance` is present only when `success` is
 * `false` — the provider has no `signOut()` (see `ForgeProvider.signOut`),
 * so nothing was signed out and the caller must surface `guidance` itself
 * rather than treat the call as having done nothing.
 */
export interface ForgeSignOutResult {
  success: boolean;
  guidance?: string;
}

export interface ForgeHandlerDeps {
  registry: ForgeRegistry;
  store: ForgeStore;
  getRemoteUrl: () => Promise<string | undefined>;
  broadcast: (event: string, data?: unknown) => void;
  openExternal: (url: string) => Promise<void>;
}

interface Resolved {
  provider: ForgeProvider;
  repo: ForgeRepoRef;
  /** Cache key prefix for everything belonging to this repository. */
  prefix: string;
}

const LIST_STATES: ReadonlySet<string> = new Set(['open', 'merged', 'closed']);

/**
 * Thrown by `forge.pr.create` when the host reports a duplicate — a pull
 * request between these branches already exists. Not a `ForgeError`
 * deliberately: `handle()`'s catch only translates `ForgeError` instances,
 * and this must reach the webview with its own message (naming the existing
 * pull request) and `data` intact, not be rewritten into `error.hostMessage`.
 * `code` rides the same `err.code` → `response.error.kind` channel
 * `BranchNotFullyMergedError` already uses (see message-router.ts); `data`
 * rides the sibling `err.data` → `response.error.data` channel this phase adds.
 */
export class PullRequestDuplicateError extends Error {
  public readonly code = 'PR_DUPLICATE';
  public readonly data: { existing: PullRequestSummary };

  constructor(existing: PullRequestSummary) {
    super(`PR #${existing.number} already exists for these branches`);
    this.name = 'PullRequestDuplicateError';
    this.data = { existing };
  }
}

export function createForgeHandler(deps: ForgeHandlerDeps) {
  async function resolve(): Promise<Resolved | undefined> {
    const url = await deps.getRemoteUrl();
    if (!url) return undefined;

    const remote = parseRemoteUrl(url);
    if (!remote) return undefined;

    const provider = deps.registry.resolve(remote);
    if (!provider) return undefined;

    const repo = { host: remote.host, owner: remote.owner, name: remote.name };
    // Terminated with ':' so ForgeStore.invalidate's bare startsWith match
    // cannot cross into a sibling repository whose name extends this one's
    // (e.g. 'mpos' vs 'mpos2') — without the delimiter, invalidating 'mpos'
    // would also drop 'mpos2's cache. `host` is included too: ForgeRepoRef
    // carries it precisely so one provider serving multiple hosts (a public
    // cloud host plus a self-hosted instance) doesn't collide two repos that
    // share an owner/name across hosts.
    return { provider, repo, prefix: `${provider.id}:${repo.host}/${repo.owner}/${repo.name}:` };
  }

  async function requireForge(): Promise<Resolved> {
    const resolved = await resolve();
    // The webview gates on forge.status, so reaching here means the repository
    // changed underneath an open panel rather than a caller misbehaving.
    if (!resolved) throw new Error('No pull request provider for this repository');
    return resolved;
  }

  async function status(): Promise<ForgeStatus> {
    const resolved = await resolve();
    if (!resolved) return { available: false };

    // Never createIfNone here: status runs on every panel load and must not
    // put an input box in front of someone who never asked to sign in.
    const session = await resolved.provider.getSession();
    return {
      available: true,
      providerId: resolved.provider.id,
      providerName: resolved.provider.name,
      signedIn: Boolean(session),
      accountLabel: session?.accountLabel,
      repo: resolved.repo,
      capabilities: resolved.provider.capabilities,
    };
  }

  function listState(params: Record<string, unknown>): PullRequestListState {
    const state = params.state as string | undefined;
    return (state && LIST_STATES.has(state) ? state : 'open') as PullRequestListState;
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'forge.status':
        return status();

      case 'forge.signIn': {
        const { provider } = await requireForge();
        const session = await provider.getSession({ createIfNone: true });
        deps.broadcast('forge.changed', {});
        return { signedIn: Boolean(session), accountLabel: session?.accountLabel };
      }

      case 'forge.signOut': {
        // resolve(), not requireForge(): unlike every case above it, this
        // one is reachable from the Command Palette on any repository, not
        // only from a webview that already gated on forge.status first (see
        // requireForge()'s own comment). A repository with no forge remote
        // is the ordinary case, not a caller misbehaving — requireForge()
        // throwing here used to escape the gitGraphPro.forge.signOut command
        // uncaught, reported as a failed command with a stack trace, for a
        // state that is not a failure. Answered with guidance instead,
        // the same shape as the no-signOut() case just below.
        const resolved = await resolve();
        if (!resolved) {
          const result: ForgeSignOutResult = {
            success: false,
            guidance: 'No pull request provider is configured for this repository — nothing to sign out of.',
          };
          return result;
        }
        // Optional on ForgeProvider: a provider that only consumes a
        // session it does not own (e.g. one built on VS Code's built-in
        // `github` provider) has no API to remove one. Answer with
        // guidance instead of throwing or silently doing nothing.
        if (!resolved.provider.signOut) {
          const result: ForgeSignOutResult = {
            success: false,
            guidance: `Sign out of ${resolved.provider.name} from the VS Code Accounts menu.`,
          };
          return result;
        }
        await resolved.provider.signOut();
        deps.store.invalidate(resolved.prefix);
        deps.broadcast('forge.changed', {});
        return { success: true } satisfies ForgeSignOutResult;
      }

      case 'forge.refresh': {
        // Unlike every other case below, this one is reachable on a path
        // the user did not initiate: extension.ts calls it after every
        // git.push/pull/fetch, for whatever repository happens to be
        // active, forge remote or not. requireForge() throwing here would
        // violate the additive-only global constraint ("no errors, no
        // console noise" for a repository with no forge remote) on every
        // single push in an ordinary repository — the same reasoning
        // `status()` above already applies by returning `{ available:
        // false }` rather than throwing. Refreshing a cache that does not
        // exist is a no-op, not a failure.
        const resolved = await resolve();
        if (!resolved) return { success: true };
        deps.store.invalidate(resolved.prefix);
        deps.broadcast('forge.changed', {});
        return { success: true };
      }

      case 'forge.pr.list': {
        const { provider, repo, prefix } = await requireForge();
        const state = listState(p);
        const cached = await deps.store.fetch(
          `${prefix}list:${state}`,
          PR_LIST_TTL_MS,
          () => provider.listPullRequests(repo, { state }),
        );
        return { pullRequests: cached.value, stale: cached.stale, fetchedAt: cached.fetchedAt };
      }

      case 'forge.pr.get': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const cached = await deps.store.fetch(
          `${prefix}pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));
        return cached.value;
      }

      case 'forge.pr.comments': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const cached = await deps.store.fetch(
          `${prefix}comments:${id}`, PR_DETAIL_TTL_MS, () => provider.listComments(repo, id));
        return { comments: cached.value };
      }

      case 'forge.pr.diff': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const detail = await deps.store.fetch(
          `${prefix}pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));

        // Keyed by the sha pair rather than the id: new commits on the pull
        // request produce a different key, so this content can never go stale.
        const cached = await deps.store.fetch(
          `${prefix}diff:${detail.value.targetCommit}..${detail.value.sourceCommit}`,
          DIFF_TTL_MS,
          () => provider.getPullRequestDiff(repo, id),
        );
        return { diff: cached.value };
      }

      case 'forge.pr.files': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const detail = await deps.store.fetch(
          `${prefix}pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));

        // Same immutability argument as forge.pr.diff: keyed by the sha pair,
        // so a new commit on the pull request produces a different key and
        // this content can never go stale.
        const cached = await deps.store.fetch(
          `${prefix}files:${detail.value.targetCommit}..${detail.value.sourceCommit}`,
          DIFF_TTL_MS,
          () => provider.getPullRequestFiles(repo, id),
        );
        return { files: cached.value };
      }

      case 'forge.repoInfo': {
        const { provider, repo, prefix } = await requireForge();
        const cached = await deps.store.fetch(`${prefix}repoInfo`, REPO_INFO_TTL_MS, () => provider.getRepoInfo(repo));
        return cached.value;
      }

      case 'forge.pr.reviewerSuggestions': {
        const { provider, repo, prefix } = await requireForge();
        const cached = await deps.store.fetch(
          `${prefix}reviewerSuggestions`, REPO_INFO_TTL_MS, () => provider.listReviewerCandidates(repo));
        return { reviewers: cached.value };
      }

      case 'forge.pr.create': {
        const { provider, repo, prefix } = await requireForge();
        const input: CreatePullRequestInput = {
          title: String(p.title ?? ''),
          description: typeof p.description === 'string' ? p.description : '',
          sourceBranch: String(p.sourceBranch ?? ''),
          targetBranch: String(p.targetBranch ?? ''),
          ...(Array.isArray(p.reviewers) && p.reviewers.length > 0 ? { reviewers: p.reviewers as string[] } : {}),
          ...(typeof p.closeSourceBranch === 'boolean' ? { closeSourceBranch: p.closeSourceBranch } : {}),
        };

        try {
          const created = await provider.createPullRequest(repo, input);
          deps.store.invalidate(prefix);
          deps.broadcast('forge.changed', {});
          return created;
        } catch (error) {
          // A duplicate reports the *existing* pull request (spec's error
          // table: "PR #118 already exists for these branches" + open
          // button), which needs the open list — reused via the store's own
          // `list:open` key so this doesn't cost a second uncached fetch on
          // top of one the sidebar likely already warmed.
          if (error instanceof ForgeError && error.kind === 'duplicate') {
            const list = await deps.store.fetch(
              `${prefix}list:open`, PR_LIST_TTL_MS, () => provider.listPullRequests(repo, { state: 'open' }));
            const existing = list.value.find((candidate) =>
              candidate.sourceBranch === input.sourceBranch && candidate.targetBranch === input.targetBranch);
            if (existing) throw new PullRequestDuplicateError(existing);
          }
          throw error;
        }
      }

      case 'forge.pr.openExternal': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const cached = await deps.store.fetch(
          `${prefix}pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));
        await deps.openExternal(cached.value.webUrl);
        return { success: true };
      }

      case 'forge.pr.approve':
      case 'forge.pr.requestChanges': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const status: 'approved' | 'changes_requested' =
          method === 'forge.pr.approve' ? 'approved' : 'changes_requested';
        const body = typeof p.body === 'string' && p.body.length > 0 ? p.body : undefined;

        // Read-after-write: Bitbucket's participant list can still lag a
        // fresh GET for a moment right after the approve/request-changes
        // POST resolves (see the phase 6 plan's requirement 4). This never
        // re-reads to build its response — it patches the reviewer entry
        // for the signed-in account onto whatever detail is already cached
        // (fetching it once if nothing is), and returns that. `prefix` is
        // then invalidated so the *next* natural read — the sidebar's list
        // refresh below, a manual refresh, or reopening the panel — goes to
        // the host, which by then has almost always caught up.
        const before = await deps.store.fetch(
          `${prefix}pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));
        await provider.setReviewStatus(repo, id, status, body !== undefined ? { body } : undefined);
        const session = await provider.getSession();
        const patched = applyOptimisticReviewStatus(before.value, session?.accountLabel, status);

        deps.store.invalidate(prefix);
        deps.broadcast('forge.changed', {});
        return patched;
      }

      case 'forge.pr.merge': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const strategy = p.strategy as MergeStrategy;
        const closeSourceBranch = typeof p.closeSourceBranch === 'boolean' ? p.closeSourceBranch : undefined;

        await provider.merge(repo, id, {
          strategy,
          ...(closeSourceBranch !== undefined ? { closeSourceBranch } : {}),
        });
        deps.store.invalidate(prefix);
        deps.broadcast('forge.changed', {});
        return { success: true };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // Wraps `dispatch` so no ForgeError reaches the webview untranslated. The
  // provider that threw is re-resolved here (rather than threaded through
  // every case) so `forgeErrorMessage` never has to guess which provider
  // produced the error.
  async function handle(method: string, params: unknown): Promise<unknown> {
    try {
      return await dispatch(method, params);
    } catch (error) {
      if (error instanceof ForgeError) {
        const resolved = await resolve();
        // An expired or revoked credential must not fail silently forever:
        // the credential is still in SecretStorage and `forge.status` would
        // keep reporting signedIn: true otherwise, leaving the section stuck
        // on a stale list with no way back except the sign-out command. A
        // 401 clears the session itself, drops its cache (the same as an
        // explicit forge.signOut — otherwise a sign-out/sign-in cycle inside
        // the list TTL would serve the dead session's cached list) and tells
        // every open panel to refresh.
        if (error.kind === 'unauthorized' && resolved) {
          // Wrapped in its own try/catch so the translated ForgeError below
          // always wins. `broadcast` reaches into a webview's `.webview`,
          // which throws synchronously once the panel is disposed (the same
          // hazard extension.ts's MUTATING_REMOTE_METHODS handler already
          // guards against) — reachable here when a second panel gets this
          // 401 in the window between VS Code disposing another panel and
          // its onDidDispose running detachRouter(). A rejecting signOut()
          // (a SecretStorage failure) must not swallow the message either.
          // signOut is optional: `?.()` skips it when absent rather than
          // skipping this whole cleanup — the cache still needs dropping and
          // every open panel still needs telling, or a provider with no
          // signOut would leave the sidebar stuck on a stale signed-in list
          // forever with no way back at all.
          try {
            await resolved.provider.signOut?.();
            deps.store.invalidate(resolved.prefix);
            deps.broadcast('forge.changed', {});
          } catch (cleanupError) {
            const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            console.error(`[forge] session cleanup after a 401 failed: ${message}`);
          }
        }
        throw new Error(forgeErrorMessage(error, resolved?.provider));
      }
      throw error;
    }
  }

  return handle;
}

/**
 * The read-after-write patch for `forge.pr.approve`/`forge.pr.requestChanges`
 * (requirement 4 of the phase 6 plan): finds the reviewer entry belonging to
 * the signed-in account — matched by display name, the only identity a
 * `ForgeSession` carries — and sets its status, adding one if the acting
 * account wasn't already a reviewer (approving a pull request you weren't
 * requested on is allowed). With no session (should not happen; the write
 * itself would already have failed with 'unauthorized') the detail is
 * returned unchanged rather than guessed at.
 */
function applyOptimisticReviewStatus(
  detail: PullRequestDetail, accountLabel: string | undefined, status: ReviewStatus,
): PullRequestDetail {
  if (!accountLabel) return detail;
  const idx = detail.reviewers.findIndex((reviewer) => reviewer.user.displayName === accountLabel);
  if (idx === -1) {
    // No real accountId is available here — a ForgeSession carries only a
    // display label, and a host's account ids are opaque, host-issued
    // strings this code has no way to fabricate. `optimistic:` is a prefix
    // no real accountId would ever have, so a caller that starts treating
    // accountId as a lookup key fails loudly on this entry — rather than
    // an empty string quietly colliding with any other reviewer whose
    // accountId is also blank.
    const user = { displayName: accountLabel, accountId: `optimistic:${accountLabel}` };
    return { ...detail, reviewers: [...detail.reviewers, { user, status }] };
  }
  return {
    ...detail,
    reviewers: detail.reviewers.map((reviewer, i) => (i === idx ? { ...reviewer, status } : reviewer)),
  };
}

/**
 * Turns a host failure into something that tells the reader what to do.
 *
 * This switches on `error.kind`, never on the HTTP status, because the status
 * does not mean the same thing across hosts: one signals rate limiting with a
 * status another uses for permission failures, and they report a duplicate
 * with different codes again. Classification is the provider's job.
 *
 * The remediation half of a 'forbidden' message — which credential, which
 * scopes — is likewise the provider's, and arrives via `describeError`. Never
 * compose it here: this file must not name a hosting service.
 */
export function forgeErrorMessage(error: unknown, provider?: ForgeProvider): string {
  if (!(error instanceof ForgeError)) {
    return error instanceof Error ? error.message : String(error);
  }

  switch (error.kind) {
    case 'unauthorized':
      return 'Your session has expired or has been revoked — sign in again.';
    case 'forbidden':
      return provider?.describeError(error) ?? error.hostMessage;
    case 'not-found':
      // Delegated like 'forbidden': whether this means "no such repository"
      // or "no access to it", and why, is host-specific — a missing
      // credential permission on one host, something else entirely on
      // another — so the shared layer never composes that wording itself.
      return provider?.describeError(error) ?? error.hostMessage;
    case 'rate-limited':
      return `Rate limit reached. Retrying in ${error.retryAfterSeconds ?? 60}s.`;
    case 'duplicate':
    case 'other':
    default:
      return error.hostMessage;
  }
}
