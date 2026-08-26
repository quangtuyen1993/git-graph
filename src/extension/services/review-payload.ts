/**
 * Assembles the text handed to the reviewing model.
 *
 * The previous implementation concatenated a prompt with `diff.slice(0, 100_000)`,
 * which silently cut the diff mid-hunk — often mid-line. The model then reviewed a
 * corrupted, partial change and nobody could tell. This module instead:
 *
 *  - always includes the complete file list and stat summary, so the model knows
 *    the true shape of the change even when hunks must be dropped
 *  - splits the diff on file boundaries and only ever includes whole files
 *  - names every omitted file explicitly, so both the model and the reader know
 *    what was left out instead of silently losing it
 */

export interface ReviewFileSummary {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * One prior comment, rendered ahead of the diff so the model reviews with the
 * same context a human reviewer would have. Deliberately not `ForgeComment`:
 * this module stays provider-agnostic — a caller maps whatever comment shape
 * it has (a pull request's, one day an issue's) into this before calling in.
 */
export interface PriorDiscussionEntry {
  author: string;
  body: string;
  path?: string;
  line?: number;
  /**
   * Which side of the diff `line` refers to. Present only alongside `line`.
   * Without it a comment anchored to a line the change deleted — which has no
   * counterpart on the new side — is ambiguous.
   */
  side?: 'old' | 'new';
}

export interface ReviewPayloadInput {
  baseBranch: string;
  headBranch: string;
  /** Full `git diff base...head` output. */
  diff: string;
  /** Parsed file summaries for the same range. */
  files?: ReviewFileSummary[];
  /** Commit subjects in the range, newest first. */
  commits?: string[];
  /** Prior comments on the change, rendered ahead of the diff. */
  priorDiscussion?: PriorDiscussionEntry[];
  /**
   * Character budget for the diff body. Omit or pass 0 to send the diff in full,
   * which is the default: the reviewer should see the real change. A budget is
   * only useful as an escape hatch when a model rejects the request for size.
   */
  budget?: number;
}

export interface ReviewPayload {
  text: string;
  includedFiles: number;
  omittedFiles: string[];
  truncated: boolean;
}

export const REVIEW_INSTRUCTIONS = `You are a senior code reviewer. Review the change below and report:

1. **Summary** — what this change does and why, in 2-3 sentences.
2. **Findings** — concrete problems, each with the file and, where visible, the line.
   Label every finding Critical, Important, or Minor:
   - Critical: data loss, security holes, crashes, broken builds.
   - Important: incorrect behaviour, race conditions, unhandled errors, missing
     validation, resource leaks, breaking API changes.
   - Minor: naming, dead code, duplication, missing tests for new branches.
   State the impact, not just the observation. If you find nothing at a level, say so.
3. **Risks** — anything the diff alone cannot prove safe: callers you cannot see,
   migrations, config or dependency changes, behaviour that needs manual testing.
4. **Verdict** — APPROVE, REQUEST_CHANGES, or COMMENT, with one line of reasoning.

Ground every finding in the diff. Do not invent code that is not shown, and do not
report style preferences as defects. If a section of the diff was omitted (noted
below), say what you could not assess rather than guessing.`;

/** Split a unified diff into per-file chunks, keyed by the path git reports. */
export function splitDiffByFile(diff: string): { path: string; text: string }[] {
  if (!diff.trim()) return [];

  const chunks: { path: string; text: string }[] = [];
  const lines = diff.split('\n');
  let current: { path: string; text: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) chunks.push({ path: current.path, text: current.text.join('\n') });
      current = { path: parseDiffGitPath(line), text: [line] };
    } else if (current) {
      current.text.push(line);
    }
    // Lines before the first `diff --git` header (there normally are none) are dropped.
  }
  if (current) chunks.push({ path: current.path, text: current.text.join('\n') });

  return chunks;
}

/**
 * Extract the post-image path from a `diff --git a/x b/y` header.
 * Paths containing spaces make this ambiguous, so prefer the `b/` half and fall
 * back to the raw header rather than guessing wrong.
 */
