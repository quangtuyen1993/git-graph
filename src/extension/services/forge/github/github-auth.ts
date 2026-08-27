import * as vscode from 'vscode';
import { GITHUB_AUTH_ID, GITHUB_TOKEN_SCOPES } from './github-constants';

/**
 * The token `GitHubApi` sends as a Bearer credential. Routed through VS
 * Code's built-in `github` authentication provider — never a bespoke flow,
 * unlike Bitbucket, which has no built-in provider to consume.
 *
 * Always `createIfNone: false`: this is called on every authenticated API
 * request, including ones made while `forge.status` is merely checking
 * whether a session already exists. A caller that wants to establish one
 * goes through `GitHubCloudProvider.getSession({ createIfNone: true })`,
 * which VS Code then caches — this function observes that cache, it never
 * prompts on its own.
 */
export async function getGitHubAccessToken(): Promise<string | undefined> {
  const session = await vscode.authentication.getSession(
    GITHUB_AUTH_ID, [...GITHUB_TOKEN_SCOPES], { createIfNone: false },
  );
  return session?.accessToken;
}
