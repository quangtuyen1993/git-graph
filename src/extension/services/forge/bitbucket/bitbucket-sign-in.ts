import * as vscode from 'vscode';
import type { ForgeRepoRef } from '../forge.types';
import { bitbucketRepoPath, BitbucketApi } from './bitbucket-api';
import type { BitbucketCredentials } from './bitbucket-auth';
import { BITBUCKET_TOKEN_SCOPES } from './bitbucket-constants';

/**
 * One input box, not a browser flow. Bitbucket Cloud removed app passwords in
 * July 2026 and has no PKCE, so an OAuth consumer would need both a client
 * secret an extension cannot hide and workspace admin rights to create. The
 * scopes are listed verbatim because Bitbucket grants them to the token, not
 * to the request.
 *
 * Bitbucket authentication is Bearer-only, and Bearer needs nothing besides
 * the token — an Atlassian-account API token and a repository/project/
 * workspace access token authenticate identically here (bitbucket-api.ts
 * sends Bearer unconditionally), and the second has no Atlassian account, and
 * so no email, behind it at all. There is accordingly nothing to ask for but
 * the token; `verifyBitbucketCredentials` derives the account label from the
 * repository it verifies against instead.
 *
 * Lives here, not in extension.ts: the composition root wires providers
 * together, it does not need to know which scopes Bitbucket's token needs.
 */
export async function promptForBitbucketCredentials(): Promise<BitbucketCredentials | undefined> {
  const token = await vscode.window.showInputBox({
    title: 'Sign in to Bitbucket',
    prompt: `API token or access token with scopes: ${BITBUCKET_TOKEN_SCOPES.join(', ')}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Paste the token'),
  });
  if (!token) return undefined;

  return { token: token.trim() };
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
 * The label prefers, in order: the repository's workspace name, its full
 * name, and finally the repository owner — always something honest, never a
 * call to an endpoint this extension has no other reason to use, and never
 * empty: a Bearer-only credential carries no email to prefer over these, so
 * this fallback chain is the whole of the label, not a second choice to it.
 */
export async function verifyBitbucketCredentials(
  credentials: BitbucketCredentials, repo: ForgeRepoRef,
): Promise<string> {
  const probe = new BitbucketApi({ getCredentials: async () => credentials });
  const repository = await probe.getJson<{ full_name?: string; workspace?: { name?: string } }>(
    bitbucketRepoPath(repo),
  );
  return repository.workspace?.name || repository.full_name || repo.owner;
}
