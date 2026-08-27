import { beforeEach, describe, expect, it, vi } from 'vitest';

const inputBoxMocks = vi.hoisted(() => ({
  showInputBox: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getJson: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: { showInputBox: inputBoxMocks.showInputBox },
}));

// verifyBitbucketCredentials builds its own throwaway BitbucketApi rather than
// reading the auth provider's stored credentials (which have not been stored
// yet at verification time). Mocking the client here, rather than letting it
// build a real one, is what keeps this test off the network.
vi.mock('../../src/extension/services/forge/bitbucket/bitbucket-api', () => ({
  BitbucketApi: class {
    getJson(...args: unknown[]) { return apiMocks.getJson(...args); }
  },
  bitbucketRepoPath: (repo: { owner: string; name: string }) => `/repositories/${repo.owner}/${repo.name}`,
}));

const { promptForBitbucketCredentials, verifyBitbucketCredentials } =
  await import('../../src/extension/services/forge/bitbucket/bitbucket-sign-in');

beforeEach(() => {
  inputBoxMocks.showInputBox.mockReset();
  apiMocks.getJson.mockReset();
});

describe('promptForBitbucketCredentials', () => {
  it('collects an email and a token, trimmed', async () => {
    inputBoxMocks.showInputBox
      .mockResolvedValueOnce('  tuyen@example.com  ')
      .mockResolvedValueOnce('  ATATT-secret  ');

    expect(await promptForBitbucketCredentials()).toEqual({
      email: 'tuyen@example.com', token: 'ATATT-secret',
    });
  });

  it('lists every required scope in the token prompt', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('a@b.com').mockResolvedValueOnce('t');
    await promptForBitbucketCredentials();

    const tokenPromptOptions = inputBoxMocks.showInputBox.mock.calls[1][0] as { prompt: string };
    expect(tokenPromptOptions.prompt).toContain('read:pullrequest:bitbucket');
    expect(tokenPromptOptions.prompt).toContain('write:pullrequest:bitbucket');
  });

  it('stops without asking for a token when the email step is cancelled (Escape)', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce(undefined);
    expect(await promptForBitbucketCredentials()).toBeUndefined();
    expect(inputBoxMocks.showInputBox).toHaveBeenCalledTimes(1);
  });

  // The email step is optional — a repository/project/workspace access token
  // has no Atlassian account, and so no email to give. Pressing Enter on a
  // blank box (a deliberate answer) must not be treated the same as Escape
  // (a cancel): it has to proceed to the token step.
  it('proceeds to the token step when the email is left blank', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('').mockResolvedValueOnce('access-token-value');
    expect(await promptForBitbucketCredentials()).toEqual({ email: '', token: 'access-token-value' });
    expect(inputBoxMocks.showInputBox).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when the token step is cancelled', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('a@b.com').mockResolvedValueOnce(undefined);
    expect(await promptForBitbucketCredentials()).toBeUndefined();
  });

  it('accepts a blank email and rejects an email with no @', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('a@b.com');
    await promptForBitbucketCredentials();
    const emailOptions = inputBoxMocks.showInputBox.mock.calls[0][0] as { validateInput(v: string): string | undefined };
    expect(emailOptions.validateInput('not-an-email')).toBeTypeOf('string');
    expect(emailOptions.validateInput('a@b.com')).toBeUndefined();
    expect(emailOptions.validateInput('')).toBeUndefined();
  });
});

describe('verifyBitbucketCredentials', () => {
  const credentials = { email: 'tuyen@example.com', token: 'ATATT-secret' };
  const repo = { host: 'bitbucket.org', owner: 'tuyen', name: 'repo' };

  // The whole point of the fix: this must probe the repository, never
  // /2.0/user — nothing else in this extension reads user data, and that
  // single call was what forced a user-read scope into every sign-in prompt.
  it('probes the repository the user has open, not a user endpoint', async () => {
    apiMocks.getJson.mockResolvedValueOnce({ full_name: 'tuyen/repo', workspace: { name: 'Tuyen Workspace' } });
    expect(await verifyBitbucketCredentials(credentials, repo)).toBe('tuyen@example.com');
    expect(apiMocks.getJson).toHaveBeenCalledWith('/repositories/tuyen/repo');
  });

  it('falls back to the workspace name when there is no email to show', async () => {
    apiMocks.getJson.mockResolvedValueOnce({ full_name: 'tuyen/repo', workspace: { name: 'Tuyen Workspace' } });
    expect(await verifyBitbucketCredentials({ email: '', token: 't' }, repo)).toBe('Tuyen Workspace');
  });

  it('falls back to the repository full name when there is no workspace name either', async () => {
    apiMocks.getJson.mockResolvedValueOnce({ full_name: 'tuyen/repo' });
    expect(await verifyBitbucketCredentials({ email: '', token: 't' }, repo)).toBe('tuyen/repo');
  });

  it('falls back to the repository owner as a last, always-honest resort', async () => {
    apiMocks.getJson.mockResolvedValueOnce({});
    expect(await verifyBitbucketCredentials({ email: '', token: 't' }, repo)).toBe('tuyen');
  });

  // A mistyped or under-scoped token must fail where it was typed, not on
  // the first pull request request — this is what makes that possible.
  it('propagates a rejection', async () => {
    apiMocks.getJson.mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(verifyBitbucketCredentials(credentials, repo)).rejects.toThrow('403');
  });
});
