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

  it('stops without asking for a token when the email step is cancelled', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce(undefined);
    expect(await promptForBitbucketCredentials()).toBeUndefined();
    expect(inputBoxMocks.showInputBox).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the token step is cancelled', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('a@b.com').mockResolvedValueOnce(undefined);
    expect(await promptForBitbucketCredentials()).toBeUndefined();
  });

  it('rejects an email with no @', async () => {
    inputBoxMocks.showInputBox.mockResolvedValueOnce('a@b.com');
    await promptForBitbucketCredentials();
    const emailOptions = inputBoxMocks.showInputBox.mock.calls[0][0] as { validateInput(v: string): string | undefined };
    expect(emailOptions.validateInput('not-an-email')).toBeTypeOf('string');
    expect(emailOptions.validateInput('a@b.com')).toBeUndefined();
  });
});

describe('verifyBitbucketCredentials', () => {
  const credentials = { email: 'tuyen@example.com', token: 'ATATT-secret' };

  it('returns the display name from /user', async () => {
    apiMocks.getJson.mockResolvedValueOnce({ display_name: 'Tuyen Nguyen' });
    expect(await verifyBitbucketCredentials(credentials)).toBe('Tuyen Nguyen');
    expect(apiMocks.getJson).toHaveBeenCalledWith('/user');
  });

  it('falls back to the email when /user has no display name', async () => {
    apiMocks.getJson.mockResolvedValueOnce({});
    expect(await verifyBitbucketCredentials(credentials)).toBe('tuyen@example.com');
  });

  // A mistyped or under-scoped token must fail where it was typed, not on
  // the first pull request request — this is what makes that possible.
  it('propagates a rejection', async () => {
    apiMocks.getJson.mockRejectedValueOnce(new Error('401 Unauthorized'));
    await expect(verifyBitbucketCredentials(credentials)).rejects.toThrow('401');
  });
});
