import { describe, expect, it, vi } from 'vitest';
import { BitbucketApi, MAX_CONCURRENT_REQUESTS } from '../../src/extension/services/forge/bitbucket/bitbucket-api';
import { ForgeError } from '../../src/extension/services/forge/forge.types';

const credentials = { token: 'ATATT-secret-token' };

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
  // Bearer, unconditionally — see the comment in bitbucket-api.ts's request()
  // for why: it is the one scheme Atlassian's docs confirm both Bitbucket
  // token families (Atlassian-account API tokens and repository/project/
  // workspace access tokens) accept, so this client never has to know, ask,
  // or probe which kind a stored credential is. `BitbucketCredentials`
  // carries nothing but the token, so there is nothing else this header
  // could be built from.
  it('sends HTTP Bearer with the token, never Basic', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await api.getJson('/user');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.bitbucket.org/2.0/user');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${credentials.token}`);
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

  // Review finding: `pausedUntil` must extend monotonically, not be
  // overwritten by whichever concurrent 429 finishes classifying last. Two
  // requests are in flight together (within the concurrency cap); the one
  // carrying the *longer* Retry-After is processed first, then the one with
  // the *shorter* Retry-After is processed second. The bug (plain overwrite)
  // would let the shorter deadline win; the fix (extend via Math.max) must
  // keep the longer one, so a request made afterwards still waits close to it.
  it('keeps the longer Retry-After deadline when a later concurrent 429 carries a shorter one', async () => {
    let resolveLonger!: (response: Response) => void;
    let resolveShorter!: (response: Response) => void;
    const longerResponse = new Promise<Response>((resolve) => { resolveLonger = resolve; });
    const shorterResponse = new Promise<Response>((resolve) => { resolveShorter = resolve; });

    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => longerResponse)
      .mockImplementationOnce(() => shorterResponse)
      .mockResolvedValue(jsonResponse({ ok: true }));
    const { api, sleep } = build(fetchImpl as never);

    // Both start together, within the concurrency cap of 4.
    const longerCall = api.getJson('/a').catch(() => {});
    const shorterCall = api.getJson('/b').catch(() => {});

    // The longer-Retry-After response is classified first...
    resolveLonger(jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '10' } }));
    await longerCall;

    // ...then the shorter-Retry-After response is classified second.
    resolveShorter(jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '3' } }));
    await shorterCall;

    await api.getJson('/c');
    const lastWaitMs = sleep.mock.calls[sleep.mock.calls.length - 1][0] as number;
    // ~10s remains (minus test execution jitter); a shortened-to-3s deadline
    // would fail this by a wide margin.
    expect(lastWaitMs).toBeGreaterThan(5000);
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

  // Ledger item: the untested page cap. A malformed or self-referential
  // `next` link must not spin getPaged forever burning the request budget —
  // MAX_PAGINATION_PAGES is the ceiling, but nothing previously drove it.
  it('stops pagination once MAX_PAGINATION_PAGES is reached and reports why', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResponse({ values: [{ id: 1 }], next: 'https://api.bitbucket.org/2.0/x?page=next' }));
    const { api } = build(fetchImpl as never);

    await expect(api.getPaged('/x')).rejects.toMatchObject({
      hostMessage: expect.stringContaining('did not finish within'),
    });
    // 200 pages fetched, then it gives up rather than continuing forever.
    expect(fetchImpl).toHaveBeenCalledTimes(200);
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
    [400, 'other'],
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

  // Finding 9: every Bitbucket 400 is not a duplicate — a malformed body, an
  // unknown merge strategy or an invalid reviewer id all come back as 400
  // too, and Phase 5's "a duplicate attempt reports the existing pull
  // request" acceptance criterion will branch on `kind`.
  it('never classifies a 400 as duplicate', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Invalid reviewer' } }, { status: 400 }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/x')).rejects.toMatchObject({ kind: 'other', status: 400 });
  });

  // Phase 5, task 1, requirement 4: classify() was status-only, so nothing in
  // the codebase could ever produce ForgeErrorKind 'duplicate' even though a
  // comment here promised the create path would branch on it. Duplicate
  // detection must be body-aware, and scoped to callers that opt in
  // (`detectDuplicate`) — a plain GET (the test above) must never turn a 400
  // into 'duplicate' just because its message happens to mention one.
  it("classifies a 400 whose body names an existing pull request as 'duplicate' when the caller opts in", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { error: { message: 'There is already an open pull request from feature/x to develop.' } },
      { status: 400 },
    ));
    const { api } = build(fetchImpl as never);
    await expect(api.post('/repositories/acme/mpos/pullrequests', {}, { detectDuplicate: true }))
      .rejects.toMatchObject({ kind: 'duplicate', status: 400 });
  });

  // The opt-in must still require the body to actually say so — a 400 for
  // some other reason (a malformed field, say) on the very same endpoint
  // must not be misreported as a duplicate just because detectDuplicate was
  // passed.
  it('does not classify an unrelated 400 as duplicate even with detectDuplicate set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Invalid reviewer account id' } }, { status: 400 }));
    const { api } = build(fetchImpl as never);
    await expect(api.post('/repositories/acme/mpos/pullrequests', {}, { detectDuplicate: true }))
      .rejects.toMatchObject({ kind: 'other', status: 400 });
  });

  // Without the opt-in, even a body that reads like a duplicate must not
  // become 'duplicate' — detectDuplicate is what scopes this to the create
  // path, not the message content alone.
  it('does not classify a duplicate-looking 400 without the caller opting in', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { error: { message: 'There is already an open pull request from feature/x to develop.' } },
      { status: 400 },
    ));
    const { api } = build(fetchImpl as never);
    await expect(api.post('/repositories/acme/mpos/pullrequests', {})).rejects.toMatchObject({ kind: 'other' });
  });

  // Finding 2: a server-supplied absolute link (getPaged's `next`, or any
  // caller passing a full URL) must resolve back to the API's own origin —
  // otherwise it would carry the Bearer auth header to an arbitrary host.
  it('follows an absolute link on the API origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await api.getJson('https://api.bitbucket.org/2.0/repositories/acme/mpos/pullrequests?page=2');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses an absolute link on a different origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('https://evil.example/steal')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses getPaged following a next link to a different origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ values: [{ id: 1 }], next: 'https://evil.example/2.0/x?page=2' }));
    const { api } = build(fetchImpl as never);
    await expect(api.getPaged('/x')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a plaintext http:// link even to the right host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('http://api.bitbucket.org/2.0/user')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Finding 12: a Retry-After of a day must not wedge every queued request
  // for that long.
  it('clamps an excessive Retry-After to a ceiling', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '86400' } }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    const { api, sleep } = build(fetchImpl as never);

    await api.getJson('/a').catch(() => {});
    await api.getJson('/b');
    const waitedMs = sleep.mock.calls[0][0] as number;
    expect(waitedMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  // A3: the ForgeError must report the clamped wait, not the raw header —
  // a Retry-After: 86400 must not produce "Retrying in 86400s" when the
  // actual pause is capped to five minutes.
  it('reports the clamped retry delay on the error, not the raw header value', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '86400' } }));
    const { api } = build(fetchImpl as never);

    await expect(api.getJson('/a')).rejects.toMatchObject({ retryAfterSeconds: 5 * 60 });
  });

  // Ledger item: the untested HTTP-date branch of parseRetryAfter. RFC 9110
  // §10.2.3 allows Retry-After to be an HTTP-date instead of delta-seconds,
  // and Bitbucket has been seen to send either — only the delta-seconds form
  // was previously exercised.
  it('parses an HTTP-date Retry-After into a delta from now', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const future = new Date(now + 12_000).toUTCString();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': future } }));
    const { api } = build(fetchImpl as never);

    await expect(api.getJson('/a')).rejects.toMatchObject({ retryAfterSeconds: 12 });
    vi.restoreAllMocks();
  });

  // A Retry-After that is neither a positive delta nor a parseable,
  // still-future date (garbage, or a date already in the past) falls back to
  // 60s rather than firing again immediately.
  it('falls back to 60s when Retry-After is neither a valid delta nor a future date', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': 'not-a-real-value' } }));
    const { api } = build(fetchImpl as never);

    await expect(api.getJson('/a')).rejects.toMatchObject({ retryAfterSeconds: 60 });
  });

  // Ledger item: the deadline extended mid-sleep. waitForPause loops only
  // while `pausedUntil` has itself moved further out *since the last sleep
  // call started* — not against the raw clock — so a concurrent request that
  // extends the pause while this call is already asleep must make it sleep
  // again for the remainder, rather than firing the moment its original,
  // now-stale wait elapses.
  it('sleeps again when the pause deadline is extended while a request is already asleep', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '5' } }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    const sleep = vi.fn();
    const { api } = build(fetchImpl as never, sleep as never);

    // First call lands the 429 and sets pausedUntil ~5s out.
    await api.getJson('/a').catch(() => {});
    expect(sleep).not.toHaveBeenCalled();

    // The second call starts waiting out that 5s pause. Its first `sleep`
    // call simulates a third, concurrent request extending the deadline
    // further while this one is asleep, by resolving to nothing but leaving
    // pausedUntil further out than it was when this wait began.
    let sleepCallCount = 0;
    sleep.mockImplementation(async () => {
      sleepCallCount += 1;
      if (sleepCallCount === 1) {
        // Simulate a concurrent 429 landing mid-sleep and extending the
        // shared deadline well past what this call started waiting for.
        (api as unknown as { queue: { pausedUntil: number } }).queue.pausedUntil = Date.now() + 60_000;
      }
    });

    await api.getJson('/b');
    // Woke from the first sleep, re-checked, found the deadline had moved
    // further out, and had to sleep a second time for the remainder.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
