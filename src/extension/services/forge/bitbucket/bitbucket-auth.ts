import * as vscode from 'vscode';
import { createHash } from 'crypto';
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

/**
 * A stable, non-reversible id for a stored credential. Session ids can end
 * up in VS Code's own state (the Accounts menu, session-preference storage),
 * so the token itself must never appear in one — a one-way hash keeps the id
 * deterministic for the same credential (so `removeSession` and a window
 * reload agree on it) without making it reversible to the token.
 */
function sessionId(credentials: BitbucketCredentials): string {
  return createHash('sha256').update(`${credentials.email}:${credentials.token}`).digest('hex');
}

/**
 * A real vscode.AuthenticationProvider over SecretStorage, registered via
 * vscode.authentication.registerAuthenticationProvider so the manifest's
 * `contributes.authentication` entry is backed by something — an Accounts
 * menu entry, a sign-out affordance there, and session-change plumbing other
 * extensions could in principle observe.
 *
 * The email/token pair Bitbucket's Basic auth needs cannot be expressed as a
 * single AuthenticationSession.accessToken alone, so `getCredentials()`
 * (below, not part of the interface) stays the path BitbucketApi uses — it
 * never goes through vscode.authentication.getSession, and the credential it
 * returns never leaves this extension host.
 */
export class BitbucketAuthProvider implements vscode.AuthenticationProvider {
  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  public readonly onDidChangeSessions = this.changeEmitter.event;

  private cached: StoredCredentials | undefined;

  /**
   * In-flight createSession() call, so two overlapping sign-in round-trips
   * (the graph panel and the review panel both call vscode.authentication's
   * getSession({ createIfNone: true }) when neither has a session yet, or a
   * user double-clicks "Sign in") collapse into one prompt-and-verify
   * sequence instead of opening the credential input boxes twice and
   * spending two /user probe requests. Cleared once the call settles either
   * way, so a later, genuinely separate sign-in still prompts again.
   */
  private inFlightCreateSession: Promise<vscode.AuthenticationSession> | undefined;

  constructor(private readonly deps: BitbucketAuthDeps) {}

  /**
   * Filters by the requested scopes rather than returning the stored session
   * regardless: a stored credential is always granted the full
   * BITBUCKET_TOKEN_SCOPES set (see verifyBitbucketCredentials), so a caller
   * asking for a scope outside that set must get no session, not this one.
   */
  public async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
    const stored = await this.load();
    if (!stored) return [];
    const session = this.toSession(stored);
    if (scopes && !scopes.every((scope) => session.scopes.includes(scope))) return [];
    return [session];
  }

  public async createSession(_scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    // Join an already-running sign-in rather than starting a second prompt
    // beside it — see the field comment on inFlightCreateSession.
    if (this.inFlightCreateSession) return this.inFlightCreateSession;

    const run = this.doCreateSession();
    this.inFlightCreateSession = run;
    try {
      return await run;
    } finally {
      this.inFlightCreateSession = undefined;
    }
  }

  private async doCreateSession(): Promise<vscode.AuthenticationSession> {
    const entered = await this.deps.prompt();
    // createSession must resolve to a session or reject — there is no third
    // option in the interface it implements — so a cancelled prompt becomes
    // a rejection rather than the `undefined` this returned before adoption.
    if (!entered) throw new Error('Sign-in to Bitbucket was cancelled.');

    // Verify before storing: a token that is mistyped or missing a scope must
    // fail at the moment it is entered, not on the first pull request request.
    const accountLabel = await this.deps.verify(entered);

    const stored: StoredCredentials = { ...entered, accountLabel };
    await this.deps.secrets.store(SECRET_KEY, JSON.stringify(stored));
    this.cached = stored;
    const session = this.toSession(stored);
    this.changeEmitter.fire({ added: [session], removed: [], changed: [] });
    return session;
  }

  public async removeSession(id: string): Promise<void> {
    const stored = await this.load();
    if (!stored || sessionId(stored) !== id) return;
    const session = this.toSession(stored);
    this.cached = undefined;
    await this.deps.secrets.delete(SECRET_KEY);
    this.changeEmitter.fire({ added: [], removed: [session], changed: [] });
  }

  /**
   * The email/token pair BitbucketApi needs for HTTP Basic auth. Deliberately
   * not part of vscode.AuthenticationProvider: an AuthenticationSession's
   * accessToken is a single opaque string, but Bitbucket's API needs the
   * email alongside the token. Used only by this extension's own BitbucketApi
   * wiring — the credential it returns never crosses to the webview.
   */
  public async getCredentials(): Promise<BitbucketCredentials | undefined> {
    const stored = await this.load();
    return stored ? { email: stored.email, token: stored.token } : undefined;
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private toSession(stored: StoredCredentials): vscode.AuthenticationSession {
    return {
      id: sessionId(stored),
      accessToken: stored.token,
      account: { id: stored.email, label: stored.accountLabel },
      scopes: [...BITBUCKET_TOKEN_SCOPES],
    };
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
