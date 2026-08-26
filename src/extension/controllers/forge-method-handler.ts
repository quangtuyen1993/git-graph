import { parseRemoteUrl } from '../services/forge/remote-url';
import { DIFF_TTL_MS, PR_DETAIL_TTL_MS, PR_LIST_TTL_MS } from '../services/forge/forge-store';
import type { ForgeStore } from '../services/forge/forge-store';
import type { ForgeRegistry } from '../services/forge/forge-registry';
import { ForgeError } from '../services/forge/forge.types';
import type {
  ForgeCapabilities, ForgeProvider, ForgeRepoRef, PullRequestListState,
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
        const resolved = await requireForge();
        // Optional on ForgeProvider: a provider that only consumes a
        // session it does not own (e.g. one built on VS Code's built-in
        // `github` provider) has no API to remove one. Answer with
        // guidance instead of throwing or silently doing nothing.
        if (!resolved.provider.signOut) {
          return {
            success: false,
            guidance: `Sign out of ${resolved.provider.name} from the VS Code Accounts menu.`,
          };
        }
        await resolved.provider.signOut();
        deps.store.invalidate(resolved.prefix);
        deps.broadcast('forge.changed', {});
        return { success: true };
      }

      case 'forge.refresh': {
        const resolved = await requireForge();
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

      case 'forge.pr.openExternal': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const cached = await deps.store.fetch(
          `${prefix}pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));
        await deps.openExternal(cached.value.webUrl);
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
