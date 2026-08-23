import path from 'path';
import type { Commit, Branch, Tag, FileChange, GitStatus, FileStatusEntry, SubmoduleEntry, SubmoduleState } from '../types/git.types';

// Delimiter that won't appear in commit messages
const FIELD_SEP = '\x1f'; // ASCII Unit Separator
const RECORD_SEP = '\x1e'; // ASCII Record Separator

const SUBMODULE_STATES: Record<string, SubmoduleState> = {
  ' ': 'initialized',
  '-': 'uninitialized',
  '+': 'modified',
  U: 'conflicted',
};

export function parseSubmoduleConfig(output: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of output.split('\n').filter(Boolean)) {
    const separator = line.search(/\s/);
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const relativePath = line.slice(separator).trim();
    const match = key.match(/^submodule\.(.+)\.path$/);
    if (match && relativePath) names.set(relativePath, match[1]);
  }
  return names;
}

export function parseSubmoduleStatus(
  output: string,
  repoPath: string,
  namesByPath: Map<string, string>,
): SubmoduleEntry[] {
  if (!output.trim()) return [];

  return output.split('\n').filter(Boolean).map(line => {
    const match = line.match(/^([ +\-U])([0-9a-f]{40})\s+(.+?)(?:\s+\([^)]*\))?$/);
    if (!match) throw new Error(`Unable to parse submodule status: ${line}`);

    const [, prefix, hash, relativePath] = match;
    const state = SUBMODULE_STATES[prefix];
    if (!state) throw new Error(`Unable to parse submodule status: ${line}`);

    return {
      name: namesByPath.get(relativePath) ?? path.basename(relativePath),
      path: relativePath,
      absolutePath: path.join(repoPath, relativePath),
      head: state === 'uninitialized' ? null : hash,
      state,
    };
  });
}

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
  `%(HEAD)%(refname:short)${FIELD_SEP}%(objectname)${FIELD_SEP}%(upstream:short)${FIELD_SEP}%(committerdate:iso8601-strict)${FIELD_SEP}%(refname)${FIELD_SEP}%(upstream:track,nobracket)`;

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
    const trackInfo = (parts[5] ?? '').trim();

    // A branch is remote if its full refname starts with refs/remotes/
    const isRemote = fullRef.startsWith('refs/remotes/');
    // Skip symbolic HEAD refs (e.g. refs/remotes/origin/HEAD)
    const isSymbolicHead = fullRef.endsWith('/HEAD');
    const remote = isRemote ? (name.split('/')[0] ?? null) : null;

    // Parse ahead/behind from track info (e.g. "ahead 3, behind 2" or "ahead 1")
    let ahead = 0;
    let behind = 0;
    if (trackInfo) {
      const aheadMatch = trackInfo.match(/ahead (\d+)/);
      const behindMatch = trackInfo.match(/behind (\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);
    }

    return {
      name,
      current,
      remote,
      upstream,
      hash,
      lastCommitDate,
      ahead,
      behind,
      _skip: isSymbolicHead
    };
  }).filter(b => b.name && !b._skip).map(({ _skip, ...rest }) => rest);
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
 * Parse NUL-delimited `git diff --numstat -z -M -C` and
 * `git diff --name-status -z -M -C` output into typed file changes.
 */
export function parseFileChanges(numstatOutput: string, nameStatusOutput: string): FileChange[] {
  const numstatRecords = parseNumstatRecords(numstatOutput);
  const statusRecords = parseNameStatusRecords(nameStatusOutput);

  if (numstatRecords.length !== statusRecords.length) {
    throw new Error(
      `Unable to reconcile file change streams: ${numstatRecords.length} numstat records and ${statusRecords.length} name-status records`,
    );
  }

  const statsByPath = new Map(numstatRecords.map(record => [fileChangeIdentity(record), record]));
  const changes = statusRecords.map(statusRecord => {
    const identity = fileChangeIdentity(statusRecord);
    const statRecord = statsByPath.get(identity);
    if (!statRecord) {
      throw new Error(`Unable to reconcile file change streams: missing numstat record for ${describeFileChange(statusRecord)}`);
    }
    statsByPath.delete(identity);
    return { ...statusRecord, ...statRecord };
  });

  if (statsByPath.size > 0) {
    const [record] = statsByPath.values();
    throw new Error(`Unable to reconcile file change streams: missing name-status record for ${describeFileChange(record)}`);
  }

  return changes;
}

type FileChangeIdentity = Pick<FileChange, 'path' | 'oldPath'>;
type FileChangeStats = FileChangeIdentity & Pick<FileChange, 'additions' | 'deletions' | 'binary'>;
type FileChangeStatus = FileChangeIdentity & Pick<FileChange, 'status'>;

function parseNumstatRecords(output: string): FileChangeStats[] {
  if (!output) return [];

  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const records: FileChangeStats[] = [];

  for (let index = 0; index < fields.length; index++) {
    const statField = fields[index] ?? '';
    const firstTab = statField.indexOf('\t');
    const secondTab = statField.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      if (isCommitHeader(statField)) continue;
      throw new Error(`Unable to parse numstat record: ${JSON.stringify(statField)}`);
    }

    const additionsField = statField.slice(0, firstTab);
    const deletionsField = statField.slice(firstTab + 1, secondTab);
    const inlinePath = statField.slice(secondTab + 1);
    const binary = additionsField === '-' && deletionsField === '-';

    let oldPath: string | null = null;
    let path = inlinePath;
    if (inlinePath === '') {
      oldPath = fields[++index] ?? null;
      path = fields[++index] ?? '';
      if (oldPath === null || path === '') {
        throw new Error('Unable to parse numstat rename or copy record');
      }
    }

    records.push({
      path,
      oldPath,
      additions: binary ? 0 : parseFileChangeCount(additionsField, 'additions'),
      deletions: binary ? 0 : parseFileChangeCount(deletionsField, 'deletions'),
      binary,
    });
  }

  return records;
}

function parseNameStatusRecords(output: string): FileChangeStatus[] {
  if (!output) return [];

  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const records: FileChangeStatus[] = [];

  for (let index = 0; index < fields.length; index++) {
    const statusField = fields[index] ?? '';
    if (isCommitHeader(statusField)) continue;
    const status = statusCodeToFileChangeStatus(statusField[0] ?? '');
    if (!status) {
      throw new Error(`Unable to parse name-status record: ${JSON.stringify(statusField)}`);
    }

    if (status === 'renamed' || status === 'copied') {
      const oldPath = fields[++index] ?? '';
      const path = fields[++index] ?? '';
      if (!oldPath || !path) {
        throw new Error(`Unable to parse ${status} name-status record`);
      }
      records.push({ path, oldPath, status });
    } else {
      const path = fields[++index] ?? '';
      if (!path) {
        throw new Error(`Unable to parse ${status} name-status record`);
      }
      records.push({ path, oldPath: null, status });
    }
  }

  return records;
}

function parseFileChangeCount(value: string, label: string): number {
  const count = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Unable to parse numstat ${label}: ${JSON.stringify(value)}`);
  }
  return count;
}

function fileChangeIdentity({ oldPath, path }: FileChangeIdentity): string {
  return `${oldPath ?? ''}\0${path}`;
}

function describeFileChange({ oldPath, path }: FileChangeIdentity): string {
  return oldPath ? `${JSON.stringify(oldPath)} -> ${JSON.stringify(path)}` : JSON.stringify(path);
}

function statusCodeToFileChangeStatus(code: string): FileChange['status'] | null {
  switch (code) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    default: return null;
  }
}

function isCommitHeader(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
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