function parseDiffGitPath(header: string): string {
  const rest = header.slice('diff --git '.length).trim();

  // Quoted form: git quotes paths when they need escaping.
  const quoted = rest.match(/^"(.+)" "(.+)"$/);
  if (quoted) return quoted[2].replace(/^b\//, '');

  // Unambiguous common case: split at " b/" once.
  const marker = rest.indexOf(' b/');
  if (marker !== -1) return rest.slice(marker + 3);

  const half = Math.floor(rest.length / 2);
  return rest.slice(half).trim().replace(/^b\//, '') || rest;
}

function statLine(f: ReviewFileSummary): string {
  const rename = f.oldPath && f.oldPath !== f.path ? ` (renamed from ${f.oldPath})` : '';
  const churn = f.binary ? 'binary' : `+${f.additions} -${f.deletions}`;
  return `- ${f.status.padEnd(8)} ${f.path}${rename} — ${churn}`;
}

function discussionLine(c: PriorDiscussionEntry): string {
  if (!c.path) return `- **${c.author}**: ${c.body.replace(/\r?\n+/g, ' ')}`;
  const line = typeof c.line === 'number' ? `:${c.line}` : '';
  const side = c.side ? ` (${c.side} side)` : '';
  return `- **${c.author}** on \`${c.path}${line}\`${side}: ${c.body.replace(/\r?\n+/g, ' ')}`;
}

export function buildReviewPayload(input: ReviewPayloadInput): ReviewPayload {
  const { baseBranch, headBranch, diff, files, commits, priorDiscussion, budget } = input;

  const header: string[] = [
    REVIEW_INSTRUCTIONS,
    '',
    '---',
    '',
    `## Change under review`,
    '',
    `Comparing \`${baseBranch}\` (base) with \`${headBranch}\` (head).`,
    `The diff is \`git diff ${baseBranch}...${headBranch}\`: only what head added since it diverged.`,
    '',
  ];

  if (commits?.length) {
    header.push(`### Commits (${commits.length}, newest first)`, '');
    header.push(...commits.map((subject) => `- ${subject}`));
    header.push('');
  }

  if (files?.length) {
    const adds = files.reduce((n, f) => n + f.additions, 0);
    const dels = files.reduce((n, f) => n + f.deletions, 0);
    header.push(
      `### Files changed (${files.length} files, +${adds} -${dels})`,
      '',
      ...files.map(statLine),
      '',
    );
  }

  // Ahead of the diff, same as a human reviewer would see it before the code.
  if (priorDiscussion?.length) {
    header.push(`### Prior discussion (${priorDiscussion.length} comments)`, '');
    header.push(...priorDiscussion.map(discussionLine));
    header.push('');
  }

  const chunks = splitDiffByFile(diff);

  // No per-file split possible (empty diff): fall back to the raw body.
  if (chunks.length === 0) {
    const body = diff.trim() ? diff : '(no textual differences)';
    return {
      text: [...header, '### Diff', '', body, ''].join('\n'),
      includedFiles: 0,
      omittedFiles: [],
      truncated: false,
    };
  }

  // Default: send every file. Only when an explicit budget is set do we drop
  // files, and then only whole files, never a partial hunk.
  const unlimited = !budget || budget <= 0;
  const included: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const cost = chunk.text.length + 1;
    if (unlimited || used + cost <= budget || included.length === 0) {
      // Always include at least one file, even if it alone exceeds the budget:
      // reviewing one file fully beats reviewing nothing.
      included.push(chunk.text);
      used += cost;
    } else {
      omitted.push(chunk.path);
    }
  }

  const sections = [...header, '### Diff', ''];
  if (omitted.length > 0) {
    sections.push(
      `> Note: ${omitted.length} of ${chunks.length} files were omitted from the diff below`,
      '> because the change exceeds the review size budget. Their names and stats are',
      '> listed above. Do not assess them; call them out as unreviewed instead.',
      '>',
      ...omitted.map((p) => `> - ${p}`),
      '',
    );
  }
  sections.push(included.join('\n'), '');

  return {
    text: sections.join('\n'),
    includedFiles: included.length,
    omittedFiles: omitted,
    truncated: omitted.length > 0,
  };
}
