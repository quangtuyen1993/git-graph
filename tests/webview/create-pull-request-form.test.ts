import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import CreatePullRequestForm from '../../src/webview/components/detail/CreatePullRequestForm.svelte';

const reviewerSuggestions = [
  { displayName: 'Minh Le', accountId: 'm' },
  { displayName: 'Hoa Pham', accountId: 'h' },
];

const props = {
  sourceBranch: 'feature/RMS-1027',
  initialTitle: 'fix(auth): refresh token race',
  targetBranchOptions: ['develop', 'main'],
  defaultTargetBranch: 'develop',
  reviewerSuggestions,
};

describe('CreatePullRequestForm', () => {
  afterEach(cleanup);

  it('renders the source branch and defaults the title and target branch', () => {
    render(CreatePullRequestForm, props);
    expect(screen.getByText('feature/RMS-1027')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Title')).toHaveValue('fix(auth): refresh token race');
    expect(screen.getByRole('combobox', { name: 'Target branch' })).toHaveValue('develop');
  });

  // The suggestions must read as suggestions, not a directory to pick a
  // reviewer from — the interface never promises completeness.
  it('labels reviewer candidates as suggestions', () => {
    render(CreatePullRequestForm, props);
    expect(screen.getByText(/suggested reviewers/i)).toBeInTheDocument();
    expect(screen.getByText('Minh Le')).toBeInTheDocument();
    expect(screen.getByText('Hoa Pham')).toBeInTheDocument();
  });

  it('says so when there are no reviewer suggestions', () => {
    render(CreatePullRequestForm, { ...props, reviewerSuggestions: [] });
    expect(screen.getByText(/no suggestions available/i)).toBeInTheDocument();
  });

  it('emits submit with the entered fields, trimmed title and selected reviewers', async () => {
    const { component } = render(CreatePullRequestForm, props);
    let detail: unknown;
    component.$on('submit', (event) => { detail = event.detail; });

    await fireEvent.input(screen.getByPlaceholderText('Title'), { target: { value: '  fixed title  ' } });
    await fireEvent.input(screen.getByPlaceholderText('Description (optional)'), { target: { value: 'body text' } });
    await fireEvent.click(screen.getByLabelText('Minh Le'));
    await fireEvent.click(screen.getByLabelText(/close source branch/i));
    await fireEvent.click(screen.getByRole('button', { name: /^create pull request$/i }));

    expect(detail).toEqual({
      title: 'fixed title',
      description: 'body text',
      targetBranch: 'develop',
      reviewers: ['m'],
      closeSourceBranch: true,
    });
  });

  it('disables submit and shows a field error when the title is blank', async () => {
    const { component } = render(CreatePullRequestForm, props);
    let fired = false;
    component.$on('submit', () => { fired = true; });

    await fireEvent.input(screen.getByPlaceholderText('Title'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: /^create pull request$/i })).toBeDisabled();
    expect(screen.getByText(/title is required/i)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /^create pull request$/i }));
    expect(fired).toBe(false);
  });

  it('disables submit when the target branch equals the source branch', async () => {
    render(CreatePullRequestForm, { ...props, defaultTargetBranch: 'feature/RMS-1027' });
    expect(screen.getByRole('button', { name: /^create pull request$/i })).toBeDisabled();
    expect(screen.getByText(/must differ from the source branch/i)).toBeInTheDocument();
  });

  it('emits cancel without emitting submit', async () => {
    const { component } = render(CreatePullRequestForm, props);
    let cancelled = false;
    let submitted = false;
    component.$on('cancel', () => { cancelled = true; });
    component.$on('submit', () => { submitted = true; });

    await fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(cancelled).toBe(true);
    expect(submitted).toBe(false);
  });

  // The whole reason this is a panel and not a chain of `ui.inputBox`
  // prompts: pressing Escape while filling the form must not lose anything.
  it('preserves entered values on Escape — nothing here reacts to it', async () => {
    render(CreatePullRequestForm, props);
    const titleInput = screen.getByPlaceholderText('Title');

    await fireEvent.input(titleInput, { target: { value: 'a title in progress' } });
    await fireEvent.keyDown(titleInput, { key: 'Escape' });

    expect(titleInput).toHaveValue('a title in progress');
  });

  it('shows submitting state and disables the buttons', () => {
    render(CreatePullRequestForm, { ...props, submitting: true });
    expect(screen.getByRole('button', { name: /creating…/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('renders a host error message verbatim', () => {
    render(CreatePullRequestForm, { ...props, errorMessage: 'Bitbucket refused the request: branch not found.' });
    expect(screen.getByText('Bitbucket refused the request: branch not found.')).toBeInTheDocument();
  });

  // Acceptance: a duplicate attempt names the existing pull request and
  // offers to open it.
  it('names the existing pull request and offers to open it on a duplicate', async () => {
    const { component } = render(CreatePullRequestForm, {
      ...props, duplicate: { id: '118', number: 118, title: 'Add widgets' },
    });
    let opened = false;
    component.$on('openDuplicate', () => { opened = true; });

    expect(screen.getByText(/pr #118/i)).toBeInTheDocument();
    expect(screen.getByText(/add widgets/i)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /open existing pull request/i }));
    expect(opened).toBe(true);
  });

  it('prefers the duplicate banner over a generic error message when both are set', () => {
    render(CreatePullRequestForm, {
      ...props,
      errorMessage: 'some other error',
      duplicate: { id: '118', number: 118, title: 'Add widgets' },
    });
    expect(screen.getByText(/pr #118/i)).toBeInTheDocument();
    expect(screen.queryByText('some other error')).not.toBeInTheDocument();
  });

  // Values typed before a duplicate/error response must survive it — the
  // component instance stays mounted; only the error props change.
  it('keeps typed values after an error prop arrives (simulating a failed submit)', async () => {
    const { rerender } = render(CreatePullRequestForm, props);
    const titleInput = screen.getByPlaceholderText('Title');
    await fireEvent.input(titleInput, { target: { value: 'keep me' } });

    await rerender({ ...props, errorMessage: 'Bitbucket is having a moment' });

    expect(screen.getByPlaceholderText('Title')).toHaveValue('keep me');
  });
});
