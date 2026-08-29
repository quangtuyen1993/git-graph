import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: hoisted.spawn }));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

import { createReviewHandler } from '../../src/extension/controllers/review-method-handler';
import { AIReviewService } from '../../src/extension/services/ai-review.service';
import { buildReviewId, isSafeReviewId } from '../../src/extension/services/review-key';
import {
  buildReviewPayload,
  REVIEW_INSTRUCTIONS,
  type ReviewFileSummary,
} from '../../src/extension/services/review-payload';
import { ReviewRunner } from '../../src/extension/services/review-runner';
import { ReviewTargetState } from '../../src/extension/services/review-target';
import type { Commit } from '../../src/extension/types/git.types';

/**
 * The exact payload the released version produces for `sample`, recorded from
 * the implementation as it stood before `outputLanguage` existed. Requirement
 * 2 is "empty means do not ask": a user who never sets the setting must get a
 * byte-identical prompt, not a nearly-identical one. A hash of the whole text
 * is the only assertion that actually says "byte-identical" — a `toContain`
 * would pass while a stray blank line was added.
 */
const GOLDEN_SHA256 = '593a756edfa3363ace6cd0f496a1fc3ca50cde55b10595c39f76a6641a263951';
const GOLDEN_LENGTH = 1533;

const summary = (path: string, over: Partial<ReviewFileSummary> = {}): ReviewFileSummary => ({
  path, oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false, ...over,
});

