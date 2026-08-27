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
  it('collects a token, trimmed, from a single input box', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('  ATATT-secret  ');

    expect(await promptForBitbucketCredentials()).toEqual({ token: 'ATATT-secret' });
    expect(inputBoxMocks.showInputBox).toHaveBeenCalledTimes(1);
  });

  it('lists every required scope in the token prompt', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('t');
    await promptForBitbucketCredentials();

    const tokenPromptOptions = inputBoxMocks.showInputBox.mock.calls[0][0] as { prompt: string };
    expect(tokenPromptOptions.prompt).toContain('read:pullrequest:bitbucket');
    expect(tokenPromptOptions.prompt).toContain('write:pullrequest:bitbucket');
  });

  it('returns undefined when the token step is cancelled', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce(undefined);
    expect(await promptForBitbucketCredentials()).toBeUndefined();
  });

  it('rejects a blank token in validateInput, and accepts a real one', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('a-real-token');
    await promptForBitbucketCredentials();

    const options = inputBoxMocks.showInputBox.mock.calls[0][0] as { validateInput(v: string): string | undefined };
    expect(options.validateInput('   ')).toBeTypeOf('string');
    expect(options.validateInput('')).toBeTypeOf('string');
    expect(options.validateInput('a-real-token')).toBeUndefined();
  });
});

describe('verifyBitbucketCredentials', () => {
  const credentials = { token: 'ATATT-secret' };
  const repo = { host: 'bitbucket.org', owner: 'tuyen', name: 'repo' };

  // The whole point of the fix: this must probe the repository, never
  // /2.0/user — nothing else in this extension reads user data, and that
  // single call was what forced a user-read scope into every sign-in prompt.
  it('probes the repository the user has open, not a user endpoint', async () => {
    apiMocks.getJson.mockResolvedValueOnce({ full_name: 'tuyen/repo', workspace: { name: 'Tuyen Workspace' } });
    expect(await verifyBitbucketCredentials(credentials, repo)).toBe('Tuyen Workspace');
    expect(apiMocks.getJson).toHaveBeenCalledWith('/repositories/tuyen/repo');
  });

  // A Bearer-only credential carries no email, so the workspace name is the
  // primary label, not a fallback to a second choice.
  it('labels the session with the repository workspace name', async () => {
    apiMocks.getJson.mockResolvedValueOnce({ full_name: 'tuyen/repo', workspace: { name: 'Tuyen Workspace' } });
    expect(await verifyBitbucketCredentials(credentials, repo)).toBe('Tuyen Workspace');
  });

  it('falls back to the repository full name when there is no workspace name', async () => {
    apiMocks.getJson.mockResolvedValueOnce({ full_name: 'tuyen/repo' });
    expect(await verifyBitbucketCredentials(credentials, repo)).toBe('tuyen/repo');
  });

  it('falls back to the repository owner as a last, always-honest resort', async () => {
    apiMocks.getJson.mockResolvedValueOnce({});
    expect(await verifyBitbucketCredentials(credentials, repo)).toBe('tuyen');
  });

  // A mistyped or under-scoped token must fail where it was typed, not on
  // the first pull request request — this is what makes that possible.
  it('propagates a rejection', async () => {
    apiMocks.getJson.mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(verifyBitbucketCredentials(credentials, repo)).rejects.toThrow('403');
  });
});
