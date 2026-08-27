import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const source = readFileSync(path.join(__dirname, '../../src/extension/extension.ts'), 'utf8');

// Structural anchors rather than whole-file counts: a whole-file count of 2
// passes just as well when both registrations land in the same factory (and
// the other factory silently gets none) as when they are split correctly.
// Slicing between the factory declarations pins each registration to the
// host it must reach.
const createSessionIdx = source.indexOf('function createSession(');
const createReviewSessionIdx = source.indexOf('function createReviewSession(');
const webviewProviderIdx = source.indexOf('const webviewProvider = new GitGraphWebviewProvider(');

if (createSessionIdx === -1 || createReviewSessionIdx === -1 || webviewProviderIdx === -1) {
  throw new Error('forge-host-wiring.test.ts anchors moved — update the markers above.');
}

const graphHostRegion = source.slice(createSessionIdx, createReviewSessionIdx);
const reviewHostRegion = source.slice(createReviewSessionIdx, webviewProviderIdx);

describe('forge host wiring', () => {
  // Each webview host owns its own MessageRouter, so a namespace registered
  // once reaches only one of them. Counting matches within each factory's own
  // slice (rather than across the whole file) is what actually catches both
  // registrations landing in the same factory.
  it('registers the forge namespace in the graph webview host', () => {
    const registrations = graphHostRegion.match(/router\.register\('forge'/g) ?? [];
    expect(registrations).toHaveLength(1);
  });

  it('registers the forge namespace in the review panel host', () => {
    const registrations = reviewHostRegion.match(/router\.register\('forge'/g) ?? [];
    expect(registrations).toHaveLength(1);
  });

  it('builds the handler once, outside the per-host session factories', () => {
    const declarationIdx = source.indexOf('const forgeHandler = createForgeHandler(');
    expect(declarationIdx).toBeGreaterThan(-1);
    // Not just "appears somewhere" — it must be constructed before the first
    // factory that closes over it, i.e. outside both factories, so the same
    // instance is shared rather than rebuilt per session.
    expect(declarationIdx).toBeLessThan(createSessionIdx);
  });

  it('registers the sign-in and sign-out commands', () => {
    expect(source).toContain('gitGraphPro.forge.signIn');
    expect(source).toContain('gitGraphPro.forge.signOut');
  });

  it('resolves the remote through the configured setting', () => {
    expect(source).toContain('gitGraphPro.forge.remote');
  });

  // Scoped to the repository the push/pull/fetch actually ran against
  // (forge.refresh resolves the current repo and invalidates its prefix)
  // rather than forgeStore.clear(), which would drop cache entries for
  // every repository the workspace has ever shown forge data for — the
  // review panel is retainContextWhenHidden and can still be pinned to a
  // repository that is no longer active.
  it('invalidates only the affected repository\'s forge cache after a push, pull or fetch', () => {
    expect(source).toContain('MUTATING_REMOTE_METHODS');
    expect(source).toMatch(/forgeHandler\('forge\.refresh'/);
    expect(source).not.toMatch(/forgeStore\.clear\(\)/);
  });

  // Makes the manifest's contributes.authentication entry true: without this
  // call nothing backs it — see bitbucket-auth.test.ts's
  // 'declares the bitbucket authentication provider' for the manifest side.
  it('registers the Bitbucket authentication provider with VS Code', () => {
    expect(source).toContain('vscode.authentication.registerAuthenticationProvider(');
    expect(source).toContain('BITBUCKET_AUTH_ID');
    expect(source).toContain('BITBUCKET_AUTH_LABEL');
    expect(source).toContain('supportsMultipleAccounts: false');
  });

  it('pushes the authentication provider registration onto context.subscriptions', () => {
    const idx = source.indexOf('vscode.authentication.registerAuthenticationProvider(');
    expect(idx).toBeGreaterThan(-1);
    // The call sits inside a context.subscriptions.push(...) a few lines up —
    // a registration never disposed would leak on every deactivate/reload.
    const preceding = source.slice(Math.max(0, idx - 120), idx);
    expect(preceding).toContain('context.subscriptions.push(');
  });
});
