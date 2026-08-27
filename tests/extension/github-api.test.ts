import { describe, expect, it, vi } from 'vitest';
import { GitHubApi, MAX_CONCURRENT_REQUESTS } from '../../src/extension/services/forge/github/github-api';
import { ForgeError } from '../../src/extension/services/forge/forge.types';

const token = 'gho_secret-token';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function build(fetchImpl: typeof fetch, sleep = vi.fn().mockResolvedValue(undefined)) {
  const api = new GitHubApi({ getToken: async () => token, fetchImpl, sleep });
  return { api, sleep };
}

describe('GitHubApi', () => {
  it('sends a Bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await api.getJson('/user');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/user');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect((init.headers as Record<string, string>).Accept).toBe('application/vnd.github+json');
  });

  it('throws a signed-out ForgeError when there is no token', async () => {
    const fetchImpl = vi.fn();
    const api = new GitHubApi({ getToken: async () => undefined, fetchImpl: fetchImpl as never });
    await expect(api.getJson('/user')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('translates a non-2xx body into ForgeError with the host message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/repos/acme/nope')).rejects.toMatchObject({
      name: 'ForgeError', status: 404, hostMessage: 'Not Found', kind: 'not-found',
    });
  });

  it('prefers the validation errors array over the generic message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { message: 'Validation Failed', errors: [{ message: 'Invalid reviewer login' }] },
      { status: 422 },
    ));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/x')).rejects.toMatchObject({ hostMessage: 'Invalid reviewer login', kind: 'other' });
  });

  it('sends PUT with a JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ merged: true }));
    const { api } = build(fetchImpl as never);
    await api.put('/repos/acme/mpos/pulls/1/merge', { merge_method: 'squash' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/mpos/pulls/1/merge');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ merge_method: 'squash' }));
  });

  it('sends DELETE with no body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const { api } = build(fetchImpl as never);
    await api.del('/repos/acme/mpos/git/refs/heads/feature-x');
    expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE');
  });

  it('never runs more than the concurrency cap at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse({ ok: true });
    });
    const { api } = build(fetchImpl as never);

    await Promise.all(Array.from({ length: 8 }, (_, i) => api.getJson(`/p/${i}`)));
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it('follows the Link header until there is no rel="next"', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }], {
        headers: { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=3>; rel="last"' },
      }))
      .mockResolvedValueOnce(jsonResponse([{ id: 2 }]));
    const { api } = build(fetchImpl as never);

    expect(await api.getPaged<{ id: number }>('/x')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.github.com/x?page=2');
  });

  it('returns a diff as text with the diff media type header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('diff --git a/a b/a\n', { status: 200 }));
    const { api } = build(fetchImpl as never);
    const diff = await api.getText('/repos/acme/mpos/pulls/1', { Accept: 'application/vnd.github.v3.diff' });
    expect(diff).toBe('diff --git a/a b/a\n');
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>).Accept).toBe('application/vnd.github.v3.diff');
  });

  it.each([
    [401, 'unauthorized'],
    [404, 'not-found'],
    [422, 'other'],
    [500, 'other'],
  ] as const)('classifies HTTP %i as %s', async (status, kind) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'host message' }, { status }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/x')).rejects.toMatchObject({ kind, status });
  });

  // GitHub reports its primary rate limit as 403 with a zero remaining count
  // and a reset epoch — never 429, which is what Bitbucket uses instead.
  it("classifies a 403 with x-ratelimit-remaining: 0 as rate-limited (primary)", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 42;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { message: 'API rate limit exceeded' },
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) } },
    ));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/x')).rejects.toMatchObject({ kind: 'rate-limited', status: 403 });
  });

  // The secondary limit is a 403 carrying Retry-After instead — distinct
  // from the primary limit's remaining-count signal.
  it('classifies a 403 with Retry-After as rate-limited (secondary)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { message: 'You have exceeded a secondary rate limit' },
      { status: 403, headers: { 'retry-after': '30' } },
    ));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/x')).rejects.toMatchObject({ kind: 'rate-limited', status: 403, retryAfterSeconds: 30 });
  });

  // A 403 with neither signal is a real permission failure, not a rate limit.
  it('classifies a bare 403 as forbidden', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'Resource not accessible' }, { status: 403 }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/x')).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });

  it('pauses the queue on a secondary rate limit before the next request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'secondary limit' }, { status: 403, headers: { 'retry-after': '5' } }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    const { api, sleep } = build(fetchImpl as never);

    await api.getJson('/a').catch(() => {});
    await api.getJson('/b');
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  // Duplicate detection is body-aware and opt-in, mirroring Bitbucket's
  // 400 handling — GitHub reports it as 422, its generic validation-failure
  // status, which also fires for unrelated reasons (an invalid branch name,
  // no commits between branches). A plain GET must never turn a 422 into
  // 'duplicate' just because the message happens to say so, and even the
  // create path's own 422 must actually mention a duplicate to qualify.
  it("classifies a 422 whose body names an existing pull request as 'duplicate' when the caller opts in", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feature-x.' }] },
      { status: 422 },
    ));
    const { api } = build(fetchImpl as never);
    await expect(api.post('/repos/acme/mpos/pulls', {}, { detectDuplicate: true }))
      .rejects.toMatchObject({ kind: 'duplicate', status: 422 });
  });

  it('does not classify an unrelated 422 as duplicate even with detectDuplicate set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { message: 'Validation Failed', errors: [{ message: 'Invalid value for head' }] },
      { status: 422 },
    ));
    const { api } = build(fetchImpl as never);
    await expect(api.post('/repos/acme/mpos/pulls', {}, { detectDuplicate: true }))
      .rejects.toMatchObject({ kind: 'other', status: 422 });
  });

  it('does not classify a duplicate-looking 422 without the caller opting in', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feature-x.' }] },
      { status: 422 },
    ));
    const { api } = build(fetchImpl as never);
    await expect(api.post('/repos/acme/mpos/pulls', {})).rejects.toMatchObject({ kind: 'other' });
  });

  it('refuses an absolute link on a different origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('https://evil.example/steal')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses getPaged following a next link to a different origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ id: 1 }], {
      headers: { link: '<https://evil.example/x?page=2>; rel="next"' },
    }));
    const { api } = build(fetchImpl as never);
    await expect(api.getPaged('/x')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a plaintext http:// link even to the right host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('http://api.github.com/user')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clamps an excessive rate-limit wait to a ceiling', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'secondary limit' }, { status: 403, headers: { 'retry-after': '86400' } }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    const { api, sleep } = build(fetchImpl as never);

    await api.getJson('/a').catch(() => {});
    await api.getJson('/b');
    const waitedMs = sleep.mock.calls[0][0] as number;
    expect(waitedMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('reports the clamped retry delay on the error, not the raw header value', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ message: 'secondary limit' }, { status: 403, headers: { 'retry-after': '86400' } }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/a')).rejects.toMatchObject({ retryAfterSeconds: 5 * 60 });
  });

  // Extends, never shortens — the same finding as Bitbucket's identical test.
  it('keeps the longer rate-limit deadline when a later concurrent 403 carries a shorter one', async () => {
    let resolveLonger!: (response: Response) => void;
    let resolveShorter!: (response: Response) => void;
    const longerResponse = new Promise<Response>((resolve) => { resolveLonger = resolve; });
    const shorterResponse = new Promise<Response>((resolve) => { resolveShorter = resolve; });

    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => longerResponse)
      .mockImplementationOnce(() => shorterResponse)
      .mockResolvedValue(jsonResponse({ ok: true }));
    const { api, sleep } = build(fetchImpl as never);

    const longerCall = api.getJson('/a').catch(() => {});
    const shorterCall = api.getJson('/b').catch(() => {});

    resolveLonger(jsonResponse({ message: 'limit' }, { status: 403, headers: { 'retry-after': '10' } }));
    await longerCall;
    resolveShorter(jsonResponse({ message: 'limit' }, { status: 403, headers: { 'retry-after': '3' } }));
    await shorterCall;

    await api.getJson('/c');
    const lastWaitMs = sleep.mock.calls[sleep.mock.calls.length - 1][0] as number;
    expect(lastWaitMs).toBeGreaterThan(5000);
  });
});
