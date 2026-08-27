import { ForgeError } from '../forge.types';
import type { ForgeErrorKind } from '../forge.types';
import { parseRetryAfterHeader, RequestQueue } from '../request-queue';
import type { BitbucketCredentials } from './bitbucket-auth';

export const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0';

const BITBUCKET_API_ORIGIN = new URL(BITBUCKET_API_BASE).origin;

/**
 * Ceiling on how long a 429 can pause every queued request. A well-behaved
 * server sends a Retry-After of a few seconds; a misconfigured or malicious
 * one sending a day-long value must not be allowed to wedge the extension for
 * that long — cap the pause rather than trust the header outright.
 */
const MAX_PAUSE_MS = 5 * 60 * 1000;

/**
 * Opening the pull request section fires a list, a detail and a diffstat at
 * once, across every open repository. Bitbucket allows roughly 1000 requests
 * per hour, so the fan-out is capped rather than left to the event loop.
 */
export const MAX_CONCURRENT_REQUESTS = 4;

export interface BitbucketApiDeps {
  getCredentials: () => Promise<BitbucketCredentials | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface PagedResponse<T> {
  values?: T[];
  next?: string;
}

/**
 * Duplicate detection is body-aware (see `classify`) and scoped to callers
 * that opt in — a bare 400 means something different on every other
 * endpoint (a malformed body, an invalid reviewer id), so guessing from the
 * message alone on every request would misclassify those. Only
 * `createPullRequest` sets this.
 */
interface RequestClassifyOpts {
  detectDuplicate?: boolean;
}

/**
 * Bitbucket's wording for "a pull request between these branches is already
 * open" is prose, not a machine-readable field — this is the pattern
 * `classify` matches against when `detectDuplicate` is set. Deliberately
 * loose (case-insensitive, no anchors) so a minor wording change on
 * Bitbucket's side doesn't silently stop matching.
 */
const DUPLICATE_PULL_REQUEST_PATTERN = /already.*(open )?pull request|pull request.*already exists/i;

/**
 * Guards `getPaged` against a malformed or self-referential `next` link
 * spinning forever and burning the request budget. Bitbucket's page sizes
 * make any real pull request list finish in single digits of pages.
 */
const MAX_PAGINATION_PAGES = 200;

/**
 * The `/repositories/{owner}/{name...}` path shared by `BitbucketCloudProvider.base`
 * and the sign-in verification probe (bitbucket-sign-in.ts) — one implementation of
 * the traversal guard rather than two, so a future change to it cannot fix one call
 * site and silently leave the other exploitable. `.`, `..` and empty segments are
 * refused for the same reason `BitbucketCloudProvider.base`'s original doc comment
 * gave: `encodeURIComponent` does not escape `.` (RFC 3986 unreserved), so a `..`
 * segment left unchecked here would reach `/repositories/../x` and let the WHATWG
 * URL parser inside `fetch` collapse it into a path outside `/repositories`,
 * carrying this client's Authorization header with it.
 */
export function bitbucketRepoPath(repo: { owner: string; name: string }): string {
  const segments = [repo.owner, ...repo.name.split('/')];
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ForgeError('other', 0, `Invalid repository reference: ${repo.owner}/${repo.name}`);
  }
  return `/repositories/${segments.map(encodeURIComponent).join('/')}`;
}

export class BitbucketApi {
  private readonly fetchImpl: typeof fetch;
  private readonly queue: RequestQueue;

  constructor(private readonly deps: BitbucketApiDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.queue = new RequestQueue({
      maxConcurrent: MAX_CONCURRENT_REQUESTS, maxPauseMs: MAX_PAUSE_MS, sleep: deps.sleep,
    });
  }

