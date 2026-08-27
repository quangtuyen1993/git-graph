import { ForgeError } from '../forge.types';
import type { ForgeErrorKind } from '../forge.types';
import { GITHUB_API_BASE } from './github-constants';

const GITHUB_API_ORIGIN = new URL(GITHUB_API_BASE).origin;

/**
 * Ceiling on how long a 403 rate-limit response can pause every queued
 * request. GitHub's primary limit can legitimately report a reset almost an
 * hour away; blocking the extension host for that long is worse than
 * retrying periodically and surfacing a rate-limited message in the
 * meantime, so the pause is capped the same way Bitbucket caps a 429's
 * Retry-After.
 */
const MAX_PAUSE_MS = 5 * 60 * 1000;

/**
 * GitHub explicitly recommends against firing concurrent requests for a
 * single token — doing so is itself a common trigger for the *secondary*
 * rate limit, which Bitbucket's API has no equivalent of. Opening the pull
 * request section still fans out a list, a detail (plus its reviews) and a
 * diffstat at once, so some concurrency is kept, just less than Bitbucket's.
 */
export const MAX_CONCURRENT_REQUESTS = 2;

/**
 * Guards `getPaged` against a malformed or self-referential `next` Link
 * header spinning forever. GitHub's page sizes make any real pull request
 * list, review list or file list finish in single digits of pages.
 */
const MAX_PAGINATION_PAGES = 200;

/**
 * GitHub's wording for "a pull request between these branches is already
 * open" lives in a validation error's `message` field, not a machine
 * -readable code — this is the pattern `classify` matches against when
 * `detectDuplicate` is set. Deliberately loose, the same reasoning as
 * Bitbucket's equivalent pattern: a minor wording change on GitHub's side
 * should not silently stop matching.
 */
const DUPLICATE_PULL_REQUEST_PATTERN = /pull request already exists/i;

export interface GitHubApiDeps {
  getToken: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Duplicate detection is body-aware (see `classify`) and scoped to callers
 * that opt in, the same reasoning as Bitbucket's identical option: a bare
 * 422 means something different on every other endpoint (an invalid branch
 * name, no commits between branches), so guessing from the message alone on
 * every request would misclassify those. Only `createPullRequest` sets this.
 */
interface RequestClassifyOpts {
  detectDuplicate?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}

export class GitHubApi {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Epoch ms before which no request may start, set by a rate-limited 403. */
  private pausedUntil = 0;

  constructor(private readonly deps: GitHubApiDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  public async getJson<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    const { body } = await this.request<T>(path, { method: 'GET', headers: extraHeaders }, 'json');
    return body;
  }

  public async getText(path: string, extraHeaders?: Record<string, string>): Promise<string> {
    const { body } = await this.request<string>(path, { method: 'GET', headers: extraHeaders }, 'text');
    return body;
  }

  public async post<T>(path: string, body: unknown, opts?: RequestClassifyOpts): Promise<T> {
    const result = await this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 'json', opts);
    return result.body;
  }

  public async put<T>(path: string, body: unknown): Promise<T> {
    const result = await this.request<T>(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 'json');
    return result.body;
  }

  public async del(path: string): Promise<void> {
    await this.request<unknown>(path, { method: 'DELETE' }, 'none');
  }

  /** Walks GitHub's `Link: <url>; rel="next"` header and concatenates every page. */
  public async getPaged<T>(path: string): Promise<T[]> {
    const collected: T[] = [];
    let next: string | undefined = path;
    let pageCount = 0;

    while (next) {
      if (pageCount >= MAX_PAGINATION_PAGES) {
        throw new ForgeError(
          'other', 0,
          `GitHub pagination did not finish within ${MAX_PAGINATION_PAGES} pages (last link: ${next})`,
        );
      }
      pageCount += 1;

      const { body, link } = await this.request<T[]>(next, { method: 'GET' }, 'json');
      collected.push(...body);
      next = parseNextLink(link);
    }
    return collected;
  }

