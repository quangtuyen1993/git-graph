import * as vscode from 'vscode';
import type { ForgeSession } from '../forge.types';
import { BITBUCKET_AUTH_ID, BITBUCKET_AUTH_LABEL, BITBUCKET_TOKEN_SCOPES } from './bitbucket-constants';

// Re-exported so existing importers of this module keep working; the values
// themselves live in bitbucket-constants.ts, which does not import 'vscode'.
export { BITBUCKET_AUTH_ID, BITBUCKET_AUTH_LABEL, BITBUCKET_TOKEN_SCOPES };

const SECRET_KEY = `forge:${BITBUCKET_AUTH_ID}:token`;

export interface BitbucketCredentials {
  email: string;
  token: string;
}

/** The slice of vscode.SecretStorage this needs — injectable for tests. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

export type CredentialPrompt = () => Promise<BitbucketCredentials | undefined>;

export interface BitbucketAuthDeps {
  secrets: SecretStorageLike;
  prompt: CredentialPrompt;
  /** Resolves to the account display name, or rejects. Injected so this file never imports the API client. */
  verify: (credentials: BitbucketCredentials) => Promise<string>;
}

interface StoredCredentials extends BitbucketCredentials {
  accountLabel: string;
}

export class BitbucketAuthProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeSessions = this.changeEmitter.event;

  private cached: StoredCredentials | undefined;

  constructor(private readonly deps: BitbucketAuthDeps) {}

  public async getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined> {
    const stored = await this.load();
    if (stored) return { providerId: BITBUCKET_AUTH_ID, accountLabel: stored.accountLabel };
    if (!opts?.createIfNone) return undefined;
    return this.createSession();
  }

  public async createSession(): Promise<ForgeSession | undefined> {
    const entered = await this.deps.prompt();
    if (!entered) return undefined;

    // Verify before storing: a token that is mistyped or missing a scope must
    // fail at the moment it is entered, not on the first pull request request.
    const accountLabel = await this.deps.verify(entered);

    const stored: StoredCredentials = { ...entered, accountLabel };
    await this.deps.secrets.store(SECRET_KEY, JSON.stringify(stored));
    this.cached = stored;
    this.changeEmitter.fire();
    return { providerId: BITBUCKET_AUTH_ID, accountLabel };
  }

  public async getCredentials(): Promise<BitbucketCredentials | undefined> {
    const stored = await this.load();
    return stored ? { email: stored.email, token: stored.token } : undefined;
  }

  public async signOut(): Promise<void> {
    this.cached = undefined;
    await this.deps.secrets.delete(SECRET_KEY);
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private async load(): Promise<StoredCredentials | undefined> {
    if (this.cached) return this.cached;
    const raw = await this.deps.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StoredCredentials;
      if (!parsed?.email || !parsed?.token) return undefined;
      this.cached = parsed;
      return parsed;
    } catch {
      // Corrupt entry: treat as signed out rather than wedging every call.
      return undefined;
    }
  }
}
