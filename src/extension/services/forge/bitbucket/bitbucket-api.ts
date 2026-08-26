import { ForgeError } from '../forge.types';
import type { ForgeErrorKind } from '../forge.types';
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
 * Guards `getPaged` against a malformed or self-referential `next` link
 * spinning forever and burning the request budget. Bitbucket's page sizes
 * make any real pull request list finish in single digits of pages.
 */
const MAX_PAGINATION_PAGES = 200;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BitbucketApi {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Epoch ms before which no request may start, set by a 429. */
  private pausedUntil = 0;

  constructor(private readonly deps: BitbucketApiDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  public async getJson<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' }, 'json');
  }

  public async getText(path: string): Promise<string> {
    return this.request<string>(path, { method: 'GET' }, 'text');
  }

  public async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 'json');
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

  private async request<T>(path: string, init: RequestInit, parse: 'json' | 'text' | 'none'): Promise<T> {
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
    const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`;

    await this.acquire();
    try {
      await this.waitForPause();

      const response = await this.fetchImpl(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers ?? {}), Authorization: authorization },
      });

      if (!response.ok) throw await this.toForgeError(response);
      if (parse === 'none') return undefined as T;
      return (parse === 'text' ? await response.text() : await response.json()) as T;
    } finally {
      this.release();
    }
  }

  private async toForgeError(response: Response): Promise<ForgeError> {
    let hostMessage = response.statusText || `HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      if (body?.error?.message) hostMessage = body.error.message;
    } catch {
      // A non-JSON error body leaves the status line as the message.
    }

    let retryAfterSeconds: number | undefined;
    if (response.status === 429) {
      retryAfterSeconds = this.parseRetryAfter(response.headers.get('retry-after'));
      // Hold every queued request, not just this one: they would all hit the
      // same limit and turn one breach into a wall of identical failures.
      // Extend rather than overwrite: under the concurrency cap, several
      // requests can each land a 429 around the same time, and a later one
      // with a *shorter* Retry-After must not cut a longer pause short.
      this.pausedUntil = Math.max(
        this.pausedUntil,
        Date.now() + Math.min(retryAfterSeconds * 1000, MAX_PAUSE_MS),
      );
    }

    return new ForgeError(this.classify(response.status), response.status, hostMessage, retryAfterSeconds);
  }

  /**
   * Retry-After is delta-seconds or an HTTP-date (RFC 9110 §10.2.3); Bitbucket
   * has been seen to send either. Anything that parses as neither falls back
   * to 60s rather than firing again immediately.
   */
  private parseRetryAfter(header: string | null): number {
    if (header) {
      const deltaSeconds = Number(header);
      if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) return deltaSeconds;

      const dateMs = Date.parse(header);
      if (!Number.isNaN(dateMs)) {
        const untilDate = Math.ceil((dateMs - Date.now()) / 1000);
        if (untilDate > 0) return untilDate;
      }
    }
    return 60;
  }

  /**
   * Bitbucket's status codes mapped to the shared vocabulary. This mapping is
   * the one thing only a provider can do: another host signals rate limiting
   * with a status this one uses for permission failures, and reports a
   * duplicate with a different code again. Everything above the provider
   * switches on the resulting kind and never on the number.
   *
   * 400 is deliberately 'other', not 'duplicate': Bitbucket returns 400 for
   * every malformed request body, unknown merge strategy or invalid reviewer
   * id, not only for the thing being created already existing. Phase 5's
   * duplicate-pull-request handling will branch on 'duplicate', and reporting
   * "already exists" for, say, a typo'd reviewer id would be wrong.
   */
  private classify(status: number): ForgeErrorKind {
    switch (status) {
      case 401: return 'unauthorized';
      case 403: return 'forbidden';
      case 404: return 'not-found';
      case 429: return 'rate-limited';
      default:  return 'other';
    }
  }

  /**
   * Waits out `pausedUntil`, then re-checks it: a concurrent request can
   * extend the deadline (see `toForgeError`) while this one was asleep, and
   * firing on the earlier, shorter deadline it started with would defeat the
   * point of a queue-wide pause. Loops only while the deadline itself has
   * moved further out since the last sleep — not against the raw clock —
   * so it still resolves in one pass under a mocked, instantly-resolving
   * `sleep` when nothing extended it.
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
