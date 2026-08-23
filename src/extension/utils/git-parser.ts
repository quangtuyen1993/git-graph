import type { Commit, Branch, Tag, FileChange, GitStatus, FileStatusEntry } from '../types/git.types';

// Delimiter that won't appear in commit messages
const FIELD_SEP = '\x1f'; // ASCII Unit Separator
const RECORD_SEP = '\x1e'; // ASCII Record Separator

/**
 * git log --format string that produces parseable output.
 * Use with `git log --format=LOG_FORMAT`
 */
export const LOG_FORMAT = [
  '%H',   // hash
  '%h',   // abbreviated hash
  '%P',   // parent hashes (space-separated)
  '%an',  // author name
  '%ae',  // author email
  '%aI',  // author date ISO 8601
  '%cn',  // committer name
  '%ce',  // committer email
  '%cI',  // committer date ISO 8601
  '%s',   // subject (first line)
  '%b',   // body
  '%D'    // ref names
].join(FIELD_SEP) + RECORD_SEP;

/**
 * git branch --format string.
 * Use with `git branch -a --format=BRANCH_FORMAT`
 */
export const BRANCH_FORMAT =
  `%(HEAD)%(refname:short)${FIELD_SEP}%(objectname:short)${FIELD_SEP}%(upstream:short)${FIELD_SEP}%(committerdate:iso8601-strict)${FIELD_SEP}%(refname)`;

/**
 * git tag --format string.
 * Use with `git tag -l --format=TAG_FORMAT`
 */
export const TAG_FORMAT =
  `%(refname:short)${FIELD_SEP}%(objectname:short)${FIELD_SEP}%(contents:subject)${FIELD_SEP}%(creatordate:iso8601-strict)`;

/**
 * Parse output produced by `git log --format=LOG_FORMAT` into typed Commit objects.
 */
export function parseLog(output: string): Commit[] {
  if (!output.trim()) return [];

  const records = output.split(RECORD_SEP).filter(r => r.trim());
  return records.map(record => {
    const fields = record.trim().split(FIELD_SEP);
    const [
      hash = '',
      abbreviatedHash = '',
      parentStr = '',
      author = '',
      authorEmail = '',
      authorDate = '',
      committer = '',
      committerEmail = '',
      committerDate = '',
      subject = '',
      body = '',
      refStr = ''
    ] = fields;

    const parents = parentStr ? parentStr.split(' ').filter(Boolean) : [];
    const refs = refStr ? refStr.split(',').map(r => r.trim()).filter(Boolean) : [];
    const message = body.trim() ? `${subject}\n\n${body.trim()}` : subject;

    return {
      hash,
      abbreviatedHash,
      parents,
      author,
      authorEmail,
      authorDate,
      committer,
      committerEmail,
      committerDate,
      message,
      subject,
      refs
    };
  });
}

/**
 * Parse output produced by `git branch -a --format=BRANCH_FORMAT` into typed Branch objects.
 */
export function parseBranches(output: string): Branch[] {
  if (!output.trim()) return [];

  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split(FIELD_SEP);
    const rawName = parts[0] ?? '';
    const current = rawName.startsWith('*');
    const name = rawName.replace(/^\*\s*/, '').trim();
    const hash = (parts[1] ?? '').trim();
    const upstream = (parts[2] ?? '').trim() || null;
    const lastCommitDate = (parts[3] ?? '').trim();
    const fullRef = (parts[4] ?? '').trim();

    // A branch is remote if its full refname starts with refs/remotes/
    const isRemote = fullRef.startsWith('refs/remotes/');
    const remote = isRemote ? (name.split('/')[0] ?? null) : null;

    return {
      name,
      current,
      remote,
      upstream,
      hash,
      lastCommitDate
    };
  }).filter(b => !b.name.endsWith('/HEAD'));
}

/**
 * Parse output produced by `git tag -l --format=TAG_FORMAT` into typed Tag objects.
 */
export function parseTags(output: string): Tag[] {
  if (!output.trim()) return [];

  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split(FIELD_SEP);
    const name = (parts[0] ?? '').trim();
    const hash = (parts[1] ?? '').trim();
    const message = (parts[2] ?? '').trim() || null;
    const taggerDate = (parts[3] ?? '').trim() || null;

    return { name, hash, message, taggerDate };
  });
}

/**
 * Parse output produced by `git status --porcelain=v2 --branch -z` into a typed GitStatus.
 * The -z flag uses NUL as the field terminator.
 */
