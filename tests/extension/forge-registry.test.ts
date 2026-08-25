import { describe, expect, it } from 'vitest';
import { ForgeRegistry } from '../../src/extension/services/forge/forge-registry';
import { FakeForgeProvider } from '../helpers/fake-forge-provider';

const bitbucket = () => new FakeForgeProvider({ id: 'bitbucket-cloud', name: 'Bitbucket', host: 'bitbucket.org' });
const github = () => new FakeForgeProvider({ id: 'github', name: 'GitHub', host: 'github.com' });

describe('ForgeRegistry', () => {
  it('resolves the provider that claims the host', () => {
    const registry = new ForgeRegistry();
    registry.register(github());
    registry.register(bitbucket());

    const resolved = registry.resolve({ host: 'bitbucket.org', owner: 'acme', name: 'mpos' });
    expect(resolved?.id).toBe('bitbucket-cloud');
  });

  it('returns undefined when no provider claims the host', () => {
    const registry = new ForgeRegistry();
    registry.register(bitbucket());
    expect(registry.resolve({ host: 'gitlab.com', owner: 'acme', name: 'mpos' })).toBeUndefined();
  });

  it('keeps registration order so the first claimant wins', () => {
    const registry = new ForgeRegistry();
    const first = new FakeForgeProvider({ id: 'first', name: 'First', host: 'bitbucket.org' });
    registry.register(first);
    registry.register(bitbucket());
    expect(registry.resolve({ host: 'bitbucket.org', owner: 'a', name: 'b' })?.id).toBe('first');
  });
});
