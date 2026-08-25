export type SearchQueryKind = 'empty' | 'hash' | 'text';

const HASH_SHAPED = /^[0-9a-f]{7,40}$/i;

export function classifyQuery(query: string): SearchQueryKind {
  const trimmed = query.trim();
  if (trimmed === '') return 'empty';
  return HASH_SHAPED.test(trimmed) ? 'hash' : 'text';
}

export function nextMatchIndex(total: number, activeIndex: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  return (activeIndex + direction + total) % total;
}

export function formatMatchCounter(total: number, activeIndex: number): string {
  if (total <= 0) return '';
  return `${activeIndex + 1}/${total}`;
}