export function parseStatus(output: string): GitStatus {
  const staged: FileStatusEntry[] = [];
  const unstaged: FileStatusEntry[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (!output.trim()) {
    return { staged, unstaged, untracked, conflicted, branch, upstream, ahead, behind };
  }

  const entries = output.split('\0').filter(Boolean);
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];

    // Branch header lines
    if (entry.startsWith('# branch.oid')) {
      i++;
      continue;
    }
    if (entry.startsWith('# branch.head')) {
      branch = entry.slice('# branch.head '.length);
      if (branch === '(detached)') branch = null;
      i++;
      continue;
    }
    if (entry.startsWith('# branch.upstream')) {
      upstream = entry.slice('# branch.upstream '.length);
      i++;
      continue;
    }
    if (entry.startsWith('# branch.ab')) {
      const match = entry.match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
      i++;
      continue;
    }

    // Ordinary changed entry: "1 XY sub mH mI mW hH hI path"
    if (entry.startsWith('1 ')) {
      const xy = entry.substring(2, 4);
      const stagedCode = xy[0];
      const unstagedCode = xy[1];
      // Path starts after the 8th space-separated field
      const path = extractPathFromOrdinary(entry);

      if (stagedCode !== '.') {
        staged.push({ path, status: statusCodeToFileStatus(stagedCode), oldPath: null });
      }
      if (unstagedCode !== '.') {
        unstaged.push({ path, status: statusCodeToFileStatus(unstagedCode), oldPath: null });
      }
      i++;
      continue;
    }

    // Renamed/copied entry: "2 XY sub mH mI mW hH hI Xscore path" then NUL "origPath"
    if (entry.startsWith('2 ')) {
      const xy = entry.substring(2, 4);
      const stagedCode = xy[0];
      const unstagedCode = xy[1];
      const path = extractPathFromRename(entry);
      i++;
      const oldPath = entries[i] ?? null;

      if (stagedCode !== '.') {
        staged.push({ path, status: statusCodeToFileStatus(stagedCode), oldPath });
      }
      if (unstagedCode !== '.') {
        unstaged.push({ path, status: statusCodeToFileStatus(unstagedCode), oldPath: null });
      }
      i++;
      continue;
    }

    // Unmerged (conflict) entry: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
    if (entry.startsWith('u ')) {
      const path = extractPathFromUnmerged(entry);
      conflicted.push(path);
      i++;
      continue;
    }

    // Untracked entry: "? path"
    if (entry.startsWith('? ')) {
      untracked.push(entry.substring(2));
      i++;
      continue;
    }

    // Ignored or unknown — skip
    i++;
  }

  return { staged, unstaged, untracked, conflicted, branch, upstream, ahead, behind };
}

/**
 * Parse output from `git diff --numstat` into typed FileChange objects.
 * Each line: "additions\tdeletions\tpath" or "additions\tdeletions\toldPath\tnewPath" for renames.
 * Binary files show as "-\t-\tpath".
 */
export function parseFileChanges(output: string): FileChange[] {
  if (!output.trim()) return [];

  const lines = output.trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const parts = line.split('\t');
    const rawAdditions = parts[0] ?? '0';
    const rawDeletions = parts[1] ?? '0';
    const binary = rawAdditions === '-' && rawDeletions === '-';
    const additions = binary ? 0 : parseInt(rawAdditions, 10);
    const deletions = binary ? 0 : parseInt(rawDeletions, 10);

    let path: string;
    let oldPath: string | null = null;
    let status: FileChange['status'] = 'modified';

    if (parts.length >= 4) {
      // Renamed: "additions\tdeletions\toldPath\tnewPath"
      oldPath = parts[2] ?? null;
      path = parts[3] ?? '';
      status = 'renamed';
    } else {
      path = parts[2] ?? '';
    }

    return { path, oldPath, status, additions, deletions, binary };
  });
}

// --- Internal helpers ---

function statusCodeToFileStatus(code: string): FileStatusEntry['status'] {
  switch (code) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    default: return 'modified';
  }
}

/**
 * Extract path from porcelain v2 ordinary entry.
 * Format: "1 XY sub mH mI mW hH hI path"
 * The path is everything after the 8th space.
 */
function extractPathFromOrdinary(entry: string): string {
  let spaceCount = 0;
  for (let i = 0; i < entry.length; i++) {
    if (entry[i] === ' ') {
      spaceCount++;
      if (spaceCount === 8) {
        return entry.slice(i + 1);
      }
    }
  }
  return '';
}

/**
 * Extract path from porcelain v2 rename/copy entry.
 * Format: "2 XY sub mH mI mW hH hI Xscore path"
 * The path is everything after the 9th space.
 */
function extractPathFromRename(entry: string): string {
  let spaceCount = 0;
  for (let i = 0; i < entry.length; i++) {
    if (entry[i] === ' ') {
      spaceCount++;
      if (spaceCount === 9) {
        return entry.slice(i + 1);
      }
    }
  }
  return '';
}

/**
 * Extract path from porcelain v2 unmerged entry.
 * Format: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
 * The path is everything after the 10th space.
 */
function extractPathFromUnmerged(entry: string): string {
  let spaceCount = 0;
  for (let i = 0; i < entry.length; i++) {
    if (entry[i] === ' ') {
      spaceCount++;
      if (spaceCount === 10) {
        return entry.slice(i + 1);
      }
    }
  }
  return '';
}
