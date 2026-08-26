/** Host plus the two path segments every forge uses to address a repository. */
export interface ParsedRemote {
  host: string;
  owner: string;
  name: string;
}

// scp-style: git@host:path — the form git writes by default for ssh remotes.
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(.+)$/;

/**
 * `.`, `..` and empty are the segments a path-traversal remote is built from.
 * `encodeURIComponent` does not escape `.` (RFC 3986 unreserved), so a
 * segment like this surviving into a provider's request path can redirect an
 * authenticated request off the endpoint it was meant to hit.
 */
function isTraversalSegment(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..';
}

function splitOwnerAndName(rawPath: string): { owner: string; name: string } | undefined {
  const path = rawPath.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const firstSlash = path.indexOf('/');
  if (firstSlash <= 0) return undefined;

  const owner = path.slice(0, firstSlash);
  // Splitting on the first slash rather than the last is deliberate: some
  // forges (e.g. GitLab subgroups, Azure DevOps projects) nest additional
  // path segments between the owner and the repository, and everything after
  // the first segment is the repository's name — splitting on the last slash
  // would drop those segments.
  const name = path.slice(firstSlash + 1);
  if (!name) return undefined;

  // A remote URL is untrusted input (an SCP-style URL is not normalized the
  // way the URL parser normalizes https://, so a `..` segment survives
  // verbatim into owner/name here). Refuse to produce a ParsedRemote a
  // provider could turn into a traversal path — same as any other
  // unparseable remote, this is simply absent for that repository.
  if (isTraversalSegment(owner)) return undefined;
  if (name.split('/').some(isTraversalSegment)) return undefined;

  return { owner, name };
}

/**
 * Best-effort parse of a git remote. Returns undefined rather than throwing:
 * unparseable and non-forge remotes are the normal case, not an error.
 */
export function parseRemoteUrl(url: string): ParsedRemote | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    // A local clone has no host to attribute to any provider.
    if (!parsed.hostname || parsed.protocol === 'file:') return undefined;
    const split = splitOwnerAndName(parsed.pathname);
    return split ? { host: parsed.hostname, ...split } : undefined;
  }

  const scp = SCP_LIKE.exec(trimmed);
  if (!scp) return undefined;
  const [, , host, path] = scp;
  if (!host || host.includes(' ')) return undefined;
  const split = splitOwnerAndName(path);
  return split ? { host, ...split } : undefined;
}
