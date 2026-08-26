import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import FileTreeList from '../../src/webview/components/detail/FileTreeList.svelte';
import { buildPathTree } from '../../src/webview/lib/path-tree';

const files = [
  { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false },
];
const nodes = buildPathTree(files, (f) => f.path);

afterEach(cleanup);

describe('FileTreeList', () => {
  it('dispatches openFile when a file row is clicked', async () => {
    const { component, getByText } = render(FileTreeList, { nodes });
    let opened: unknown;
    component.$on('openFile', (event) => { opened = event.detail; });

    await fireEvent.click(getByText('a.ts'));

    expect(opened).toEqual(files[0]);
  });

  // Finding from Task 2's review of the review panel's Pull Request mode:
  // a file row that looks clickable but does nothing is the same defect
  // class this project already fixed once for buttons that dispatched into
  // nothing. `disabled` closes it at the component, not at every call site.
  it('renders file rows as disabled and inert when disabled is set', async () => {
    const { component, getByText } = render(FileTreeList, { nodes, disabled: true });
    let opened: unknown;
    component.$on('openFile', () => { opened = 'fired'; });

    const row = getByText('a.ts').closest('button')!;
    expect(row).toBeDisabled();

    await fireEvent.click(row);
    expect(opened).toBeUndefined();
  });
});
