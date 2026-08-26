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

  // A crafted remote must never yield an owner/name that lets a provider
  // build a path-traversal request. SCP-style remotes are the real risk: git
  // writes them by default for ssh, and unlike https:// they are not run
  // through a URL parser that normalizes dot segments, so `..`/`.` survive
  // verbatim into owner/name unless rejected here.
  it.each([
    'git@bitbucket.org:../evil.git',
    'git@bitbucket.org:./evil.git',
    'git@bitbucket.org:acme/../evil.git',
    'git@bitbucket.org:acme/../../evil.git',
    // https:// equivalents: the URL parser normalizes these away before
    // splitOwnerAndName ever sees a `.`/`..` segment, so this pins that the
    // normalizing branch stays safe rather than exercising the new guard.
    'https://bitbucket.org/../evil.git',
    'https://bitbucket.org/./evil.git',
    'https://bitbucket.org/acme/../evil.git',
  ])('returns undefined for a traversal segment in %j', (url) => {
    expect(parseRemoteUrl(url)).toBeUndefined();
  });
});
