/**
 * Guards `vscode.env.openExternal`, which does not just "open a web page" —
 * it dispatches to the OS URI handler, including a `vscode://<publisher>.
 * <extension>/...` URI, which activates and invokes another extension's
 * `UriHandler`. The URL this guards (`PullRequestDetail.webUrl`) comes
 * straight from the host's raw API response with no validation anywhere
 * between fetch and the call to `openExternal`, so a malformed or hostile
 * response must not be able to drive an arbitrary URI scheme. Provider-
 * agnostic and vscode-free on purpose: every forge's webUrl goes through the
 * same check, and it needs no vscode API to make the call.
 */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
