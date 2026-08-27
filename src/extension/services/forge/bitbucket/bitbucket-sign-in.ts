import * as vscode from 'vscode';
import type { ForgeRepoRef } from '../forge.types';
import { bitbucketRepoPath, BitbucketApi } from './bitbucket-api';
import type { BitbucketCredentials } from './bitbucket-auth';
import { BITBUCKET_TOKEN_SCOPES } from './bitbucket-constants';

/**
 * Two input boxes rather than a browser flow. Bitbucket Cloud removed app
 * passwords in July 2026 and has no PKCE, so an OAuth consumer would need both
 * a client secret an extension cannot hide and workspace admin rights to
 * create. The scopes are listed verbatim because Bitbucket grants them to the
 * token, not to the request.
 *
 * The email step is optional. Bitbucket Cloud has two token families —
 * an Atlassian-account API token and a repository/project/workspace access
 * token — and only the first has an email to give; the second is not tied to
 * any account at all. Both authenticate identically here (bitbucket-api.ts
 * sends Bearer unconditionally, reading only the token), so nothing about
 * *authentication* depends on this step. It exists purely to produce a
 * nicer account label than `verifyBitbucketCredentials`'s repository-derived
 * fallback — leaving it blank costs nothing but that label.
 *
 * Lives here, not in extension.ts: the composition root wires providers
 * together, it does not need to know Bitbucket asks for an email and a
 * token, or which scopes that token needs.
 */
export async function promptForBitbucketCredentials(): Promise<BitbucketCredentials | undefined> {
  const email = await vscode.window.showInputBox({
    title: 'Sign in to Bitbucket (1 of 2)',
    prompt: 'Your Atlassian account email — optional, used only to label the session. '
      + 'Leave blank if you are using a repository, project or workspace access token.',
    ignoreFocusOut: true,
    validateInput: (value) => (value === '' || value.includes('@') ? undefined : 'Enter a valid email address, or leave this blank'),
  });
  // showInputBox resolves to undefined only on cancellation (Escape, or the
  // box dismissed) — an empty string is a deliberate, accepted answer here
  // (see validateInput above) and must proceed to the token step, not be
  // treated the same as a cancel.
  if (email === undefined) return undefined;

  const token = await vscode.window.showInputBox({
    title: 'Sign in to Bitbucket (2 of 2)',
    prompt: `API token or access token with scopes: ${BITBUCKET_TOKEN_SCOPES.join(', ')}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Paste the token'),
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
 *
 * Probes `repo` — the repository the user already has open (see
 * `BitbucketAuthDeps.resolveRepo`) — rather than `/2.0/user`: nothing else in
 * this extension reads user data, so asking for a user-read scope only to
 * produce a nicer sign-in label is what turned a correctly-scoped token into
 * a 403 on everything. A token that can read this repository is a token that
 * can do the job; one that cannot fails right here, which is the point of
 * verifying before storing.
 *
 * The label prefers, in order: the email the user typed (most personal, if
 * they gave one), the repository's workspace name, its full name, and
 * finally the repository owner — always something honest, never a call to an
 * endpoint this extension has no other reason to use.
 */
export async function verifyBitbucketCredentials(
  credentials: BitbucketCredentials, repo: ForgeRepoRef,
): Promise<string> {
  const probe = new BitbucketApi({ getCredentials: async () => credentials });
  const repository = await probe.getJson<{ full_name?: string; workspace?: { name?: string } }>(
    bitbucketRepoPath(repo),
  );
  return credentials.email || repository.workspace?.name || repository.full_name || repo.owner;
}
