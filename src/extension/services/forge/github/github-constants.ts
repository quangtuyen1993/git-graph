/**
 * The identity and scope constants a GitHub consumer needs. Split out of
 * `github-auth.ts` for the same reason `bitbucket-constants.ts` is split from
 * `bitbucket-auth.ts`: a consumer that only wants these values (the provider,
 * the API client) should not have to pull in `vscode` at module load.
 */

/**
 * Must match the id VS Code's built-in GitHub authentication provider
 * registers itself under — this extension never registers its own GitHub
 * `AuthenticationProvider` the way it does for Bitbucket, it only consumes
 * the one VS Code already ships.
 */
export const GITHUB_AUTH_ID = 'github';
export const GITHUB_PROVIDER_LABEL = 'GitHub';

/**
 * `repo` is the scope the built-in provider needs to grant read/write access
 * to pull requests on both public and private repositories — approving,
 * requesting changes and merging all need write access, so the narrower
 * `public_repo` would silently fail on a private repository.
 */
export const GITHUB_TOKEN_SCOPES = ['repo'] as const;

export const GITHUB_API_BASE = 'https://api.github.com';
