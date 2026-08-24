import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Icon from '../../src/webview/components/common/Icon.svelte';
import { iconNames, iconPaths } from '../../src/webview/lib/icons';

describe('Icon', () => {
  afterEach(cleanup);

  it('renders the named glyph at the requested size', () => {
    const { container } = render(Icon, { name: 'chevron-right', size: 20 });
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveAttribute('height', '20');
    expect(svg).toHaveAttribute('viewBox', '0 0 16 16');
    expect(svg?.querySelector('path')).toHaveAttribute('d', iconPaths['chevron-right']);
  });

  it('defaults to a 16px glyph tinted by the surrounding text colour', () => {
    const { container } = render(Icon, { name: 'tag' });
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('fill', 'currentColor');
  });

  it('hides decorative glyphs from assistive technology', () => {
    const { container } = render(Icon, { name: 'tag' });

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('gives every declared icon a drawable path', () => {
    expect(iconNames.length).toBeGreaterThan(0);
    for (const name of iconNames) {
      expect(iconPaths[name], name).toMatch(/^[Mm]/);
    }
  });
});
