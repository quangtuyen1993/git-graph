import type { ForgeProvider, ParsedRemote } from './forge.types';

/**
 * Maps a remote to the provider that owns it. Registration order is the
 * resolution order, so a more specific provider can be registered ahead of a
 * catch-all one.
 */
export class ForgeRegistry {
  private readonly providers: ForgeProvider[] = [];

  public register(provider: ForgeProvider): void {
    this.providers.push(provider);
  }

  public resolve(remote: ParsedRemote): ForgeProvider | undefined {
    return this.providers.find((provider) => provider.canHandle(remote));
  }
}
