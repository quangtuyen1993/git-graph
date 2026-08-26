import * as vscode from 'vscode';
import { MessageRouter } from './controllers/message-router';
import { RouterRegistry } from './controllers/router-registry';
import { RepositorySession, type RepositoryInfo } from './controllers/repository-session';
import { GitGraphWebviewProvider } from './providers/webview-provider';
import { GitService } from './services/git.service';
import { openCompareDiff, type CompareDiffDeps } from './services/compare-diff';
import type { ReviewRunner } from './services/review-runner';
import type { WebviewHost } from './types/webview-host.types';
import { createForgeHandler, type ForgeSignOutResult, type ForgeStatus } from './controllers/forge-method-handler';
import type { ReviewForgeDeps } from './controllers/review-method-handler';
import type { ForgeComment, PullRequestDetail, PullRequestFile } from './services/forge/forge.types';
import { ForgeRegistry } from './services/forge/forge-registry';
import { ForgeStore } from './services/forge/forge-store';
import { isAllowedExternalUrl } from './services/forge/url-safety';
import { BitbucketApi } from './services/forge/bitbucket/bitbucket-api';
import { BitbucketAuthProvider, BITBUCKET_AUTH_ID, BITBUCKET_AUTH_LABEL } from './services/forge/bitbucket/bitbucket-auth';
import { BitbucketCloudProvider } from './services/forge/bitbucket/bitbucket-cloud.provider';
import { promptForBitbucketCredentials, verifyBitbucketCredentials } from './services/forge/bitbucket/bitbucket-sign-in';

