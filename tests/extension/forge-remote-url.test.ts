import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../../src/extension/services/forge/remote-url';

describe('parseRemoteUrl', () => {
  it.each([
    ['git@bitbucket.org:acme/mpos.git',            { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['git@bitbucket.org:acme/mpos',                { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['https://tuyen@bitbucket.org/acme/mpos.git',  { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['https://bitbucket.org/acme/mpos',            { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['ssh://git@bitbucket.org/acme/mpos.git',      { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['https://github.com/acme/mpos.git',           { host: 'github.com',    owner: 'acme', name: 'mpos' }],
    ['git@bitbucket.org:acme/sub/mpos.git',        { host: 'bitbucket.org', owner: 'acme', name: 'sub/mpos' }],
  ])('parses %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected);
  });

  // Every repository in the workspace runs through this on load, so a bad
  // remote must yield "no provider", never an exception.
  it.each([
    '', '   ', 'not a url', '/local/path/repo.git', 'file:///srv/repo.git', 'git@host-with-no-path',
    'git@bitbucket.org:acme/', 'https://bitbucket.org/acme',
  ])(
    'returns undefined for %j', (url) => {
      expect(parseRemoteUrl(url)).toBeUndefined();
    });
});
