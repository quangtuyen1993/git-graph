import type { Commit, GitLogOptions } from '../types/git.types';
import type { GitService } from './git.service';

type GraphLogOptions = Omit<GitLogOptions, 'maxCount' | 'skip'>;

export async function loadAllCommits(
  gitService: Pick<GitService, 'log'>,
  options: GraphLogOptions,
  batchSize = 500,
): Promise<Commit[]> {
  const commits: Commit[] = [];
  let skip = 0;

  while (true) {
    const batch = await gitService.log({
      ...options,
      maxCount: batchSize,
      skip,
    });
    commits.push(...batch);

    if (batch.length < batchSize) {
      return commits;
    }

    skip += batchSize;
  }
}
