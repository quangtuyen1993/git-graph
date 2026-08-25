import { GitService } from '../services/git.service';
import type { GitLogOptions, SubmoduleListEntry } from '../types/git.types';

export async function handleGitMethod(
  gitService: GitService,
  method: string,
  params: unknown,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'git.log':
      return gitService.log(p as GitLogOptions);
    case 'git.searchCommits':
      return gitService.searchCommits(p.query as string);
    case 'git.branches':
      return gitService.branches();
    case 'git.tags':
      return gitService.tags();
    case 'git.status':
      return gitService.status();
    case 'git.submoduleList': {
      const submodules = await gitService.submoduleList();
      return submodules.map(({ name, path, head, state }): SubmoduleListEntry => ({
        name,
        path,
        head,
        state,
      }));
    }
    case 'git.show':
      return gitService.show(p.hash as string);
    case 'git.diff':
      return gitService.diff(p.ref1 as string, p.ref2 as string);
    case 'git.checkout':
      await gitService.checkout(p.ref as string);
      return { success: true };
    case 'git.createBranch':
      await gitService.createBranch(p.name as string, p.startPoint as string | undefined);
      return { success: true };
    case 'git.deleteBranch':
      await gitService.deleteBranch(p.name as string, p.force as boolean | undefined);
      return { success: true };
    case 'git.renameBranch':
      await gitService.renameBranch(p.oldName as string, p.newName as string);
      return { success: true };
    case 'git.merge':
      await gitService.merge(p.branch as string, p.options as { noFF?: boolean; message?: string } | undefined);
      return { success: true };
    case 'git.rebase':
      await gitService.rebase(p.onto as string);
      return { success: true };
    case 'git.cherryPick':
      await gitService.cherryPick(p.hash as string);
      return { success: true };
    case 'git.revert':
      await gitService.revert(p.hash as string);
      return { success: true };
    case 'git.stash':
      return gitService.stash(
        p.action as 'push' | 'pop' | 'drop' | 'list',
        p.options as { message?: string; index?: number } | undefined,
      );
    case 'git.stashList':
      return gitService.stashList();
    case 'git.stashApply':
      await gitService.stashApply(p.index as number | undefined);
      return { success: true };
    case 'git.stashPop':
      await gitService.stash('pop', { index: p.index as number | undefined });
      return { success: true };
    case 'git.stashDrop':
      await gitService.stash('drop', { index: p.index as number | undefined });
      return { success: true };
    case 'git.stashPush':
      await gitService.stash('push', { message: p.message as string | undefined });
      return { success: true };
    case 'git.worktreeList':
      return gitService.worktreeList();
    case 'git.worktreeAdd':
      await gitService.worktreeAdd(
        p.path as string,
        p.branch as string | undefined,
        p.newBranch as string | undefined,
      );
      return { success: true };
    case 'git.worktreeRemove':
      await gitService.worktreeRemove(p.path as string, p.force as boolean | undefined);
      return { success: true };
    case 'git.push':
      await gitService.push(
        p.remote as string | undefined,
        p.branch as string | undefined,
        p.options as { force?: boolean; setUpstream?: boolean } | undefined,
      );
      return { success: true };
    case 'git.pull':
      await gitService.pull(
        p.remote as string | undefined,
        p.branch as string | undefined,
        p.options as { rebase?: boolean; ffOnly?: boolean } | undefined,
      );
      return { success: true };
    case 'git.fetch':
      await gitService.fetch(p.remote as string | undefined);
      return { success: true };
    case 'git.reset':
      await gitService.reset(p.mode as 'soft' | 'mixed' | 'hard', p.ref as string);
      return { success: true };
    case 'git.createTag':
      await gitService.createTag(p.name as string, p.hash as string | undefined, p.message as string | undefined);
      return { success: true };
    case 'git.deleteTag':
      await gitService.deleteTag(p.name as string);
      return { success: true };
    case 'git.abortMerge':
      await gitService.abortMerge();
      return { success: true };
    case 'git.abortRebase':
      await gitService.abortRebase();
      return { success: true };
    case 'git.squash':
      await gitService.squash(p.hashes as string[], p.message as string);
      return { success: true };
    case 'git.reword':
      await gitService.reword(p.hash as string, p.message as string);
      return { success: true };
    case 'git.canSquash':
      return gitService.canSquash(p.hashes as string[]);
    case 'git.isOnCurrentBranch':
      return { onBranch: await gitService.isOnCurrentBranch(p.hash as string) };
    case 'git.isPublished':
      return { published: await gitService.isPublished(p.hash as string) };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