const sample = {
  baseBranch: 'main',
  headBranch: 'feature',
  diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+one\n',
  files: [summary('src/a.ts')],
  commits: ['first commit'],
  priorDiscussion: [{ author: 'Ana', body: 'looks fine' }],
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

describe('buildReviewPayload with no output language set', () => {
  it('is byte-identical to the payload the previous version produced', () => {
    // The golden hash was captured from the implementation before this feature
    // landed. If this fails, the default prompt changed and every user who
    // never touched the setting is now getting a different prompt.
    const payload = buildReviewPayload(sample);
    expect(payload.text.length).toBe(GOLDEN_LENGTH);
    expect(sha(payload.text)).toBe(GOLDEN_SHA256);
  });

  it('treats undefined, empty and whitespace-only alike — none of them spends an instruction', () => {
    const baseline = buildReviewPayload(sample).text;
    for (const outputLanguage of [undefined, '', '   ', '\n\t ']) {
      expect(sha(buildReviewPayload({ ...sample, outputLanguage }).text)).toBe(sha(baseline));
    }
  });
});

describe('buildReviewPayload with an output language set', () => {
  it('names the language in the prompt', () => {
    const payload = buildReviewPayload({ ...sample, outputLanguage: 'Tiếng Việt' });
    expect(payload.text).toContain('Tiếng Việt');
  });

  it('carries the instruction exactly once', () => {
    // Acceptance 2: added once, in the assembly layer. Twice would be a sign
    // the instruction leaked into a per-provider prompt as well.
    const payload = buildReviewPayload({ ...sample, outputLanguage: 'French' });
    expect(occurrences(payload.text, 'French')).toBe(1);
  });

  it('puts the instruction in the instruction block, ahead of the change context', () => {
    const payload = buildReviewPayload({ ...sample, outputLanguage: 'German' });
    const languageAt = payload.text.indexOf('German');
    const contextAt = payload.text.indexOf('## Change under review');
    const instructionsAt = payload.text.indexOf(REVIEW_INSTRUCTIONS);
    expect(instructionsAt).toBeGreaterThanOrEqual(0);
    expect(languageAt).toBeGreaterThan(instructionsAt);
    expect(languageAt).toBeLessThan(contextAt);
  });

  it('leaves the standing review instructions untouched', () => {
    // Requirement 4: the language changes the prose, not the shape. The
    // section list and the verdict keywords are the closest thing this output
    // has to structure, so the block that defines them must survive verbatim.
    const payload = buildReviewPayload({ ...sample, outputLanguage: 'Japanese' });
    expect(payload.text).toContain(REVIEW_INSTRUCTIONS);
  });

  it('tells the model to keep the verdict keywords and severity labels as they are', () => {
    // Nothing parses the body today, but APPROVE / REQUEST_CHANGES / COMMENT
    // and Critical / Important / Minor are the tokens a reader and any future
    // parser key on. Translating them is the failure mode worth naming.
    const payload = buildReviewPayload({ ...sample, outputLanguage: 'Spanish' });
    const tail = payload.text.slice(payload.text.indexOf('Spanish'));
    const sentence = tail.slice(0, tail.indexOf('## Change under review'));
    expect(sentence).toContain('APPROVE');
    expect(sentence).toContain('Critical');
  });

  it('does not touch the diff, the file list or the commit subjects', () => {
    const plain = buildReviewPayload(sample);
    const translated = buildReviewPayload({ ...sample, outputLanguage: 'Italian' });
    expect(translated.text.slice(translated.text.indexOf('## Change under review')))
      .toBe(plain.text.slice(plain.text.indexOf('## Change under review')));
    expect(translated.includedFiles).toBe(plain.includedFiles);
    expect(translated.omittedFiles).toEqual(plain.omittedFiles);
    expect(translated.truncated).toBe(plain.truncated);
  });
});

describe('buildReviewId and the output language', () => {
  const shas = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };

  it('keeps every existing kind byte-for-byte unchanged when no language is set', () => {
    // The constraint that has bitten this repository before: a changed id
    // orphans every review already on disk.
    for (const outputLanguage of [undefined, '', '  ']) {
      expect(buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet', outputLanguage }))
        .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
      expect(buildReviewId({ ...shas, kind: 'commit', provider: 'claude', model: 'sonnet', outputLanguage }))
        .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
      expect(buildReviewId({ ...shas, kind: 'range', provider: 'claude', model: 'sonnet', outputLanguage }))
        .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
      expect(buildReviewId({ ...shas, kind: 'pr', provider: 'claude', model: 'sonnet', outputLanguage }))
        .toBe('aaaaaaa..bbbbbbb.pr.claude.sonnet');
      expect(buildReviewId({ ...shas, kind: 'worktree', provider: 'claude', model: 'sonnet', outputLanguage }))
        .toBe('aaaaaaa..bbbbbbb.worktree.claude.sonnet');
    }
  });

  it('gives a language its own id, distinct from the unset one', () => {
    const plain = buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet' });
    const vi = buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet', outputLanguage: 'Tiếng Việt' });
    expect(vi).not.toBe(plain);
    expect(vi.startsWith(plain)).toBe(true);
  });

  it('gives two different languages two different ids', () => {
    const a = buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet', outputLanguage: 'French' });
    const b = buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet', outputLanguage: 'German' });
    expect(a).not.toBe(b);
  });

  it('treats casing and surrounding whitespace as the same language', () => {
    const canonical = buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet', outputLanguage: 'French' });
    for (const variant of ['french', '  French  ', 'FRENCH']) {
      expect(buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet', outputLanguage: variant }))
        .toBe(canonical);
    }
  });

  it('stays a safe, short filename for any free text a user can type', () => {
    // The setting is free text: a pasted paragraph, a non-Latin script, or a
    // path-shaped string must not produce an id that escapes the store or
    // blows the 200-character cap.
    for (const language of ['Tiếng Việt', '../../etc/passwd', 'x'.repeat(4000), '日本語 (丁寧語)']) {
      const id = buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet', outputLanguage: language });
      expect(isSafeReviewId(id)).toBe(true);
    }
  });
});

function harness(over: Record<string, unknown> = {}) {
  const store = {
    list: vi.fn(async () => []),
    // Typed with both parameters because the cache tests below replace this
    // with an implementation that answers for one id and not another.
    get: vi.fn(async (_repoId: string, _id: string): Promise<unknown> => undefined),
    remove: vi.fn(async () => {}),
    bodyPath: vi.fn(() => '/tmp/body.md'),
    readBody: vi.fn(async () => 'the stored review, in the language it was written in'),
  };
  const runner = {
    start: vi.fn(async (_input: Record<string, unknown>) => 'new-id'),
    cancel: vi.fn(() => true),
    isRunning: vi.fn(() => false),
  };
  const git = {
    revParse: vi.fn(async (ref: string) => (ref === 'main' ? 'a'.repeat(40) : 'b'.repeat(40))),
    getDiff: vi.fn(async () => 'diff --git a/x b/x\n+one\n'),
    diff: vi.fn(async () => ({ files: [] })),
    log: vi.fn(async (): Promise<Commit[]> => []),
    getParents: vi.fn(async () => ['c'.repeat(40)]),
    commitExists: vi.fn(async () => true),
    getWorkingTreeDiff: vi.fn(async () => 'diff --git a/x b/x\n+one\n'),
    diffWorkingTree: vi.fn(async () => ({ files: [] })),
  };
  const getOutputLanguage = vi.fn(() => '');
  const openBody = vi.fn(async () => {});
  const handler = createReviewHandler({
    store: store as never,
    runner: runner as never,
    getGitService: () => git as never,
    getRepoId: () => 'repo-a',
    getRepos: () => [{ path: '/repo/a', name: 'repo-a', active: true }],
    getMaxDiffChars: () => 0,
    getOutputLanguage,
    openBody,
    targets: new ReviewTargetState(),
    focusReviewView: vi.fn(async () => {}),
    broadcast: vi.fn(),
    forge: {} as never,
    ...over,
  });
  return { handler, store, runner, git, getOutputLanguage, openBody };
}

const startBranch = { kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: 'sonnet' };

describe('review.start and the output language', () => {
  it('reads the setting and puts the instruction in the payload it hands the runner', () => {
    // This is what makes the setting live rather than declared-and-ignored,
    // the way defaultProvider and defaultModel currently are.
    const { handler, runner, getOutputLanguage } = harness();
    getOutputLanguage.mockReturnValue('Tiếng Việt');

    return handler('review.start', { ...startBranch }).then(() => {
      expect(getOutputLanguage).toHaveBeenCalled();
      const payloadText = runner.start.mock.calls[0][0].payloadText as string;
      expect(payloadText).toContain('Tiếng Việt');
      expect(occurrences(payloadText, 'Tiếng Việt')).toBe(1);
    });
  });

  it('sends the unchanged payload when the setting is empty', async () => {
    const { handler, runner, getOutputLanguage } = harness();
    getOutputLanguage.mockReturnValue('');

    await handler('review.start', { ...startBranch });

    const payloadText = runner.start.mock.calls[0][0].payloadText as string;
    expect(payloadText.startsWith(REVIEW_INSTRUCTIONS)).toBe(true);
    // Nothing at all between the standing instructions and the change context
    // — no blank line, no empty section left behind by the conditional.
    expect(payloadText.slice(0, REVIEW_INSTRUCTIONS.length + '\n\n---\n\n'.length))
      .toBe(`${REVIEW_INSTRUCTIONS}\n\n---\n\n`);
  });

  it('does not serve a review written in another language from the cache', async () => {
    // THE NAMED TRAP. review.start serves a cached review on target, provider
    // and model. The language is none of those, so without the language in
    // the id the user changes the setting, re-runs, and silently gets the old
    // review in the old language with nothing saying why. The ruling: the
    // language participates in the id, so a new language is a cache miss.
    const { handler, runner, store, getOutputLanguage } = harness();
    getOutputLanguage.mockReturnValue('Tiếng Việt');
    // Everything already on disk was written with no language set.
    const oldId = buildReviewId({
      kind: 'branch', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude', model: 'sonnet',
    });
    store.get.mockImplementation(async (_repo: string, id: string) =>
      (id === oldId ? { id: oldId, status: 'done' } : undefined));

    const result = await handler('review.start', { ...startBranch });

    expect(result).toMatchObject({ cached: false });
    expect(runner.start).toHaveBeenCalledOnce();
  });

  it('still serves the cache when the language has not changed', async () => {
    // The other half of the ruling: keying on the language must not defeat
    // caching outright, or every re-run pays for a fresh review.
    const { handler, runner, store, getOutputLanguage } = harness();
    getOutputLanguage.mockReturnValue('Tiếng Việt');
    const id = buildReviewId({
      kind: 'branch', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      provider: 'claude', model: 'sonnet', outputLanguage: 'Tiếng Việt',
    });
    store.get.mockImplementation(async (_repo: string, wanted: string) =>
      (wanted === id ? { id, status: 'done' } : undefined));

    const result = await handler('review.start', { ...startBranch });

    expect(result).toEqual({ id, cached: true });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('serves a review still stored under the language-free id when the setting is empty', async () => {
    // Constraint: reviews saved by the current version must keep loading.
    const { handler, runner, store, getOutputLanguage } = harness();
    getOutputLanguage.mockReturnValue('');
    const oldId = 'aaaaaaa..bbbbbbb.claude.sonnet';
    store.get.mockImplementation(async (_repo: string, wanted: string) =>
      (wanted === oldId ? { id: oldId, status: 'done' } : undefined));

    expect(await handler('review.start', { ...startBranch })).toEqual({ id: oldId, cached: true });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('gives the runner the same language it built the id from', async () => {
    // ReviewRunner recomputes the id from its own input. If the language does
    // not travel with it, the handler looks up one id and the store writes
    // another: no run is ever a cache hit and two languages overwrite each
    // other's body.
    const { handler, runner, getOutputLanguage } = harness();
    getOutputLanguage.mockReturnValue('Tiếng Việt');

    await handler('review.start', { ...startBranch });

    expect(runner.start.mock.calls[0][0].outputLanguage).toBe('Tiếng Việt');
  });
});

describe('ReviewRunner stores each language under its own id', () => {
  /**
   * The handler's id and the runner's id are computed independently from the
   * same inputs. This is the half a handler-level test cannot reach: give the
   * runner a language and it must land on the same id `buildReviewId` gave the
   * caller, or the caller looks one entry up while the runner writes another
   * — no run is ever a cache hit, and two languages overwrite each other.
   */
  function runnerHarness() {
    const created: Array<{ id: string }> = [];
    const store = {
      create: vi.fn(async (_repoId: string, entry: { id: string }) => { created.push(entry); }),
      update: vi.fn(async () => {}),
      appendBody: vi.fn(async () => {}),
      writeBody: vi.fn(async () => {}),
      readBody: vi.fn(async () => ''),
    };
    const service = { review: vi.fn(async () => ({ content: 'review body' })) };
    const runner = new ReviewRunner(store as never, service as never, () => {});
    return { runner, created };
  }

  const runnerInput = {
    repoId: 'repo-a', kind: 'branch' as const,
    baseRef: 'main', baseSha: 'a'.repeat(40),
    headRef: 'feat/x', headSha: 'b'.repeat(40),
    provider: 'claude', model: 'sonnet', payloadText: 'payload',
  };

  it('writes the entry under the language-keyed id the caller computed', async () => {
    const { runner, created } = runnerHarness();

    const id = await runner.start({ ...runnerInput, outputLanguage: 'Tiếng Việt' });

    expect(id).toBe(buildReviewId({ ...runnerInput, outputLanguage: 'Tiếng Việt' }));
    expect(created[0].id).toBe(id);
  });

  it('keeps two languages apart instead of overwriting one with the other', async () => {
    const { runner, created } = runnerHarness();

    await runner.start({ ...runnerInput, outputLanguage: 'French' });
    await runner.start({ ...runnerInput, outputLanguage: 'German' });

    expect(created).toHaveLength(2);
    expect(created[0].id).not.toBe(created[1].id);
  });

  it('writes the unchanged id when no language is set', async () => {
    const { runner, created } = runnerHarness();

    await runner.start({ ...runnerInput });

    expect(created[0].id).toBe('aaaaaaa..bbbbbbb.claude.sonnet');
  });
});

describe('a stored review keeps the language it was written in', () => {
  it('never consults the setting when reading a stored body', async () => {
    // Requirement 5: changing the setting does not retranslate history.
    const { handler, store, getOutputLanguage } = harness();
    getOutputLanguage.mockReturnValue('Tiếng Việt');

    const body = await handler('review.body', { id: 'aaaaaaa..bbbbbbb.claude.sonnet' });

    expect(store.readBody).toHaveBeenCalled();
    expect(getOutputLanguage).not.toHaveBeenCalled();
    expect(body).toBe('the stored review, in the language it was written in');
  });

  it('never consults the setting when opening a stored review', async () => {
    const { handler, openBody, getOutputLanguage } = harness();
    getOutputLanguage.mockReturnValue('Tiếng Việt');

    await handler('review.open', { id: 'aaaaaaa..bbbbbbb.claude.sonnet' });

    expect(openBody).toHaveBeenCalled();
    expect(getOutputLanguage).not.toHaveBeenCalled();
  });
});

describe('the provider layer adds no second instruction', () => {
  beforeEach(() => hoisted.spawn.mockReset());

  it('sends an assembled payload to the CLI verbatim, so the language is asked for once', async () => {
    // Acceptance 3. Every adapter shares AIReviewService.review(); a payload
    // that arrives assembled is passed through untouched and the service's own
    // DEFAULT_PROMPT is never prepended.
    const payload = buildReviewPayload({ ...sample, outputLanguage: 'Tiếng Việt' });
    let sent = '';
    hoisted.spawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown> & {
        stdout: EventEmitter; stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: (chunk: string) => { sent += chunk; }, end: () => {} };
      proc.pid = 999999;
      proc.exitCode = null;
      proc.signalCode = null;
      proc.kill = vi.fn();
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from('review body'));
        proc.emit('close', 0);
      });
      return proc;
    });

    await new AIReviewService().review({
      diff: sample.diff, provider: 'claude', model: 'sonnet', payloadText: payload.text,
    } as never);

    const args = hoisted.spawn.mock.calls[0][1] as string[];
    const full = `${sent}${args.join('\n')}`;
    expect(occurrences(full, 'Tiếng Việt')).toBe(1);
    expect(full).not.toContain('Be concise and actionable');
  });
});

describe('the setting is declared and actually read', () => {
  const root = join(__dirname, '..', '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const properties = pkg.contributes.configuration.properties as Record<string, {
    type: string; default: unknown; description?: string;
  }>;

  it('declares gitGraphPro.aiReview.outputLanguage as free text, empty by default', () => {
    const setting = properties['gitGraphPro.aiReview.outputLanguage'];
    expect(setting).toBeDefined();
    expect(setting.type).toBe('string');
    expect(setting.default).toBe('');
    // Free text rather than an enum, so a language we did not think of is not
    // locked out — an `enum` here would be the defect.
    expect(setting).not.toHaveProperty('enum');
  });

  it('says in its description that each language gets its own stored review', () => {
    // The other half of the named-trap ruling: the behaviour is in the code,
    // and the reason the user sees a second entry appear is in the text.
    const description = String(properties['gitGraphPro.aiReview.outputLanguage'].description ?? '');
    expect(description.length).toBeGreaterThan(0);
    expect(description.toLowerCase()).toContain('separate');
  });

  it('is read from the gitGraphPro.aiReview configuration by the extension host', () => {
    // gitGraphPro.aiReview.defaultProvider and .defaultModel are declared here
    // and read by nothing. This test is what stops outputLanguage becoming a
    // third one: it fails if the host stops reading the key.
    const source = readFileSync(join(root, 'src', 'extension', 'extension.ts'), 'utf8');
    expect(source).toContain("getConfiguration('gitGraphPro.aiReview')");
    expect(source).toContain("'outputLanguage'");
    expect(source).toContain('getOutputLanguage');
  });
});
