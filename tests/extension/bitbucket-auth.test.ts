import { describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';

vi.mock('vscode', () => ({
  EventEmitter: class {
    public listeners: ((e: unknown) => void)[] = [];
    public event = (listener: (e: unknown) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    public fire(e: unknown) { this.listeners.forEach((l) => l(e)); }
    public dispose() {}
  },
}));

const { BitbucketAuthProvider, BITBUCKET_TOKEN_SCOPES } =
  await import('../../src/extension/services/forge/bitbucket/bitbucket-auth');

const SCOPES = [...BITBUCKET_TOKEN_SCOPES];

class MemorySecrets {
  private readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async store(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

const credentials = { email: 'tuyen@example.com', token: 'ATATT-secret-token' };

function build(overrides: Partial<{ prompt: unknown; verify: unknown }> = {}) {
  const secrets = new MemorySecrets();
  const prompt = overrides.prompt ?? vi.fn().mockResolvedValue(credentials);
  const verify = overrides.verify ?? vi.fn().mockResolvedValue('Tuyen Nguyen');
  const provider = new BitbucketAuthProvider({ secrets, prompt, verify } as never);
  return { provider, secrets, prompt, verify };
}

describe('BitbucketAuthProvider', () => {
  it('has no session before sign-in', async () => {
    const { provider } = build();
    expect(await provider.getSessions()).toEqual([]);
  });

  it('prompts, verifies, and stores on createSession', async () => {
    const { provider, prompt, verify } = build();
    const session = await provider.createSession(SCOPES);
    expect(prompt).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(credentials);
    expect(session.account).toEqual({ id: credentials.email, label: 'Tuyen Nguyen' });
    expect(session.scopes).toEqual(SCOPES);
  });

  // Ledger item: two overlapping sign-in round-trips. Two panels (the graph
  // webview and the review webview) can each drive `vscode.authentication`
  // into calling createSession() when neither has a session yet — without
  // coalescing, that opens the two-input-box prompt twice and spends two
  // /user verification requests for what is really one sign-in.
  it('coalesces two concurrent createSession calls into a single prompt-and-verify round trip', async () => {
    let resolvePrompt!: (value: typeof credentials) => void;
    const prompt = vi.fn().mockReturnValue(new Promise((resolve) => { resolvePrompt = resolve; }));
    const verify = vi.fn().mockResolvedValue('Tuyen Nguyen');
    const { provider } = build({ prompt, verify });

    const first = provider.createSession(SCOPES);
    const second = provider.createSession(SCOPES);

    resolvePrompt(credentials);
    const [firstSession, secondSession] = await Promise.all([first, second]);

    expect(prompt).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(firstSession).toEqual(secondSession);
  });

  // Once a sign-in settles (success or cancellation), the next call must
  // start a fresh round trip rather than staying joined to the finished one.
  it('starts a new round trip after the previous createSession call has settled', async () => {
    const prompt = vi.fn().mockResolvedValue(credentials);
    const verify = vi.fn().mockResolvedValue('Tuyen Nguyen');
    const { provider } = build({ prompt, verify });

    await provider.createSession(SCOPES);
    await provider.createSession(SCOPES);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  // A mistyped or under-scoped token must fail where it was typed.
  it('stores nothing when verification fails', async () => {
    const { provider, secrets } = build({ verify: vi.fn().mockRejectedValue(new Error('401')) });
    await expect(provider.createSession(SCOPES)).rejects.toThrow('401');
    expect(await provider.getSessions()).toEqual([]);
    expect(await secrets.get('forge:bitbucket-cloud:token')).toBeUndefined();
  });

  // createSession must resolve to a session or reject — there is no third
  // option in the vscode.AuthenticationProvider interface it implements.
  it('rejects rather than resolving to nothing when the user cancels', async () => {
    const { provider, secrets } = build({ prompt: vi.fn().mockResolvedValue(undefined) });
    await expect(provider.createSession(SCOPES)).rejects.toThrow(/cancel/i);
    expect(await secrets.get('forge:bitbucket-cloud:token')).toBeUndefined();
  });

  // Ledger item: the corrupt-stored-secret test. `load()`'s catch treats a
  // secret that fails JSON.parse as signed out rather than throwing — the
  // fail-safe path itself is judged correct as-is (closed won't-fix
  // separately), but nothing previously exercised it.
  it('treats an unparseable stored secret as signed out rather than throwing', async () => {
    const secrets = new MemorySecrets();
    await secrets.store('forge:bitbucket-cloud:token', 'not-json{{{');
    const provider = new BitbucketAuthProvider({
      secrets, prompt: vi.fn(), verify: vi.fn(),
    } as never);

    await expect(provider.getSessions()).resolves.toEqual([]);
    await expect(provider.getCredentials()).resolves.toBeUndefined();
  });

  // A stored value that parses as JSON but is missing the fields a
  // credential needs (a truncated write, a shape from an older version)
  // must be treated the same way — signed out, not a thrown error.
  it('treats a stored secret missing required fields as signed out', async () => {
    const secrets = new MemorySecrets();
    await secrets.store('forge:bitbucket-cloud:token', JSON.stringify({ email: 'tuyen@example.com' }));
    const provider = new BitbucketAuthProvider({
      secrets, prompt: vi.fn(), verify: vi.fn(),
    } as never);

    await expect(provider.getSessions()).resolves.toEqual([]);
  });

  it('reuses the stored credential on later calls', async () => {
    const { provider, prompt } = build();
    await provider.createSession(SCOPES);
    const again = await provider.getSessions();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(again).toHaveLength(1);
    expect(again[0].account.label).toBe('Tuyen Nguyen');
  });

  // getSessions must genuinely filter by the requested scopes rather than
  // handing back the stored session regardless.
  describe('getSessions scope filtering', () => {
    it('returns the session when the requested scopes are granted', async () => {
      const { provider } = build();
      await provider.createSession(SCOPES);
      expect(await provider.getSessions(SCOPES)).toHaveLength(1);
      expect(await provider.getSessions(['read:user:bitbucket'])).toHaveLength(1);
    });

    it('returns no session when a requested scope was never granted', async () => {
      const { provider } = build();
      await provider.createSession(SCOPES);
      expect(await provider.getSessions(['admin:never-granted'])).toEqual([]);
    });

    it('returns the session when no scopes are requested', async () => {
      const { provider } = build();
      await provider.createSession(SCOPES);
      expect(await provider.getSessions()).toHaveLength(1);
      expect(await provider.getSessions(undefined)).toHaveLength(1);
    });
  });

  // Stable across reloads: removeSession(sessionId) must be able to match
  // the id a fresh provider instance (a window reload) derives from the same
  // stored credential.
  it('derives a session id that is stable across a reload of the same credential', async () => {
    const secrets = new MemorySecrets();
    const prompt = vi.fn().mockResolvedValue(credentials);
    const verify = vi.fn().mockResolvedValue('Tuyen Nguyen');

    const first = new BitbucketAuthProvider({ secrets, prompt, verify } as never);
    const created = await first.createSession(SCOPES);

    const second = new BitbucketAuthProvider({ secrets, prompt, verify } as never);
    const [reloaded] = await second.getSessions();

    expect(reloaded.id).toBe(created.id);
  });

  describe('removeSession', () => {
    it('clears the credential and fires added/removed/changed', async () => {
      const { provider } = build();
      const created = await provider.createSession(SCOPES);
      const fired: unknown[] = [];
      provider.onDidChangeSessions((e: unknown) => fired.push(e));

      await provider.removeSession(created.id);

      expect(await provider.getSessions()).toEqual([]);
      expect(fired).toEqual([{ added: [], removed: [created], changed: [] }]);
    });

    it('is a no-op for an id that does not match the stored credential', async () => {
      const { provider } = build();
      await provider.createSession(SCOPES);
      const fired: unknown[] = [];
      provider.onDidChangeSessions((e: unknown) => fired.push(e));

      await provider.removeSession('not-the-real-session-id');

      expect(await provider.getSessions()).toHaveLength(1);
      expect(fired).toHaveLength(0);
    });
  });

  it('createSession fires an added/removed/changed event, not a bare void', async () => {
    const { provider } = build();
    const fired: unknown[] = [];
    provider.onDidChangeSessions((e: unknown) => fired.push(e));

    const session = await provider.createSession(SCOPES);

    expect(fired).toEqual([{ added: [session], removed: [], changed: [] }]);
  });

  it('names every required scope', () => {
    expect(SCOPES).toEqual([
      'read:user:bitbucket',
      'read:repository:bitbucket',
      'read:pullrequest:bitbucket',
      'write:pullrequest:bitbucket',
    ]);
  });

  // Global constraint: no token value is ever written to a log.
  it('never writes the token to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const { provider } = build({ verify: vi.fn().mockRejectedValue(new Error('401 Unauthorized')) });
    await provider.createSession(SCOPES).catch(() => {});
    const written = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join('\n');
    expect(written).not.toContain(credentials.token);
    spies.forEach((spy) => spy.mockRestore());
  });

  // The credential never leaves the extension host: accessToken carries the
  // API token (the AuthenticationSession shape requires it), but the id and
  // account must not carry it too, and it never reaches JSON built from
  // either of those.
  it('keeps the token out of the session id and account', async () => {
    const { provider } = build();
    const session = await provider.createSession(SCOPES);
    expect(session.accessToken).toBe(credentials.token);
    expect(session.id).not.toContain(credentials.token);
    expect(JSON.stringify(session.account)).not.toContain(credentials.token);
  });
});

describe('forge contributions', () => {
  const contributes = pkg.contributes as unknown as Record<string, never>;

  it('declares the bitbucket authentication provider', () => {
    const auth = contributes.authentication as unknown as { id: string; label: string }[];
    expect(auth).toContainEqual({ id: 'bitbucket-cloud', label: 'Bitbucket' });
  });

  it('defaults the forge remote to origin', () => {
    const props = (contributes.configuration as unknown as { properties: Record<string, { default: string }> }).properties;
    expect(props['gitGraphPro.forge.remote'].default).toBe('origin');
  });

  it('registers sign-in and sign-out commands', () => {
    const ids = (contributes.commands as unknown as { command: string }[]).map((c) => c.command);
    expect(ids).toContain('gitGraphPro.forge.signIn');
    expect(ids).toContain('gitGraphPro.forge.signOut');
  });

  // Ledger item: manifest-label drift. gitGraphPro.forge.signIn/signOut
  // dispatch to whichever provider the active repository resolves to
  // (Bitbucket or GitHub, see forge-method-handler.ts) — the command
  // palette titles must not name one host, or they read as wrong the
  // moment a GitHub repository is the active one.
  it('keeps the sign-in/sign-out command titles provider-neutral', () => {
    const commands = contributes.commands as unknown as { command: string; title: string }[];
    const forgeCommands = commands.filter((c) => c.command.startsWith('gitGraphPro.forge.sign'));
    expect(forgeCommands).toHaveLength(2);
    for (const { title } of forgeCommands) {
      expect(title).not.toMatch(/bitbucket|github/i);
    }
  });
});
