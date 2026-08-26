export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

const DIFF_GIT_LINE = /^diff --git a\/(.+) b\/(.+)$/;

interface FileAccumulator {
  path: string;
  oldPath: string;
  additions: number;
  deletions: number;
  binary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

/**
 * Turns the unified-diff text `forge.pr.diff` returns into the same
 * `ChangedFile[]` shape `git.show` produces, so `PullRequestDetail` can list
 * a pull request's changed files without the host needing to understand
 * Bitbucket's diff format at all — the parsing lives entirely in the webview,
 * on text that already crossed the message boundary as a plain string.
 *
 * Deliberately does not resolve a file's line-level hunks, only the per-file
 * summary (path, status, +/- counts): the file list this feeds is read-only
 * (see `PullRequestDetail.svelte`), so nothing downstream needs more.
 */
export function parseUnifiedDiff(diffText: string): ChangedFile[] {
  if (!diffText) return [];

  const files: ChangedFile[] = [];
  let current: FileAccumulator | null = null;

  const flush = (): void => {
    if (!current) return;
    let status = 'modified';
    if (current.isRenamed) status = 'renamed';
    else if (current.isNew) status = 'added';
    else if (current.isDeleted) status = 'deleted';

    files.push({
      path: current.path,
      oldPath: current.isRenamed && current.oldPath !== current.path ? current.oldPath : null,
      status,
      additions: current.additions,
      deletions: current.deletions,
      binary: current.binary,
    });
    current = null;
  };

  for (const line of diffText.split('\n')) {
    const header = DIFF_GIT_LINE.exec(line);
    if (header) {
      flush();
      current = {
        path: header[2],
        oldPath: header[1],
        additions: 0,
        deletions: 0,
        binary: false,
        isNew: false,
        isDeleted: false,
        isRenamed: false,
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) { current.isNew = true; continue; }
    if (line.startsWith('deleted file mode')) { current.isDeleted = true; continue; }
    if (line.startsWith('rename from ')) {
      current.isRenamed = true;
      current.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.isRenamed = true;
      current.path = line.slice('rename to '.length);
      continue;
    }
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) { current.binary = true; continue; }
    // File markers (`---`/`+++`) and the hunk header (`@@ … @@`) all sit
    // above the +/- content lines this counts; a "no newline at end of file"
    // marker (`\ …`) sits below one. None of the three is a content line.
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@') || line.startsWith('\\')) continue;
    if (line.startsWith('+')) { current.additions += 1; continue; }
    if (line.startsWith('-')) { current.deletions += 1; continue; }
  }
  flush();

  return files;
}

export interface FileDiffContent {
  oldContent: string;
  newContent: string;
}

const HUNK_HEADER = /^@@ .* @@/;

/**
 * Reconstructs one file's old and new text from its own slice of a unified
 * diff — no local commit involved. Only what a hunk actually carries (its
 * context lines plus its +/- lines) is known; nothing outside a hunk is
 * fabricated, so two non-adjacent hunks are joined by a blank line on both
 * sides rather than pretending the file is contiguous between them.
 *
 * This is what lets a pull request's changed-file rows open a real diff
 * editor even when the pull request's head commit was never fetched locally
 * — `forge.pr.diff` already returns the whole diff as plain text, sha-keyed
 * and immutably cached, so no git resolution is needed to render one file's
 * slice of it.
 */
export function extractFileDiffContent(diffText: string, path: string): FileDiffContent | null {
  if (!diffText) return null;

  const segments = diffText.split(/(?=^diff --git )/m);
  const segment = segments.find((candidate) => {
    const header = DIFF_GIT_LINE.exec(candidate.split('\n', 1)[0]);
    return header?.[2] === path;
  });
  if (!segment) return null;

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = false;

  for (const line of segment.split('\n')) {
    if (HUNK_HEADER.test(line)) {
      if (inHunk) { oldLines.push(''); newLines.push(''); }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) { newLines.push(line.slice(1)); continue; }
    if (line.startsWith('-')) { oldLines.push(line.slice(1)); continue; }
    if (line.startsWith(' ')) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); continue; }
  }

  return { oldContent: oldLines.join('\n'), newContent: newLines.join('\n') };
}
