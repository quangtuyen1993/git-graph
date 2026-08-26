import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(await provider.getSession()).toBeUndefined();
  });

  it('prompts, verifies, and stores on createIfNone', async () => {
    const { provider, prompt, verify } = build();
    const session = await provider.getSession({ createIfNone: true });
    expect(prompt).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(credentials);
    expect(session).toEqual({ providerId: 'bitbucket-cloud', accountLabel: 'Tuyen Nguyen' });
  });

  // A mistyped or under-scoped token must fail where it was typed.
  it('stores nothing when verification fails', async () => {
    const { provider, secrets } = build({ verify: vi.fn().mockRejectedValue(new Error('401')) });
    await expect(provider.getSession({ createIfNone: true })).rejects.toThrow('401');
    expect(await provider.getCredentials()).toBeUndefined();
    expect(await secrets.get('forge:bitbucket-cloud:token')).toBeUndefined();
  });

  it('returns undefined without prompting when the user cancels', async () => {
    const { provider } = build({ prompt: vi.fn().mockResolvedValue(undefined) });
    expect(await provider.getSession({ createIfNone: true })).toBeUndefined();
  });

  it('reuses the stored credential on later calls', async () => {
    const { provider, prompt } = build();
    await provider.getSession({ createIfNone: true });
    const again = await provider.getSession({ createIfNone: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(again?.accountLabel).toBe('Tuyen Nguyen');
  });

  it('signOut clears the credential and fires the change event', async () => {
    const { provider } = build();
    await provider.getSession({ createIfNone: true });
    const fired: unknown[] = [];
    provider.onDidChangeSessions((e: unknown) => fired.push(e));
    await provider.signOut();
    expect(await provider.getSession()).toBeUndefined();
    expect(fired).toHaveLength(1);
  });

  it('names every required scope', () => {
    expect([...BITBUCKET_TOKEN_SCOPES]).toEqual([
      'read:account',
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
    await provider.getSession({ createIfNone: true }).catch(() => {});
    const written = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join('\n');
    expect(written).not.toContain(credentials.token);
    spies.forEach((spy) => spy.mockRestore());
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
});
