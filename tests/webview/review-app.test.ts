import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import ReviewApp from '../../src/webview/ReviewApp.svelte';

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

describe('ReviewApp skeleton', () => {
  it('mounts and reaches the host', async () => {
    send.mockResolvedValue([]);
    const { getByText } = render(ReviewApp);
    await waitFor(() => expect(getByText('ready')).toBeInTheDocument());
  });
});
