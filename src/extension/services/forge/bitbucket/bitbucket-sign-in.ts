import * as vscode from 'vscode';
import { BitbucketApi } from './bitbucket-api';
import type { BitbucketCredentials } from './bitbucket-auth';
import { BITBUCKET_TOKEN_SCOPES } from './bitbucket-constants';

/**
 * Two input boxes rather than a browser flow. Bitbucket Cloud removed app
 * passwords in July 2026 and has no PKCE, so an OAuth consumer would need both
 * a client secret an extension cannot hide and workspace admin rights to
 * create. The scopes are listed verbatim because Bitbucket grants them to the
 * token, not to the request.
 *
 * Lives here, not in extension.ts: the composition root wires providers
 * together, it does not need to know Bitbucket asks for an email and an API
 * token, or which scopes that token needs.
 */
export async function promptForBitbucketCredentials(): Promise<BitbucketCredentials | undefined> {
  const email = await vscode.window.showInputBox({
    title: 'Sign in to Bitbucket (1 of 2)',
    prompt: 'Your Atlassian account email',
    ignoreFocusOut: true,
    validateInput: (value) => (value.includes('@') ? undefined : 'Enter the email address of your Atlassian account'),
  });
  if (!email) return undefined;

  const token = await vscode.window.showInputBox({
    title: 'Sign in to Bitbucket (2 of 2)',
    prompt: `API token with scopes: ${BITBUCKET_TOKEN_SCOPES.join(', ')}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Paste the API token'),
  });
  if (!token) return undefined;

  return { email: email.trim(), token: token.trim() };
}

/**
 * Resolves to the account display name, or rejects. A throwaway client bound
 * to the credentials being verified — the real one reads from the auth
 * provider, which has not stored them yet. Verifying before storing means a
 * token that is mistyped or missing a scope fails at the moment it is
 * entered, not on the first pull request request.
 */
export async function verifyBitbucketCredentials(credentials: BitbucketCredentials): Promise<string> {
  const probe = new BitbucketApi({ getCredentials: async () => credentials });
  const user = await probe.getJson<{ display_name?: string }>('/user');
  return user.display_name ?? credentials.email;
}
