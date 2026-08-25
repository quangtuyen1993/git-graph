export type RefType = 'head' | 'branch' | 'tag' | 'remote';

const KNOWN_REMOTE_PREFIXES = ['origin/', 'upstream/'];
// Only a leading HEAD is the checked-out HEAD: git also decorates rows with
// `origin/HEAD -> origin/main`, and treating that as HEAD handed it the
// leftmost, truncation-protected chip slot that belongs to the real one.
const LEADING_HEAD = /^HEAD(\s|$)/;

export function refType(ref: string): RefType {
  if (LEADING_HEAD.test(ref)) return 'head';
  if (ref.startsWith('tag:')) return 'tag';
  if (KNOWN_REMOTE_PREFIXES.some((prefix) => ref.startsWith(prefix))) return 'remote';
  return 'branch';
}

export function refDisplayName(ref: string): string {
  return ref.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
}

// Chips are right-aligned and truncate from the right, so the refs a reader
// needs most must come first: where HEAD is, then local branches, then tags,
// then remotes, which are the most guessable from context.
const ORDER: Record<RefType, number> = { head: 0, branch: 1, tag: 2, remote: 3 };

export function sortRefsForRow(refs: string[]): string[] {
  return refs
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => (ORDER[refType(a.ref)] - ORDER[refType(b.ref)]) || (a.index - b.index))
    .map((entry) => entry.ref);
}
