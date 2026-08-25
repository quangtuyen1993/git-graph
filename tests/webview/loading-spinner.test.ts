import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import LoadingSpinner from '../../src/webview/components/common/LoadingSpinner.svelte';

afterEach(cleanup);

describe('LoadingSpinner', () => {
  it('announces itself as a busy status', () => {
    const { getByRole } = render(LoadingSpinner, { props: { label: 'Pushing to origin…' } });
    const status = getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Pushing to origin…');
  });

  it('defaults to the small size', () => {
    const { getByRole } = render(LoadingSpinner);
    expect(getByRole('status').className).toContain('spinner-sm');
  });

  it('accepts the medium size', () => {
    const { getByRole } = render(LoadingSpinner, { props: { size: 'md' } });
    expect(getByRole('status').className).toContain('spinner-md');
  });
});