// The single ReviewRunner constructed in activate() below. Held here so
// deactivate() can kill every in-flight CLI process — without this, a
// detached review process keeps running (and keeps spending) after the
// window closes.
let activeRunner: ReviewRunner | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const repos: RepositoryInfo[] = [];

  if (workspaceFolders && workspaceFolders.length > 0) {
    for (const folder of workspaceFolders) {
      const repoPath = await GitService.findRepo(folder.uri.fsPath);
      if (repoPath) {
        repos.push({ path: repoPath, name: folder.name });
      }
    }
  }

  const GIT_GRAPH_SCHEME = 'git-graph-pro-diff';
  const contentProvider = new (class implements vscode.TextDocumentContentProvider {
    private contents = new Map<string, string>();
    private readonly maxEntries = 100;

    setContent(uri: string, content: string): void {
      if (this.contents.size >= this.maxEntries) {
        const oldestKey = this.contents.keys().next().value;
        if (oldestKey !== undefined) this.contents.delete(oldestKey);
      }
      this.contents.set(uri, content);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
      return this.contents.get(uri.toString()) ?? '';
    }
  })();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_GRAPH_SCHEME, contentProvider),
  );

  const { AIReviewService } = await import('./services/ai-review.service');
  const aiReview = new AIReviewService();
  let nextPanelSessionId = 0;

  const { ReviewStore } = await import('./services/review-store');
  const { ReviewRunner } = await import('./services/review-runner');
  const { createReviewHandler } = await import('./controllers/review-method-handler');
  const { createActiveRepo } = await import('./services/active-repo');
  const { ReviewTargetState } = await import('./services/review-target');

  // ReviewStore's constructor only assigns a field; it cannot throw. reconcileOrphans()
  // does real I/O (readdir/readFile/writeFile against globalStorageUri) and must never
  // take activation down with it — a missing directory or an unreadable index degrades
  // to "orphaned runs stay marked running" rather than a failed activation.
  const reviewStore = new ReviewStore(vscode.Uri.joinPath(context.globalStorageUri, 'reviews').fsPath);
  try {
    await reviewStore.reconcileOrphans();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[extension] Failed to reconcile orphaned reviews: ${message}`);
  }

  // The live session/router, for routing events back to whichever webview is
  // currently attached. Assigned by createSession below and cleared on dispose.
  let activeSession: RepositorySession | undefined;
  let activeRouter: MessageRouter | undefined;
  const routers = new RouterRegistry();

  // Repository identity for the review side. Deliberately NOT tied to the
  // graph webview: the reviews view activates on its own (onView:...reviews)
  // and must list what is on disk before any webview exists, and keep working
  // after one is disposed.
  const activeRepo = createActiveRepo<GitService>({
    getSession: () => activeSession,
    initialPath: repos[0]?.path,
    createGitService: (path) => new GitService(path),
  });
  const getRepoId = () => activeRepo.getRepoId();

  // The forge stack: additive to the graph, so nothing here may take
  // activation down for a workspace with no forge remote at all.
  const forgeRegistry = new ForgeRegistry();
  const forgeStore = new ForgeStore();

  const bitbucketAuth = new BitbucketAuthProvider({
    secrets: context.secrets,
    prompt: promptForBitbucketCredentials,
    verify: verifyBitbucketCredentials,
  });
  context.subscriptions.push({ dispose: () => bitbucketAuth.dispose() });

  // Makes the manifest's contributes.authentication entry true: without this
  // call nothing backs it, so there is no Accounts-menu entry, no sign-out
  // affordance there, and no session-change plumbing, even though the
  // manifest advertises the integration exists.
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      BITBUCKET_AUTH_ID,
      BITBUCKET_AUTH_LABEL,
      bitbucketAuth,
      { supportsMultipleAccounts: false },
    ),
  );

  forgeRegistry.register(new BitbucketCloudProvider({
    api: new BitbucketApi({ getCredentials: () => bitbucketAuth.getCredentials() }),
    auth: bitbucketAuth,
  }));

  const forgeHandler = createForgeHandler({
    registry: forgeRegistry,
    store: forgeStore,
    getRemoteUrl: async () => {
      const gitService = activeRepo.getGitService();
      if (!gitService) return undefined;
      const remote = vscode.workspace.getConfiguration().get<string>('gitGraphPro.forge.remote') ?? 'origin';
      return gitService.getRemoteUrl(remote);
    },
    broadcast: (event, data) => routers.broadcast(event, data),
    openExternal: async (url) => {
      // `url` is PullRequestDetail.webUrl, which comes straight from the
      // host's raw response (`links.html.href`) with no validation between
      // fetch and here. `openExternal` dispatches to the OS URI handler —
      // including `vscode://<publisher>.<extension>/...`, which activates
      // and invokes another extension's UriHandler — so a malformed or
      // hostile response must not drive an arbitrary scheme.
      if (!isAllowedExternalUrl(url)) {
        throw new Error('Refusing to open a non-http(s) URL');
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
  });

  // One runner for the whole extension, not one per session: its in-flight
  // map is the source of truth for cross-session dedup (review.start
  // idempotency), so a second session for the same repo must see the first
  // session's in-flight run rather than falling back to the store's
  // persisted status.
  const reviewRunner = new ReviewRunner(reviewStore, aiReview, (_repoId, id) => {
    routers.broadcast('review.changed', { id });
  });
  activeRunner = reviewRunner;         // held at module scope so deactivate() can cancelAll()

  // Hoisted out of createSession: it only touches reviewStore and vscode, not
  // the session, so the reviews tree view (Task 11) can share it too.
  const openBody = async (repoId: string, id: string): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(reviewStore.bodyPath(repoId, id)),
    );
    await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    await vscode.window.showTextDocument(doc, { preview: false });
  };

  // Built per compareDiff call so it can bind the caller's own session tag
  // and request counter — shared by the graph session today and the review
  // webview session (Task 7) tomorrow.
  const makeCompareDiffDeps = (
    gitService: GitService,
    sessionTag: number,
    nextRequest: () => number,
  ): CompareDiffDeps => ({
    git: gitService,
    setContent: (key, content) => contentProvider.setContent(key, content),
    virtualUri: (path, query) => vscode.Uri.from({ scheme: GIT_GRAPH_SCHEME, path: `/${path}`, query }),
    fileUri: (repoPath, path) => vscode.Uri.joinPath(vscode.Uri.file(repoPath), path),
    executeDiff: async (left, right, title) => {
      await vscode.commands.executeCommand('vscode.diff', left, right, title);
    },
    nextTag: () => `ts=${Date.now()}&session=${sessionTag}&request=${nextRequest()}`,
  });

  // One review handler for the host, not one per session. The tree view's
  // commands are not attached to any webview, so a handler scoped to a live
  // session left `rerun` a silent no-op whenever the graph was closed. Both the
  // webview router and the tree view now call this same handler, and it
  // resolves the repository through activeRepo rather than a session.
  // Backed by globalState so a window reload reopens on the last compare pair.
  const reviewTargets = new ReviewTargetState({
    get: (key) => context.globalState.get(key),
    update: (key, value) => context.globalState.update(key, value),
  });
  const reviewHandler = createReviewHandler({
    store: reviewStore,
    runner: reviewRunner,
    getGitService: () => activeRepo.getGitService() as never,
    getRepoId,
    getRepos: () => {
      const session = activeSession;
      if (!session) return repos.map((r, i) => ({ ...r, active: i === 0 }));
      const current = session.getCurrentRepository();
      return session.getRepositories().map((r) => ({
        path: r.path,
        name: r.name,
        active: r.path === current?.path,
      }));
    },
    getMaxDiffChars: () =>
      vscode.workspace.getConfiguration('gitGraphPro.aiReview').get<number>('maxDiffChars') ?? 0,
    openBody,
    targets: reviewTargets,
    focusReviewView: async () => {
      await vscode.commands.executeCommand('gitGraphPro.reviews.focus');
    },
    broadcast: (event, data) => routers.broadcast(event, data),
    // Narrow closures over the same translated `forgeHandler` the forge
    // namespace itself dispatches through — mirroring how `getRemoteUrl` is
    // injected above. A forge failure reaching review.start is therefore
    // already the translated message `forgeHandler` produces, never a raw
    // ForgeError, and this file is the only place under review-* that ever
    // touches anything forge-shaped.
    forge: {
      getPullRequest: async (id) =>
        (await forgeHandler('forge.pr.get', { id })) as PullRequestDetail,
      getDiff: async (id) =>
        ((await forgeHandler('forge.pr.diff', { id })) as { diff: string }).diff,
      getFiles: async (id) =>
        ((await forgeHandler('forge.pr.files', { id })) as { files: PullRequestFile[] }).files,
      getComments: async (id) =>
        ((await forgeHandler('forge.pr.comments', { id })) as { comments: ForgeComment[] }).comments,
      getProviderId: async () => ((await forgeHandler('forge.status', {})) as ForgeStatus).providerId,
    } satisfies ReviewForgeDeps,
  });

  function createSession(host: WebviewHost): () => void {
    const panelSessionId = ++nextPanelSessionId;
    let virtualDocumentRequestSequence = 0;
    const router = new MessageRouter();
    const session = new RepositorySession({
      initialRepository: repos[0] ?? null,
      repositories: repos,
    });
    activeSession = session;
    activeRouter = router;
    const detachRouter = routers.attach(router);

    let gitWatcher: vscode.FileSystemWatcher | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let watcherGeneration = 0;
    let disposed = false;
    let repositorySwitchQueue = Promise.resolve();

    let refreshPending = false;

    const isVisible = () => host.visible !== false;

    /**
     * The bottom Panel shares its space with the terminal, so the graph spends
     * most of its life hidden. Running git for a view nobody is looking at is
     * pure waste — remember that it went stale and catch up on the way back.
     */
    function requestRefresh(): void {
      if (!isVisible()) {
        refreshPending = true;
        return;
      }
      router.sendEvent('git.refsChanged');
      router.sendEvent('graph.invalidated');
    }

    const visibilitySubscription = host.onDidChangeVisibility?.(() => {
      if (!isVisible() || !refreshPending) return;
      refreshPending = false;
      requestRefresh();
    });

    async function bindGitWatcher(): Promise<void> {
      const generation = ++watcherGeneration;
      gitWatcher?.dispose();
      gitWatcher = undefined;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      const gitService = session.getGitService();
      if (!gitService) return;

      try {
        const gitDirectory = await gitService.gitDirectory();
        if (disposed || generation !== watcherGeneration) return;

        gitWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(gitDirectory, '{HEAD,refs/**,index}'),
        );
        const invalidate = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            session.invalidate();
            requestRefresh();
          }, 500);
        };
        gitWatcher.onDidChange(invalidate);
        gitWatcher.onDidCreate(invalidate);
        gitWatcher.onDidDelete(invalidate);
      } catch (error) {
        if (disposed || generation !== watcherGeneration) return;
        gitWatcher?.dispose();
        gitWatcher = undefined;
        const message = error instanceof Error ? error.message : String(error);
        const warning = vscode.window.showWarningMessage(`Unable to watch Git repository: ${message}`);
        void Promise.resolve(warning).catch(() => undefined);
      }
    }

    /**
     * Every repository change goes through here: the switch itself, then the
     * watcher rebind. Queued, because two switches racing would leave the
     * watcher pointing at the loser's .git directory.
     */
    function queueRepositorySwitch(params: unknown): Promise<unknown> {
      const run = async () => {
        const result = await session.handleRepo('repo.switch', params);
        await bindGitWatcher();
        // The review webview is retainContextWhenHidden and never re-resolved,
        // so it never sees a fresh repo.switch response of its own. Broadcast
        // so it can drop its stale branch list/reviews/target and re-init.
        routers.broadcast('repo.changed', {});
        return result;
      };
      const result = repositorySwitchQueue.then(run, run);
      repositorySwitchQueue = result.then(() => undefined, () => undefined);
      return result;
    }

    router.register('repo', async (method: string, params: unknown) => {
      if (method === 'repo.switch') return queueRepositorySwitch(params);
      return session.handleRepo(method, params);
    });
    const MUTATING_REMOTE_METHODS = new Set(['git.push', 'git.pull', 'git.fetch']);

    router.register('git', async (method: string, params: unknown) => {
      const result = await session.handleGit(method, params);
      if (MUTATING_REMOTE_METHODS.has(method)) {
        // Cheap: drops cache entries, does not fetch. The next panel read pays.
        //
        // Wrapped: this is a side effect of a git call that already
        // succeeded, not the thing the caller asked for. RouterRegistry has
        // no error handling of its own, and sendEvent reaches into a
        // webview's `.webview` — which throws synchronously once the panel
        // is disposed. Without this try/catch, a push landing at exactly
        // that moment would report failure and drop `result`, even though
        // the push itself succeeded — a forge side effect must never be
        // able to fail a graph operation.
        try {
          forgeStore.clear();
          routers.broadcast('forge.changed', {});
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[extension] forge cache invalidation after ${method} failed: ${message}`);
        }
      }
      return result;
    });
    router.register('graph', (method: string, params: unknown) => session.handleGraph(method, params));

    router.register('ui', async (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case 'ui.getState': {
          const key = p.key as string;
          return context.globalState.get(key) ?? null;
        }
        case 'ui.setState': {
          const key = p.key as string;
          await context.globalState.update(key, p.value);
          return { success: true };
        }
        case 'ui.inputBox': {
          const result = await vscode.window.showInputBox({
            prompt: p.prompt as string,
            placeHolder: p.placeholder as string,
            value: p.value as string | undefined,
          });
          return result ?? null;
        }
        case 'ui.confirm': {
          // Callers may offer their own choices (for example "Delete local" vs
          // "Delete local + remote"). With none given this stays a yes/no
          // confirm and returns a boolean, as every existing caller expects.
          const choices = Array.isArray(p.choices) ? (p.choices as string[]) : undefined;
          const answer = await vscode.window.showWarningMessage(
            p.message as string,
            { modal: true, detail: p.detail as string | undefined },
            ...(choices ?? ['Yes']),
          );
          return choices ? (answer ?? null) : answer === 'Yes';
        }
        case 'ui.openDiff': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const filePath = p.path as string;
          const oldPath = p.oldPath as string | null | undefined;
          const hash = p.hash as string;
          const status = (p.status as string) ?? 'modified';
          const parents = await gitService.getParents(hash);
          const parentHash = parents.length > 0 ? parents[0] : null;
          let parentContent = '';
          if (parentHash && status !== 'added') {
            parentContent = await gitService.showFile(parentHash, oldPath ?? filePath) ?? '';
          }

          const shortHash = hash.substring(0, 7);
          const fileName = filePath.split('/').pop() ?? filePath;
          const virtualDocumentRequestId = ++virtualDocumentRequestSequence;
          const parentUri = vscode.Uri.from({
            scheme: GIT_GRAPH_SCHEME,
            path: `/${oldPath ?? filePath}`,
            query: `ref=${parentHash ?? 'empty'}&ts=${Date.now()}&session=${panelSessionId}&request=${virtualDocumentRequestId}&side=parent`,
          });
          contentProvider.setContent(parentUri.toString(), parentContent);

          const headHash = (await gitService.getHeadHash().catch(() => null)) ?? null;
          const isHeadCommit = !!headHash && headHash === hash;
          let currentUri: vscode.Uri;
          if (isHeadCommit && status !== 'deleted') {
            currentUri = vscode.Uri.joinPath(vscode.Uri.file(gitService.getRepoPath()), filePath);
          } else {
            const currentContent = await gitService.showFile(hash, filePath) ?? '';
            currentUri = vscode.Uri.from({
              scheme: GIT_GRAPH_SCHEME,
              path: `/${filePath}`,
              query: `ref=${hash}&ts=${Date.now()}&session=${panelSessionId}&request=${virtualDocumentRequestId}&side=current`,
            });
            contentProvider.setContent(currentUri.toString(), currentContent);
          }

          let title: string;
          if (status === 'added') {
            title = `${fileName} (added in ${shortHash})`;
          } else if (status === 'deleted') {
            title = `${fileName} (deleted in ${shortHash})`;
          } else {
            title = `${fileName} (${parentHash?.substring(0, 7) ?? '∅'} → ${shortHash})`;
          }
          await vscode.commands.executeCommand('vscode.diff', parentUri, currentUri, title);
          return { success: true };
        }
        case 'ui.openFolder': {
          const folderUri = vscode.Uri.file(p.path as string);
          await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: true });
          return { success: true };
        }
        case 'ui.pickBranch': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const branchList = await gitService.branches();
          const exclude = p.exclude as string | undefined;
          const items = branchList
            .filter(branch => branch.name !== exclude)
            .map(branch => ({
              label: branch.name,
              description: branch.current ? '(current)' : (branch.remote ? 'remote' : ''),
            }));
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: (p.placeholder as string) ?? 'Select a branch',
            title: (p.title as string) ?? 'Compare with...',
          });
          return picked ? picked.label : null;
        }
        case 'ui.compareDiff': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          return openCompareDiff(
            makeCompareDiffDeps(gitService, panelSessionId, () => ++virtualDocumentRequestSequence),
            p as never,
          );
        }
        case 'ui.openSubmodule': {
          // The picker lists submodules from every workspace repository, so the
          // one being opened may not belong to the active repo. Resolve against
          // its owner when the caller names one; without this, picking a
          // submodule of a non-selected repo fails with "Submodule not found".
          const ownerPath = p.repoPath as string | undefined;
          const gitService = ownerPath
            ? new GitService(ownerPath)
            : session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const submodule = await gitService.resolveSubmodule(p.path as string);
          const added = await session.addRepository({
            name: submodule.name,
            path: submodule.absolutePath,
          });
          return queueRepositorySwitch({ path: added.path });
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    });

    router.register('ping', async () => ({ pong: true, timestamp: Date.now() }));

    router.register('review', reviewHandler);
    router.register('forge', forgeHandler);

    router.setHost(host);
    void bindGitWatcher();

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      watcherGeneration += 1;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      gitWatcher?.dispose();
      gitWatcher = undefined;
      visibilitySubscription?.dispose();
      if (activeSession === session) activeSession = undefined;
      if (activeRouter === router) activeRouter = undefined;
      detachRouter();
      router.dispose();
    };

    host.onDidDispose(dispose);

    return dispose;
  }

  /**
   * The review tab's session. Deliberately thin: no RepositorySession, no file
   * watcher — the store and the target state live on the host and survive this
   * webview being rebuilt by hide/show. Every method resolves the repository
   * through activeRepo, same as the review handler.
   */
  function createReviewSession(host: WebviewHost): () => void {
    const sessionTag = ++nextPanelSessionId;
    let requestSequence = 0;
    const router = new MessageRouter();
    const detachRouter = routers.attach(router);

    router.register('review', reviewHandler);
    router.register('forge', forgeHandler);

    router.register('ai', async (method: string) => {
      if (method === 'ai.providers') return aiReview.detectProviders();
      throw new Error(`Unknown method: ${method}`);
    });

    router.register('git', async (method: string) => {
      if (method === 'git.branches') {
        const gitService = activeRepo.getGitService();
        if (!gitService) throw new Error('No git repository found');
        return gitService.branches();
      }
      throw new Error(`Unknown method: ${method}`);
    });

    router.register('ui', async (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case 'ui.getState':
          return context.globalState.get(p.key as string) ?? null;
        case 'ui.setState':
          await context.globalState.update(p.key as string, p.value);
          return { success: true };
        case 'ui.compareDiff': {
          const gitService = activeRepo.getGitService();
          if (!gitService) throw new Error('No git repository found');
          return openCompareDiff(
            makeCompareDiffDeps(gitService as GitService, sessionTag, () => ++requestSequence),
            p as never,
          );
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    });

    router.setHost(host);

    const dispose = () => {
      detachRouter();
      router.dispose();
    };
    host.onDidDispose(dispose);
    return dispose;
  }

  const webviewProvider = new GitGraphWebviewProvider(
    context.extensionUri,
    (host) => createSession(host),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GitGraphWebviewProvider.viewType,
      webviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  const reviewWebviewProvider = new GitGraphWebviewProvider(
    context.extensionUri,
    (host) => createReviewSession(host),
    { asset: 'review', title: 'Code Review' },
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitGraphPro.reviews', reviewWebviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    void vscode.commands.executeCommand('gitGraphPro.graph.focus');
  });
  context.subscriptions.push(openCommand);

  context.subscriptions.push(
    vscode.commands.registerCommand('gitGraphPro.forge.signIn', async () => {
      await forgeHandler('forge.signIn', {});
    }),
    vscode.commands.registerCommand('gitGraphPro.forge.signOut', async () => {
      // forge.signOut can no longer just discard its result: a provider with
      // no signOut() (see forge.types.ts) answers with guidance instead of
      // performing a sign-out, and that guidance must reach the user.
      const result = await forgeHandler('forge.signOut', {}) as ForgeSignOutResult;
      if (!result.success && result.guidance) {
        void vscode.window.showInformationMessage(result.guidance);
      }
    }),
  );
}

export function deactivate(): void {
  // Session teardown is driven by view disposal: each session's disposer is
  // registered on the view's onDidDispose and is also invoked by the provider
  // when the view is resolved again.

  // Review processes are not. Nothing must outlive the window — without this,
  // detached CLI process groups keep running and keep spending after VS Code
  // is gone.
  activeRunner?.cancelAll();
  activeRunner = undefined;
}
