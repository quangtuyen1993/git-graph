import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import ReviewList from '../../src/webview/components/sidebar/ReviewList.svelte';

const review = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  kind: 'branch',
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  headRef: 'feature/x',
  headSha: 'b'.repeat(40),
  provider: 'claude',
  model: 'sonnet',
  status: 'done',
  startedAt: '2026-08-25T09:00:00Z',
  finishedAt: '2026-08-25T09:05:00Z',
  ...overrides,
});

describe('ReviewList', () => {
  afterEach(cleanup);

  it('renders the target label, provider/model and a relative time', () => {
    render(ReviewList, { reviews: [review()], query: '' });

    expect(screen.getByText('main ← feature/x')).toBeInTheDocument();
    expect(screen.getByText(/claude/)).toBeInTheDocument();
    expect(screen.getByText(/sonnet/)).toBeInTheDocument();
    expect(screen.getByText(/ago|just now/i)).toBeInTheDocument();
  });

  it('labels a done row so it reads as done, not as neither-passed-nor-failed', () => {
    render(ReviewList, { reviews: [review({ status: 'done' })], query: '' });
    expect(screen.getByLabelText('Done')).toBeInTheDocument();
  });

  // Acceptance #3: a running entry renders as running.
  it('renders a running entry as running', () => {
    render(ReviewList, { reviews: [review({ status: 'running', finishedAt: undefined })], query: '' });
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
  });

  // Acceptance #2 / Named trap: the failed reason is reachable from the row
  // itself, and the glyph carries an aria-label since colour and shape alone
  // don't reach a screen reader.
  it("surfaces a failed review's reason on the row, without opening the body", () => {
    render(ReviewList, {
      reviews: [review({ status: 'failed', error: 'Diff exceeded the provider budget' })],
      query: '',
    });

    expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Diff exceeded the provider budget')).toBeInTheDocument();
  });

  it('renders no error text for a row that has none', () => {
    render(ReviewList, { reviews: [review({ status: 'done' })], query: '' });
    expect(screen.queryByText(/exceeded/i)).not.toBeInTheDocument();
  });

  it.each([
    ['cancelled', 'Cancelled'],
    ['interrupted', 'Interrupted'],
  ] as const)('labels a %s row as %s', (status, label) => {
    render(ReviewList, { reviews: [review({ status })], query: '' });
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  // Acceptance #5.
  it('emits select with the review id when a row is clicked', async () => {
    const { component } = render(ReviewList, { reviews: [review()], query: '' });
    let selected = '';
    component.$on('select', (event) => { selected = (event as CustomEvent<{ id: string }>).detail.id; });

    await fireEvent.click(screen.getByRole('button', { name: /main ← feature\/x/ }));

    expect(selected).toBe('r1');
  });

  // Acceptance #4, filtering on the same label the row renders.
  it.each([
    ['main', 1],
    ['feature/x', 1],
    ['nothing', 0],
  ])('filters on %j', (query, expected) => {
    render(ReviewList, { reviews: [review()], query });
    expect(screen.queryAllByText('main ← feature/x')).toHaveLength(expected);
  });

  it('says so when there are no reviews', () => {
    render(ReviewList, { reviews: [], query: '' });
    expect(screen.getByText(/no reviews/i)).toBeInTheDocument();
  });

  it('says nothing matches, distinct from empty, once a query is active', () => {
    render(ReviewList, { reviews: [review()], query: 'nothing' });
    expect(screen.getByText(/no matching reviews/i)).toBeInTheDocument();
  });

  // Acceptance #6: a stored `pr` review must list and (elsewhere) open with
  // no forge provider registered — this component has no forge props at
  // all, so it can only ever read the entry's own stored fields.
  it('renders and selects a pr review using only its stored fields, no forge lookup', async () => {
    const prReview = review({
      kind: 'pr', baseRef: '', headRef: '', prId: 'pr-9', prNumber: 9,
      providerId: 'bitbucket-gone', subject: 'Fix the thing',
    });
    const { component } = render(ReviewList, { reviews: [prReview], query: '' });
    let selected = '';
    component.$on('select', (event) => { selected = (event as CustomEvent<{ id: string }>).detail.id; });

    const row = screen.getByText('PR #9 Fix the thing');
    expect(row).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /PR #9 Fix the thing/ }));

    expect(selected).toBe('r1');
  });
});
