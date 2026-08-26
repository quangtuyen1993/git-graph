import { describe, expect, it, vi } from 'vitest';
import { BitbucketApi, MAX_CONCURRENT_REQUESTS } from '../../src/extension/services/forge/bitbucket/bitbucket-api';
import { ForgeError } from '../../src/extension/services/forge/forge.types';

const credentials = { email: 'tuyen@example.com', token: 'ATATT-secret-token' };

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function build(fetchImpl: typeof fetch, sleep = vi.fn().mockResolvedValue(undefined)) {
  const api = new BitbucketApi({ getCredentials: async () => credentials, fetchImpl, sleep });
  return { api, sleep };
}

describe('BitbucketApi', () => {
  it('sends HTTP Basic with the email and token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await api.getJson('/user');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.bitbucket.org/2.0/user');
    expect((init.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`);
  });

  it('throws a signed-out ForgeError when there is no credential', async () => {
    const fetchImpl = vi.fn();
    const api = new BitbucketApi({ getCredentials: async () => undefined, fetchImpl: fetchImpl as never });
    await expect(api.getJson('/user')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('translates a non-2xx body into ForgeError with the host message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Repository not found' } }, { status: 404 }));
    const { api } = build(fetchImpl as never);

    await expect(api.getJson('/repositories/acme/nope')).rejects.toMatchObject({
      name: 'ForgeError', status: 404, hostMessage: 'Repository not found',
    });
  });

  it('carries Retry-After on a 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '37' } }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/user')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 37 });
  });

  it('pauses the queue for Retry-After before the next request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '5' } }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    const { api, sleep } = build(fetchImpl as never);

    await api.getJson('/a').catch(() => {});
    await api.getJson('/b');
    expect(sleep).toHaveBeenCalledWith(5000);
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

    await Promise.all(Array.from({ length: 12 }, (_, i) => api.getJson(`/p/${i}`)));
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });

  it('follows Bitbucket pagination until there is no next link', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: 1 }], next: 'https://api.bitbucket.org/2.0/x?page=2' }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: 2 }] }));
    const { api } = build(fetchImpl as never);

    expect(await api.getPaged<{ id: number }>('/x')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns a diff as text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('diff --git a/a b/a\n', { status: 200 }));
    const { api } = build(fetchImpl as never);
    expect(await api.getText('/pullrequests/1/diff')).toBe('diff --git a/a b/a\n');
  });

  // Extra requirement: the brief's tests never assert `kind`, but everything
  // above the provider switches on `kind` and never on the raw HTTP status —
  // the same status means different things on different hosts (see
  // ForgeErrorKind in forge.types.ts). classify() is the hinge the whole
  // error design hangs on, so every branch gets a direct assertion here.
  it('classifies the not-signed-in error as unauthorized', async () => {
    const fetchImpl = vi.fn();
    const api = new BitbucketApi({ getCredentials: async () => undefined, fetchImpl: fetchImpl as never });
    await expect(api.getJson('/user')).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [429, 'rate-limited'],
    [400, 'duplicate'],
    [500, 'other'],
  ] as const)('classifies HTTP %i as %s', async (status, kind) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { message: 'host message' } },
        { status, headers: status === 429 ? { 'retry-after': '1' } : {} },
      ));
    const { api } = build(fetchImpl as never);

    await expect(api.getJson('/x')).rejects.toMatchObject({ kind, status });
  });
});
