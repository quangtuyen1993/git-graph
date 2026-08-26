import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from '../../src/extension/services/forge/url-safety';

describe('isAllowedExternalUrl', () => {
  it('allows https', () => {
    expect(isAllowedExternalUrl('https://bitbucket.org/acme/mpos/pull-requests/123')).toBe(true);
  });

  it('allows http', () => {
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
  });

  // openExternal does not just "open a web page" — it dispatches to the OS
  // URI handler, including vscode://<publisher>.<extension>/..., which
  // activates and invokes another extension's UriHandler.
  it('refuses a vscode: URI', () => {
    expect(isAllowedExternalUrl('vscode://some.extension/do-something')).toBe(false);
  });

  it('refuses a file: URI', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
  });

  it('refuses a javascript: URI', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('refuses an unparseable string', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false);
  });

  it('refuses an empty string', () => {
    expect(isAllowedExternalUrl('')).toBe(false);
  });
});
