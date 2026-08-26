import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const source = readFileSync(path.join(__dirname, '../../src/extension/extension.ts'), 'utf8');

describe('forge host wiring', () => {
  // Each webview host owns its own MessageRouter, so a namespace registered
  // once reaches only one of them.
  it('registers the forge namespace on both hosts', () => {
    const registrations = source.match(/router\.register\('forge'/g) ?? [];
    expect(registrations).toHaveLength(2);
  });

  it('builds the handler once, outside the per-host session factories', () => {
    expect(source).toMatch(/const forgeHandler = createForgeHandler\(/);
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
