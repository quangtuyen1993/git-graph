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
 * Bitbucket grants scopes to the token itself, not to the request, so a token
 * created without these can only fail later with a 403 that names nothing.
 * The sign-in prompt lists them verbatim.
 */
export const BITBUCKET_TOKEN_SCOPES = [
  'read:account',
  'read:repository:bitbucket',
  'read:pullrequest:bitbucket',
  'write:pullrequest:bitbucket',
] as const;
