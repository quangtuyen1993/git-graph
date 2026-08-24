import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Combobox from '../../src/webview/components/Combobox.svelte';

afterEach(cleanup);

const items = [
  { label: 'main', value: 'main' },
  { label: 'feat/login', value: 'feat/login' },
  { label: 'fix/bug-42', value: 'fix/bug-42' },
];

describe('Combobox', () => {
  it('shows dropdown on focus with all items', async () => {
    const { getByRole, getAllByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    const options = getAllByRole('option');
    expect(options).toHaveLength(3);
  });

  it('filters items as user types', async () => {
    const { getByRole, getAllByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'feat' } });
    const options = getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('feat/login');
  });

  it('selects item on click and closes dropdown', async () => {
    const { getByRole, getAllByRole, queryAllByRole, component } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const selected: string[] = [];
    component.$on('select', (e: CustomEvent) => selected.push(e.detail.value));
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    const options = getAllByRole('option');
    await fireEvent.click(options[1]);
    expect(selected).toEqual(['feat/login']);
    expect(queryAllByRole('option')).toHaveLength(0);
  });

  it('navigates with arrow keys and selects with Enter', async () => {
    const { getByRole, component } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const selected: string[] = [];
    component.$on('select', (e: CustomEvent) => selected.push(e.detail.value));
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(selected).toEqual(['feat/login']);
  });

  it('closes dropdown on Escape', async () => {
    const { getByRole, queryAllByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox');
    await fireEvent.focus(input);
    expect(queryAllByRole('option').length).toBeGreaterThan(0);
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(queryAllByRole('option')).toHaveLength(0);
  });

  it('allows free text entry without selecting from list', async () => {
    const { getByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox') as HTMLInputElement;
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'abc1234' } });
    await fireEvent.blur(input);
    expect(input.value).toBe('abc1234');
  });

  it('sets aria-expanded and aria-activedescendant correctly', async () => {
    const { getByRole } = render(Combobox, { props: { items, value: '', placeholder: 'branch…', 'aria-label': 'Branch' } });
    const input = getByRole('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.focus(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
  });
});
