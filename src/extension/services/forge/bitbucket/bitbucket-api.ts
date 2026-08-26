import { ForgeError } from '../forge.types';
import type { ForgeErrorKind } from '../forge.types';
import type { BitbucketCredentials } from './bitbucket-auth';

export const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0';

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

    while (next) {
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
    const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`;

    await this.acquire();
    try {
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) await this.sleep(wait);

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
      const header = Number(response.headers.get('retry-after'));
      retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : 60;
      // Hold every queued request, not just this one: they would all hit the
      // same limit and turn one breach into a wall of identical failures.
      this.pausedUntil = Date.now() + retryAfterSeconds * 1000;
    }

    return new ForgeError(this.classify(response.status), response.status, hostMessage, retryAfterSeconds);
  }

  /**
   * Bitbucket's status codes mapped to the shared vocabulary. This mapping is
   * the one thing only a provider can do: another host signals rate limiting
   * with a status this one uses for permission failures, and reports a
   * duplicate with a different code again. Everything above the provider
   * switches on the resulting kind and never on the number.
   */
  private classify(status: number): ForgeErrorKind {
    switch (status) {
      case 401: return 'unauthorized';
      case 403: return 'forbidden';
      case 404: return 'not-found';
      case 429: return 'rate-limited';
      case 400: return 'duplicate';
      default:  return 'other';
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
