import { ForgeError } from '../forge.types';
import { BITBUCKET_TOKEN_SCOPES } from './bitbucket-constants';

/**
 * The provider-specific half of a Bitbucket error message: naming the exact
 * token scopes a 'forbidden' is missing, or explaining a 'not-found' the same
 * way. This is the one implementation both `BitbucketCloudProvider.describeError`
 * (consulted by the shared handler's catch — see `forgeErrorMessage` in
 * forge-method-handler.ts) and `BitbucketAuthProvider.createSession` (which
 * must translate a verification failure itself — see the comment there) call,
 * so the wording lives in exactly one place under `forge/bitbucket/` rather
 * than being duplicated between them. Does not import `vscode` so nothing
 * that only needs this text also inherits a vscode module-load dependency.
 */
export function describeBitbucketError(error: ForgeError): string {
  if (error.kind === 'forbidden') {
    return `Bitbucket refused the request. The API token is missing a scope. Required: ${BITBUCKET_TOKEN_SCOPES.join(', ')}.`;
  }
  if (error.kind === 'not-found') {
    return 'Cannot access this repository or pull request on Bitbucket — it may be private, or the API token is missing a scope.';
  }
  return error.hostMessage;
}