  public async getJson<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' }, 'json');
  }

  public async getText(path: string): Promise<string> {
    return this.request<string>(path, { method: 'GET' }, 'text');
  }

  public async post<T>(path: string, body: unknown, opts?: RequestClassifyOpts): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 'json', opts);
  }

  public async postEmpty(path: string): Promise<void> {
    await this.request<unknown>(path, { method: 'POST' }, 'none');
  }

  /** Walks Bitbucket's `next` links and concatenates every `values` page. */
  public async getPaged<T>(path: string): Promise<T[]> {
    const collected: T[] = [];
    let next: string | undefined = path;
    let pageCount = 0;

    while (next) {
      if (pageCount >= MAX_PAGINATION_PAGES) {
        throw new ForgeError(
          'other', 0,
          `Bitbucket pagination did not finish within ${MAX_PAGINATION_PAGES} pages (last link: ${next})`,
        );
      }
      pageCount += 1;

      const page: PagedResponse<T> = await this.getJson<PagedResponse<T>>(next);
      collected.push(...(page.values ?? []));
      next = page.next;
    }
    return collected;
  }

  private async request<T>(
    path: string, init: RequestInit, parse: 'json' | 'text' | 'none', opts?: RequestClassifyOpts,
  ): Promise<T> {
    const credentials = await this.deps.getCredentials();
    // 401 is the same state the UI shows for an expired token, so a missing
    // credential reuses it rather than inventing a second signed-out path.
    if (!credentials) throw new ForgeError('unauthorized', 401, 'Not signed in to Bitbucket');

    const url = path.startsWith('http') ? path : `${BITBUCKET_API_BASE}${path}`;
    // `path` here can be a server-supplied `next` pagination link (getPaged)
    // rather than one this module built. Accepting it unchecked would let a
    // hijacked or malicious response redirect the Basic auth header — the
    // credential — to an arbitrary origin. Anything absolute must land back
    // on the API's own origin; this also closes off a plaintext `http://`
    // link, since `startsWith('http')` alone accepts that too.
    if (path.startsWith('http') && new URL(url).origin !== BITBUCKET_API_ORIGIN) {
      throw new ForgeError('other', 0, `Refusing to follow a link to a different origin: ${url}`);
    }
    // Bearer, not Basic — and this is the only scheme this client ever sends.
    // Atlassian's own docs (support.atlassian.com/bitbucket-cloud/docs/using-api-tokens,
    // .../using-access-tokens) establish two distinct token families for Bitbucket
    // Cloud: an Atlassian-account API token (id.atlassian.com), which accepts
    // *either* HTTP Basic (email:token) *or* Bearer, and a repository/project/
    // workspace access token (created in Bitbucket's own settings, not tied to
    // any account), which accepts *only* Bearer — Basic on an access token is
    // what produced the 403-on-every-scoped-endpoint this fix responds to.
    // Bearer is the intersection of what both families accept, so sending it
    // unconditionally serves either kind without this client ever having to
    // know, ask, or remember which one a credential is — no per-credential
    // scheme flag, no probing request. `credentials.email` is therefore never
    // read here; it survives only as an optional display label the sign-in
    // flow may collect (see bitbucket-sign-in.ts).
    const authorization = `Bearer ${credentials.token}`;

    return this.queue.run(async () => {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers ?? {}), Authorization: authorization },
      });

      if (!response.ok) throw await this.toForgeError(response, opts);
      if (parse === 'none') return undefined as T;
      return (parse === 'text' ? await response.text() : await response.json()) as T;
    });
  }

  private async toForgeError(response: Response, opts?: RequestClassifyOpts): Promise<ForgeError> {
    let hostMessage = response.statusText || `HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      if (body?.error?.message) hostMessage = body.error.message;
    } catch {
      // A non-JSON error body leaves the status line as the message.
    }

    let retryAfterSeconds: number | undefined;
    if (response.status === 429) {
      // Hold every queued request, not just this one: they would all hit the
      // same limit and turn one breach into a wall of identical failures.
      // applyPause clamps to MAX_PAUSE_MS and extends (never shortens) the
      // shared deadline — see request-queue.ts.
      const rawRetryAfterSeconds = parseRetryAfterHeader(response.headers.get('retry-after'));
      retryAfterSeconds = this.queue.applyPause(rawRetryAfterSeconds);
    }

    return new ForgeError(
      this.classify(response.status, hostMessage, opts?.detectDuplicate ?? false),
      response.status, hostMessage, retryAfterSeconds,
    );
  }

  /**
   * Bitbucket's status codes mapped to the shared vocabulary. This mapping is
   * the one thing only a provider can do: another host signals rate limiting
   * with a status this one uses for permission failures, and reports a
   * duplicate with a different code again. Everything above the provider
   * switches on the resulting kind and never on the number.
   *
   * 400 is 'other' by default, not 'duplicate': Bitbucket returns 400 for
   * every malformed request body, unknown merge strategy or invalid reviewer
   * id, not only for the thing being created already existing — classifying
   * every 400 as a duplicate would misreport a typo'd reviewer id as
   * "already exists". `detectDuplicate` (set only by `createPullRequest`)
   * additionally requires the body to actually say so, matched against
   * `DUPLICATE_PULL_REQUEST_PATTERN`.
   */
  private classify(status: number, hostMessage: string, detectDuplicate: boolean): ForgeErrorKind {
    if (detectDuplicate && status === 400 && DUPLICATE_PULL_REQUEST_PATTERN.test(hostMessage)) {
      return 'duplicate';
    }
    switch (status) {
      case 401: return 'unauthorized';
      case 403: return 'forbidden';
      case 404: return 'not-found';
      case 429: return 'rate-limited';
      default:  return 'other';
    }
  }
}