  private async request<T>(
    path: string, init: RequestInit, parse: 'json' | 'text' | 'none', opts?: RequestClassifyOpts,
  ): Promise<{ body: T; link: string | null }> {
    const token = await this.deps.getToken();
    // Mirrors Bitbucket's missing-credential path: the UI shows the same
    // signed-out state for a missing token as for an expired one, so this
    // reuses 'unauthorized' rather than inventing a second signed-out path.
    if (!token) throw new ForgeError('unauthorized', 401, 'Not signed in to GitHub');

    const url = path.startsWith('http') ? path : `${GITHUB_API_BASE}${path}`;
    // `path` here can be a server-supplied Link header value (getPaged)
    // rather than one this module built. Accepting it unchecked would let a
    // hijacked or malicious response redirect the Bearer token to an
    // arbitrary origin — same defence as bitbucket-api.ts's origin check.
    if (path.startsWith('http') && new URL(url).origin !== GITHUB_API_ORIGIN) {
      throw new ForgeError('other', 0, `Refusing to follow a link to a different origin: ${url}`);
    }

    await this.acquire();
    try {
      await this.waitForPause();

      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) throw await this.toForgeError(response, opts);
      const link = response.headers.get('link');
      if (parse === 'none') return { body: undefined as T, link };
      const body = (parse === 'text' ? await response.text() : await response.json()) as T;
      return { body, link };
    } finally {
      this.release();
    }
  }

  private async toForgeError(response: Response, opts?: RequestClassifyOpts): Promise<ForgeError> {
    let hostMessage = response.statusText || `HTTP ${response.status}`;
    try {
      const body = await response.json() as { message?: string; errors?: { message?: string }[] };
      const errorMessages = (body?.errors ?? []).map((e) => e.message).filter((m): m is string => Boolean(m));
      if (errorMessages.length > 0) hostMessage = errorMessages.join('; ');
      else if (body?.message) hostMessage = body.message;
    } catch {
      // A non-JSON error body leaves the status line as the message.
    }

    const { kind, retryAfterSeconds } = this.classify(response, hostMessage, opts?.detectDuplicate ?? false);
    return new ForgeError(kind, response.status, hostMessage, retryAfterSeconds);
  }

  /**
   * GitHub's status codes mapped to the shared vocabulary. Only a provider
   * may do this mapping — see the identical reasoning in
   * bitbucket-api.ts's `classify`. GitHub differs from Bitbucket in two
   * ways this method must account for:
   *
   *  - both of GitHub's rate limits report as 403, not 429 (Bitbucket's
   *    status): the primary limit is distinguished by an
   *    `x-ratelimit-remaining: 0` header, the secondary limit by a
   *    `retry-after` header. A 403 carrying neither is a real permission
   *    failure ('forbidden').
   *  - GitHub reports "a pull request between these branches already
   *    exists" as 422, not Bitbucket's 400 — `detectDuplicate` gates this
   *    exactly like Bitbucket's `classify`, since 422 is GitHub's generic
   *    validation-failure status and covers many other cases (an invalid
   *    branch name, no commits between branches) that must not be
   *    misreported as a duplicate.
   */
  private classify(
    response: Response, hostMessage: string, detectDuplicate: boolean,
  ): { kind: ForgeErrorKind; retryAfterSeconds?: number } {
    if (response.status === 403) {
      const retryAfterHeader = response.headers.get('retry-after');
      if (retryAfterHeader) {
        // Secondary rate limit: hold every queued request, extending
        // (never shortening) the pause — identical reasoning to Bitbucket's
        // 429 handling, see waitForPause.
        return { kind: 'rate-limited', retryAfterSeconds: this.applyPause(this.parseRetryAfter(retryAfterHeader)) };
      }
      if (response.headers.get('x-ratelimit-remaining') === '0') {
        const resetHeader = response.headers.get('x-ratelimit-reset');
        const resetEpochSeconds = resetHeader ? Number(resetHeader) : NaN;
        const rawSeconds = Number.isFinite(resetEpochSeconds)
          ? Math.max(1, Math.ceil(resetEpochSeconds - Date.now() / 1000))
          : 60;
        return { kind: 'rate-limited', retryAfterSeconds: this.applyPause(rawSeconds) };
      }
      return { kind: 'forbidden' };
    }
    if (detectDuplicate && response.status === 422 && DUPLICATE_PULL_REQUEST_PATTERN.test(hostMessage)) {
      return { kind: 'duplicate' };
    }
    switch (response.status) {
      case 401: return { kind: 'unauthorized' };
      case 404: return { kind: 'not-found' };
      default:  return { kind: 'other' };
    }
  }

  /**
   * Clamps a rate-limit wait to MAX_PAUSE_MS and extends (never shortens)
   * the queue-wide pause, then returns the clamped seconds to report on the
   * ForgeError — identical reasoning to bitbucket-api.ts's toForgeError.
   */
  private applyPause(rawSeconds: number): number {
    const clampedPauseMs = Math.min(rawSeconds * 1000, MAX_PAUSE_MS);
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + clampedPauseMs);
    return clampedPauseMs / 1000;
  }

  /**
   * Retry-After is delta-seconds or an HTTP-date (RFC 9110 §10.2.3), the
   * same as Bitbucket's 429. Anything that parses as neither falls back to
   * 60s rather than firing again immediately.
   */
  private parseRetryAfter(header: string): number {
    const deltaSeconds = Number(header);
    if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) return deltaSeconds;

    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
      const untilDate = Math.ceil((dateMs - Date.now()) / 1000);
      if (untilDate > 0) return untilDate;
    }
    return 60;
  }

  /**
   * Waits out `pausedUntil`, then re-checks it — identical reasoning to
   * bitbucket-api.ts's `waitForPause`: a concurrent request can extend the
   * deadline while this one was asleep.
   */
  private async waitForPause(): Promise<void> {
    let deadline = this.pausedUntil;
    for (;;) {
      const wait = deadline - Date.now();
      if (wait <= 0) return;
      await this.sleep(wait);
      if (this.pausedUntil <= deadline) return;
      deadline = this.pausedUntil;
    }
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_REQUESTS) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => { this.active += 1; resolve(); });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}
