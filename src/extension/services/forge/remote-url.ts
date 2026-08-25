/** Host plus the two path segments every forge uses to address a repository. */
export interface ParsedRemote {
  host: string;
  owner: string;
  name: string;
}

// scp-style: git@host:path — the form git writes by default for ssh remotes.
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(.+)$/;

function splitOwnerAndName(rawPath: string): { owner: string; name: string } | undefined {
  const path = rawPath.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const firstSlash = path.indexOf('/');
  if (firstSlash <= 0) return undefined;

  const owner = path.slice(0, firstSlash);
  // Bitbucket project paths can nest, so everything after the workspace is the
  // repository's name — splitting on the last slash would drop those segments.
  const name = path.slice(firstSlash + 1);
  return name ? { owner, name } : undefined;
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
