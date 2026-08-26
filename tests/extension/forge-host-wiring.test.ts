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

  it('clears the forge cache after a push, pull or fetch', () => {
    expect(source).toContain('MUTATING_REMOTE_METHODS');
    expect(source).toMatch(/forgeStore\.clear\(\)/);
  });
});
