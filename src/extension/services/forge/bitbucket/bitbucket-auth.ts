import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { ForgeError } from '../forge.types';
import { BITBUCKET_AUTH_ID, BITBUCKET_AUTH_LABEL, BITBUCKET_TOKEN_SCOPES } from './bitbucket-constants';
import { describeBitbucketError } from './bitbucket-error-messages';

// Re-exported so existing importers of this module keep working; the values
// themselves live in bitbucket-constants.ts, which does not import 'vscode'.
export { BITBUCKET_AUTH_ID, BITBUCKET_AUTH_LABEL, BITBUCKET_TOKEN_SCOPES };

const SECRET_KEY = `forge:${BITBUCKET_AUTH_ID}:token`;

/**
 * `.name` a cancelled sign-in is tagged with — see `BitbucketSignInCancelledError`
 * below for why this, and not `instanceof`, is what a caller must check.
 */
const SIGN_IN_CANCELLED_NAME = 'BitbucketSignInCancelledError';

/**
 * Thrown by `createSession` when the credential prompt is dismissed.
 * `vscode.AuthenticationProvider.createSession` has no "cancelled" outcome
 * besides throwing (see the comment on that throw below), so this is how a
 * cancelled sign-in is expressed — but it must still be distinguishable from
 * a real failure by whoever calls `vscode.authentication.getSession({
 * createIfNone: true })`, which is what actually invokes `createSession`.
 *
 * That call is not a same-process function call: VS Code's authentication
 * broker lives outside the extension host, so a rejection from this
 * provider's `createSession` round-trips through it before reaching the
 * caller. That round trip reconstructs a plain `Error`, copying `name`,
 * `message` and `stack` but dropping the subclass — an `instanceof` check
 * against this class at the call site would silently never match. `.name`
 * survives the round trip (it is copied, not derived from the prototype),
 * so `isSignInCancelled` below checks that instead of `instanceof`, and
 * every caller of this sign-in path must use it rather than matching on
 * `.message`, which is user-facing prose, not a stable identifier.
 */
export class BitbucketSignInCancelledError extends Error {
  constructor() {
    super('Sign-in to Bitbucket was cancelled.');
    this.name = SIGN_IN_CANCELLED_NAME;
  }
}

/**
 * True for a cancelled sign-in, including the plain `Error` a cancelled
 * `createSession()` call is reconstructed as once it has crossed
 * `vscode.authentication`'s provider boundary (see `BitbucketSignInCancelledError`
 * above). Callers on that path — the `gitGraphPro.forge.signIn` command — must
 * use this rather than `instanceof BitbucketSignInCancelledError`, which only
 * holds before the round trip.
 */
export function isSignInCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === SIGN_IN_CANCELLED_NAME;
}

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
    // See BitbucketSignInCancelledError for why callers must check
    // isSignInCancelled(error) rather than instanceof or .message.
    if (!entered) throw new BitbucketSignInCancelledError();

    // Verify before storing: a token that is mistyped or missing a scope must
    // fail at the moment it is entered, not on the first pull request request.
    //
    // Translated to its final message right here, not left as a ForgeError
    // for forge-method-handler's catch to translate: that catch only ever
    // sees this rejection after it has round-tripped through
    // vscode.authentication's provider boundary (the same one
    // BitbucketSignInCancelledError's doc comment describes), which
    // reconstructs a plain Error and drops `kind`/`hostMessage` along with
    // the subclass — `describeError` can no longer be called meaningfully by
    // then. This is the only point in the call chain where the ForgeError is
    // still intact, so it is translated here, reusing the exact wording
    // `BitbucketCloudProvider.describeError` uses (via `describeBitbucketError`)
    // rather than composing new text — both call the same function so there is
    // one place, not two, that knows what a Bitbucket 'forbidden' means.
    let accountLabel: string;
    try {
      accountLabel = await this.deps.verify(entered);
    } catch (error) {
      if (error instanceof ForgeError) throw new Error(describeBitbucketError(error));
      throw error;
    }

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
