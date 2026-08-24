export interface CompareDiffParams {
  path: string;
  oldPath?: string | null;
  sourceBranch: string; // wire name giữ nguyên — webview gửi sourceBranch/targetBranch
  targetBranch: string;
  status?: string;
}

export interface CompareDiffDeps {
  git: {
    showFile(ref: string, path: string): Promise<string | null>;
    branches(): Promise<{ name: string; current?: boolean }[]>;
    getRepoPath(): string;
  };
  setContent(uriKey: string, content: string): void;
  virtualUri(path: string, query: string): { toString(): string };
  fileUri(repoPath: string, path: string): unknown;
  executeDiff(left: unknown, right: unknown, title: string): Promise<void>;
  nextTag(): string; // "ts=..&session=..&request=.." — caller sở hữu counter
}

export async function openCompareDiff(deps: CompareDiffDeps, params: CompareDiffParams): Promise<{ success: true }> {
  const { path: filePath, oldPath, sourceBranch: baseBranch, targetBranch: headBranch } = params;
  const status = params.status ?? 'modified';
  const tag = deps.nextTag();

  const baseContent = status !== 'added'
    ? await deps.git.showFile(baseBranch, oldPath ?? filePath) ?? ''
    : '';
  const baseUri = deps.virtualUri(oldPath ?? filePath, `ref=${baseBranch}&${tag}&side=base`);
  deps.setContent(baseUri.toString(), baseContent);

  const branchList = await deps.git.branches();
  const currentBranch = branchList.find(branch => branch.current)?.name;
  const headIsCheckedOut = !!currentBranch && currentBranch === headBranch;
  let headUri: unknown;
  if (headIsCheckedOut && status !== 'deleted') {
    headUri = deps.fileUri(deps.git.getRepoPath(), filePath);
  } else {
    const headContent = status !== 'deleted'
      ? await deps.git.showFile(headBranch, filePath) ?? ''
      : '';
    const virtualHead = deps.virtualUri(filePath, `ref=${headBranch}&${tag}&side=head`);
    deps.setContent(virtualHead.toString(), headContent);
    headUri = virtualHead;
  }

  const fileName = filePath.split('/').pop() ?? filePath;
  let title: string;
  if (status === 'added') title = `${fileName} (added in ${headBranch})`;
  else if (status === 'deleted') title = `${fileName} (deleted in ${headBranch})`;
  else title = `${fileName} (${baseBranch} → ${headBranch})`;

  await deps.executeDiff(baseUri, headUri, title);
  return { success: true };
}
