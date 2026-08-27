/**
 * The identity and scope constants a Bitbucket consumer needs. Split out of
 * `bitbucket-auth.ts` so that importing them does not also pull in `vscode`:
 * `bitbucket-auth.ts` needs it (for `EventEmitter`), but a consumer that only
 * wants these three values — like the provider — does not, and every test
 * that imports such a consumer would otherwise inherit a hard dependency on
 * `vscode` resolving at module load for logic it never touches.
 */

export const BITBUCKET_AUTH_ID = 'bitbucket-cloud';
export const BITBUCKET_AUTH_LABEL = 'Bitbucket';

/**
 * Bitbucket Cloud's own host, shared between `BitbucketCloudProvider.canHandle`
 * and the sign-in path's repo resolution (extension.ts) — verification needs
 * to know, before a session exists, whether the currently open repository is
 * one this provider can even talk to, which `canHandle` alone cannot answer
 * from outside the provider instance.
 */
export const BITBUCKET_CLOUD_HOST = 'bitbucket.org';

/**
 * Bitbucket grants scopes to the token itself, not to the request, so a token
 * created without these can only fail later with a 403 that names nothing.
 * The sign-in prompt lists them verbatim.
 *
 * No user-read scope appears here: verification (bitbucket-sign-in.ts)
 * probes the repository the user has open, not `/2.0/user` — nothing else in
 * this extension reads user data, so asking for permission to do so would be
 * asking for more than the extension uses, which is exactly what put a
 * correctly-scoped-for-everything-else token through a 403 in the first
 * place (see the 2026-08-27 incident report).
 */
export const BITBUCKET_TOKEN_SCOPES = [
  'read:repository:bitbucket',
  'read:pullrequest:bitbucket',
  'write:pullrequest:bitbucket',
] as const;
