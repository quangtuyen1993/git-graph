<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onDestroy, onMount, tick } from 'svelte';
  import { createRefreshScheduler, isSupersededError } from './lib/graph-refresh';
  import { calculateVisibleRange, getTotalHeight, ROW_HEIGHT, BUFFER_ROWS } from './lib/virtual-scroll';
  import GraphCanvas from './components/graph/GraphCanvas.svelte';
  import ContextMenu from './components/actions/ContextMenu.svelte';
  import { isSidebarPersistedState, type SidebarPersistedState } from './lib/sidebar-state';
  import { refDisplayName, refType, sortRefsForRow } from './lib/ref-chips';
  import type { MenuItem } from './types/menu.types';
  import { getColorRgb } from './lib/graph-colors';
  import Avatar from './components/common/Avatar.svelte';
  import Icon from './components/common/Icon.svelte';
  import { hasWorkingTreeChanges, type WorkingTreeStatus } from './lib/git-status';
  import { LatestRequestGate, LatestWindowRequestCoordinator } from './lib/latest-request';
  import { MutationGate } from './lib/mutation-gate';
  import LoadingSpinner from './components/common/LoadingSpinner.svelte';
  import { calculateDensity, calculatePanelLayout, defaultPanelWidths, type PanelSide } from './lib/panel-layout';
  import CommitDetail from './components/detail/CommitDetail.svelte';
  import BranchSidebar from './components/sidebar/BranchSidebar.svelte';
  import { localNameFor, resolvePullTarget } from './lib/branch-menu';
  import ResizeHandle from './components/layout/ResizeHandle.svelte';
  import CommitSearch from './components/toolbar/CommitSearch.svelte';
  import { classifyQuery, nextMatchIndex } from './lib/commit-search';
  import {
    autoGraphColumnWidth,
    clampColumnWidth,
    columnBounds,
    columnResizeDirection,
    defaultColumnWidths,
    readStoredColumnWidths,
    type ColumnKey,
    type ColumnWidths,
  } from './lib/column-layout';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
    remote: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
  }

  interface SubmoduleEntry {
    name: string;
    path: string;
    head: string | null;
    state: 'initialized' | 'uninitialized' | 'modified' | 'conflicted';
  }

  interface GraphNode {
    hash: string;
    abbreviatedHash: string;
    subject: string;
    author: string;
    authorEmail: string;
    authorDate: string;
    refs: string[];
    parents: string[];
    lane: number;
    row: number;
    color: number;
  }

  interface GraphEdge {
    fromHash: string;
    toHash: string;
    fromRow: number;
    fromLane: number;
    toRow: number;
    toLane: number;
    color: number;
  }

  interface GraphWindow {
    nodes: GraphNode[];
    edges: GraphEdge[];
    startRow: number;
    endRow: number;
    totalRows: number;
    maxLane: number;
  }

  const BRANCH_HIGHLIGHT_DURATION_MS = 300;

  let status = 'Loading...';
  let branches: Branch[] = [];
  let tags: { name: string; hash: string; message: string | null; taggerDate: string | null }[] = [];
  let stashes: { index: number; message: string; date: string; branch: string; hash: string }[] = [];
  let worktrees: { path: string; head: string; branch: string | null; bare: boolean; isMain: boolean }[] = [];
  let submodules: SubmoduleEntry[] = [];
  let error = '';

  // Multi-repo state
  interface RepoEntry {
    name: string;
    path: string;
    active: boolean;
  }
  /** A workspace submodule tagged with the repository that owns it. */
  type WorkspaceSubmodule = SubmoduleEntry & { repoPath: string; repoName: string };

  interface RepoListResult {
    repos: RepoEntry[];
    submodules?: WorkspaceSubmodule[];
  }

  let repos: RepoEntry[] = [];
  let activeRepoName = '';

  /*
   * Starred branches, scoped to the active repository — a global list would
   * carry one repo's `master` into every other repo's sidebar.
   */
  let favourites: string[] = [];
  let favouritesKey = '';

  const favouritesKeyFor = (repoPath: string): string => `favourites:${repoPath}`;

  /*
   * Takes the path rather than reading a reactive `$:` binding: the callers run
   * inside async handlers where the reactive statement has not recomputed yet,
   * so deriving the key here would read the previous repo's — or an empty one.
   */
  async function loadFavourites(repoPath: string | undefined): Promise<void> {
    favouritesKey = repoPath ? favouritesKeyFor(repoPath) : '';
    if (!favouritesKey) {
      favourites = [];
      return;
    }
    const stored = await bridge.send('ui.getState', { key: favouritesKey });
    favourites = Array.isArray(stored) ? stored as string[] : [];
  }

  function toggleFavourite(name: string): void {
    favourites = favourites.includes(name)
      ? favourites.filter((candidate) => candidate !== name)
      : [...favourites, name];
    if (favouritesKey) bridge.send('ui.setState', { key: favouritesKey, value: favourites });
  }

  // Same per-repo pattern as favourites: the sidebar reopens the way the user
  // left it for THIS repo. Saves are debounced — a burst of toggles is one write.
  let sidebarState: SidebarPersistedState | null = null;
  let sidebarStateKey = '';
  let sidebarSaveTimer: ReturnType<typeof setTimeout> | undefined;

  async function loadSidebarState(repoPath: string | undefined): Promise<void> {
    sidebarStateKey = repoPath ? `sidebarState:${repoPath}` : '';
    if (!sidebarStateKey) {
      sidebarState = null;
      return;
    }
    const stored = await bridge.send('ui.getState', { key: sidebarStateKey });
    sidebarState = isSidebarPersistedState(stored) ? stored : null;
  }

  function handleSidebarStateChange(state: SidebarPersistedState): void {
    if (!sidebarStateKey) return;
    if (sidebarSaveTimer) clearTimeout(sidebarSaveTimer);
    sidebarSaveTimer = setTimeout(() => {
      sidebarSaveTimer = undefined;
      bridge.send('ui.setState', { key: sidebarStateKey, value: state });
    }, 300);
  }

  // Graph state
  let totalRows = 0;
  let maxLane = 0;
  let layoutVersion: number | null = null;
  let graphWindow: GraphWindow | null = null;
  let selectedBranchFilter: string | null = null;
  let selectedSidebarBranch: string | null = null;
  let focusedBranchHash: string | null = null;
  let branchHighlightTimer: ReturnType<typeof setTimeout> | undefined;
  let selectedHash: string | null = null;
  let selectedHashes: Set<string> = new Set();
  let lastClickedHash: string | null = null;
  let hasWorkingChanges = false;

  // Virtual scroll state
  let scrollContainer: HTMLElement;
  let viewportHeight = 600;
  let scrollTop = 0;
  let currentStartRow = 0;
  let loading = false;
  const graphWindowRequestGate = new LatestRequestGate();
  const graphWindowRequestCoordinator = new LatestWindowRequestCoordinator<GraphWindow>(graphWindowRequestGate);
  const graphRefreshGate = new LatestRequestGate();

  // Commit search state. The result list is a set of hashes plus a cursor into
  // it, so navigating between matches never re-runs the search.
  let searchExpanded = false;
  let searching = false;
  let searchHashes: string[] = [];
  let searchActiveIndex = 0;
  let searchMessage = '';
  let searchComponent: CommitSearch | undefined;
  const searchGate = new LatestRequestGate();

  $: searchMatchSet = new Set(searchHashes);
  $: activeSearchHash = searchHashes[searchActiveIndex] ?? null;

  function clearBranchHighlight() {
    if (branchHighlightTimer !== undefined) {
      clearTimeout(branchHighlightTimer);
      branchHighlightTimer = undefined;
    }
    selectedSidebarBranch = null;
    focusedBranchHash = null;
  }

  function scheduleBranchHighlightClear() {
    branchHighlightTimer = setTimeout(() => {
      branchHighlightTimer = undefined;
      selectedSidebarBranch = null;
      focusedBranchHash = null;
    }, BRANCH_HIGHLIGHT_DURATION_MS);
  }

  onDestroy(() => {
    if (branchHighlightTimer !== undefined) clearTimeout(branchHighlightTimer);
  });

  // Commit detail state
  let detailCommit: {
    hash: string;
    abbreviatedHash: string;
    subject: string;
    message: string;
    author: string;
    authorEmail: string;
    authorDate: string;
    refs: string[];
  } | null = null;
  let detailFiles: {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }[] | null = null;
  let detailLoading = false;

  // Panel state
  let leftSidebarOpen = true;
  let rightPanelOpen = false;
  // The widths the user asked for. Only a drag, a reset or a restore writes
  // these; the rendered widths below are a pure projection of them, so
  // toggling the sidebar or dragging the panel narrow squeezes the panels
  // without destroying what the user dragged them to.
  let desiredLeftWidth = defaultPanelWidths.left;
  let desiredRightWidth = defaultPanelWidths.right;
  let viewportWidth = typeof window === 'undefined' ? 1400 : window.innerWidth;
  let windowHeight = typeof window === 'undefined' ? 800 : window.innerHeight;

  $: density = calculateDensity({ viewportHeight: windowHeight });

  $: panelLayout = calculatePanelLayout({
    leftWidth: desiredLeftWidth,
    rightWidth: desiredRightWidth,
    viewportWidth,
    leftOpen: leftSidebarOpen,
    rightOpen: rightPanelOpen,
  });
  $: leftSidebarWidth = panelLayout.left.width;
  $: rightPanelWidth = panelLayout.right.width;
  $: leftPanelMinWidth = panelLayout.left.minWidth;
  $: leftPanelMaxWidth = panelLayout.left.maxWidth;
  $: rightPanelMinWidth = panelLayout.right.minWidth;
  $: rightPanelMaxWidth = panelLayout.right.maxWidth;

  // Context menu state
  let contextMenuVisible = false;
  let contextMenuX = 0;
  let contextMenuY = 0;
  let contextMenuItems: MenuItem[] = [];
  let contextMenuTarget: { type: 'commit' | 'branch' | 'working'; value: string } | null = null;
  // Commit được đánh dấu bằng "Select for compare", chờ ghép cặp range.
  // Chỉ bị thay khi chọn commit khác, bị xoá khi cặp đã gửi đi.
  let selectedForCompare: string | null = null;
  const mutationGate = new MutationGate();
  let mutationProgress: string | null = null;
  // The one state where the banner is up but nothing is running: the spinner is
  // suppressed here so motion never implies work that is actually blocked on us.
  const AWAITING_CONFIRMATION_LABEL = 'Awaiting confirmation…';

  // Column widths. GRAPH follows the lane count until the user drags it, at
  // which point their width wins — a graph that resized itself under the
  // pointer on every scroll would be worse than one that stays put.
  let columnWidths: ColumnWidths = { ...defaultColumnWidths };
  let resizingColumn: ColumnKey | null = null;
  $: graphColWidth = columnWidths.graph ?? autoGraphColumnWidth(maxLane);

  // MESSAGE has no divider of its own: it absorbs whatever the sized columns
  // leave, so every divider here moves with the pointer.
  const columnHeaders: { key: string; label: string; resize: ColumnKey | null; edge: 'left' | 'right' }[] = [
    { key: 'graph', label: 'GRAPH', resize: 'graph', edge: 'right' },
    { key: 'message', label: 'MESSAGE', resize: null, edge: 'left' },
    { key: 'date', label: 'DATE', resize: 'date', edge: 'left' },
    { key: 'sha', label: 'SHA', resize: 'sha', edge: 'left' },
    { key: 'author', label: 'AUTHOR', resize: 'author', edge: 'left' },
  ];

  /**
   * Submodules across every workspace repository, for the picker. Distinct from
   * `submodules`, which is the ACTIVE repo's list and feeds the sidebar section —
   * scoping the picker that way made its contents depend on the current
   * selection, hiding every other repository's submodules.
   */
  let workspaceSubmodules: WorkspaceSubmodule[] = [];

  // Uninitialised submodules have no repository on disk to show.
  $: openableSubmodules = workspaceSubmodules.filter((submodule) => submodule.state !== 'uninitialized');
  $: repoOptionCount = repos.length + openableSubmodules.length;

  let invalidatedUnsubscribe: (() => void) | undefined;

  const refreshScheduler = createRefreshScheduler({
    run: () => refreshGraph(),
    delayMs: 200,
    onError: (refreshError) => {
      if (isSupersededError(refreshError)) return;
      console.warn('[git-graph] graph refresh failed:', refreshError);
    },
  });

  onMount(async () => {
    // Subscribe first: an invalidation that lands mid-startup would otherwise
    // be dropped and leave the graph stale.
    const stopInvalidated = bridge.on('graph.invalidated', () => refreshScheduler.schedule());
    invalidatedUnsubscribe = stopInvalidated;

    try {
      await bridge.send('ping.hello');
      // Load repos list
      const repoResult = await bridge.send('repo.list') as RepoListResult;
      repos = repoResult.repos;
      workspaceSubmodules = repoResult.submodules ?? [];
      const active = repos.find(r => r.active);
      activeRepoName = active?.name ?? repos[0]?.name ?? '';
      await loadFavourites(active?.path ?? repos[0]?.path);
      await loadSidebarState(active?.path ?? repos[0]?.path);
      await refreshGraph();
      await restorePanelState();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'Error';
    }
  });

  onMount(() => {
    const trackViewport = () => {
      viewportWidth = window.innerWidth;
      windowHeight = window.innerHeight;
    };
    trackViewport();
    window.addEventListener('resize', trackViewport);

    return () => {
      window.removeEventListener('resize', trackViewport);
      if (panelStateSaveTimer) clearTimeout(panelStateSaveTimer);
      if (columnStateSaveTimer) clearTimeout(columnStateSaveTimer);
      refreshScheduler.cancel();
      invalidatedUnsubscribe?.();
    };
  });

  let panelStateSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function savePanelState() {
    if (panelStateSaveTimer) clearTimeout(panelStateSaveTimer);
    panelStateSaveTimer = setTimeout(() => {
      panelStateSaveTimer = undefined;
      bridge.send('ui.setState', { key: 'layout.leftWidth', value: desiredLeftWidth });
      bridge.send('ui.setState', { key: 'layout.rightWidth', value: desiredRightWidth });
      bridge.send('ui.setState', { key: 'layout.leftSidebarOpen', value: leftSidebarOpen });
    }, 200);
  }

  let columnStateSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function saveColumnWidths() {
    if (columnStateSaveTimer) clearTimeout(columnStateSaveTimer);
    columnStateSaveTimer = setTimeout(() => {
      columnStateSaveTimer = undefined;
      bridge.send('ui.setState', { key: 'layout.columnWidths', value: columnWidths });
    }, 200);
  }

  function columnWidth(key: ColumnKey): number {
    return key === 'graph' ? graphColWidth : (columnWidths[key] ?? defaultColumnWidths[key] ?? 0);
  }

  function setColumnWidth(key: ColumnKey, width: number) {
    columnWidths = { ...columnWidths, [key]: clampColumnWidth(key, width) };
    saveColumnWidths();
  }

  /**
   * Double-click puts a column back to its starting width. For GRAPH that is
   * the lane count again, not a number, so the override is dropped entirely.
   */
  function resetColumnWidth(key: ColumnKey) {
    columnWidths = { ...columnWidths, [key]: defaultColumnWidths[key] };
    saveColumnWidths();
  }

  function startColumnResize(key: ColumnKey, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = columnWidth(key);
    const direction = columnResizeDirection[key];
    resizingColumn = key;

    const onMove = (moveEvent: MouseEvent) => {
      setColumnWidth(key, startWidth + direction * (moveEvent.clientX - startX));
    };
    const onUp = () => {
      resizingColumn = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function handleColumnResizeKey(key: ColumnKey, event: KeyboardEvent) {
    const step = 10 * columnResizeDirection[key];
    let next: number | null = null;

    switch (event.key) {
      case 'ArrowRight': next = columnWidth(key) + step; break;
      case 'ArrowLeft': next = columnWidth(key) - step; break;
      case 'Home': next = columnBounds[key].min; break;
      case 'End': next = columnBounds[key].max; break;
    }

    if (next !== null) {
      event.preventDefault();
      setColumnWidth(key, next);
    }
  }

  async function restorePanelState() {
    const [storedLeft, storedRight, storedOpen, storedViewMode, storedColumns] = await Promise.all([
      bridge.send('ui.getState', { key: 'layout.leftWidth' }),
      bridge.send('ui.getState', { key: 'layout.rightWidth' }),
      bridge.send('ui.getState', { key: 'layout.leftSidebarOpen' }),
      bridge.send('ui.getState', { key: 'detail.viewMode' }),
      bridge.send('ui.getState', { key: 'layout.columnWidths' }),
    ]);
    if (storedColumns) columnWidths = readStoredColumnWidths(storedColumns);
    if (typeof storedLeft === 'number') desiredLeftWidth = storedLeft;
    if (typeof storedRight === 'number') desiredRightWidth = storedRight;
    if (typeof storedOpen === 'boolean') leftSidebarOpen = storedOpen;
    if (storedViewMode === 'tree' || storedViewMode === 'flat') detailViewMode = storedViewMode;
  }

  // Shared with the review tab through the same key, so choosing tree in one
  // place is remembered by both.
  let detailViewMode: 'tree' | 'flat' = 'tree';
  function handleViewModeChange(mode: 'tree' | 'flat') {
    detailViewMode = mode;
    bridge.send('ui.setState', { key: 'detail.viewMode', value: mode });
  }

  function handlePanelResize(side: PanelSide, event: CustomEvent<{ width: number }>) {
    const range = side === 'left' ? panelLayout.left : panelLayout.right;
    const width = Math.max(range.minWidth, Math.min(range.maxWidth, event.detail.width));

    if (side === 'left') {
      desiredLeftWidth = width;
    } else {
      desiredRightWidth = width;
    }
    savePanelState();
  }

  function handlePanelReset(side: PanelSide) {
    if (side === 'left') {
      desiredLeftWidth = defaultPanelWidths.left;
    } else {
      desiredRightWidth = defaultPanelWidths.right;
    }
    savePanelState();
  }

  function toggleLeftSidebar() {
    leftSidebarOpen = !leftSidebarOpen;
    savePanelState();
  }

  /**
   * One reset path for every repository change. The repo list is re-fetched
   * rather than patched locally: opening a submodule adds an entry the webview
   * has never seen.
   */
  async function applyRepositoryChange(
    request: () => Promise<{ name: string; path: string }>,
  ) {
    graphRefreshGate.issue();
    graphWindowRequestGate.issue();
    loading = false;
    try {
      const result = await request();
      branches = [];
      activeRepoName = result.name;
      const repoResult = await bridge.send('repo.list') as RepoListResult;
      repos = repoResult.repos;
      workspaceSubmodules = repoResult.submodules ?? [];
      await loadFavourites(repoResult.repos.find((repo) => repo.active)?.path);
      await loadSidebarState(repoResult.repos.find((repo) => repo.active)?.path);
      selectedBranchFilter = null;
      clearBranchHighlight();
      selectedHash = null;
      selectedHashes = new Set();
      rightPanelOpen = false;
      detailCommit = null;
      detailFiles = null;
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function switchRepo(path: string) {
    await applyRepositoryChange(
      () => bridge.send('repo.switch', { path }) as Promise<{ name: string; path: string }>,
    );
  }

  async function openSubmodule(path: string, repoPath?: string) {
    await applyRepositoryChange(
      () => bridge.send('ui.openSubmodule', { path, repoPath }) as Promise<{ name: string; path: string }>,
    );
  }

  function selectRepoOption(value: string) {
    if (value.startsWith('repo:')) return switchRepo(value.slice('repo:'.length));
    if (value.startsWith('submodule:')) {
      // Two repositories can both own `packages/sdk`, so the option value
      // carries the owner alongside the relative path.
      const [repoPath, path] = value.slice('submodule:'.length).split('\u0000');
      return openSubmodule(path, repoPath);
    }
  }

  async function refreshGraph() {
    const refreshToken = graphRefreshGate.issue();
    const branchFilter = selectedBranchFilter;
    graphWindowRequestGate.issue();
    loading = false;

    try {
      const [nextBranches, nextTags, nextStashes, nextWorktrees, nextSubmodules, workingTreeStatus, build] = await Promise.all([
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('git.tags') as Promise<typeof tags>,
        bridge.send('git.stashList') as Promise<typeof stashes>,
        bridge.send('git.worktreeList') as Promise<typeof worktrees>,
        bridge.send('git.submoduleList') as Promise<SubmoduleEntry[]>,
        bridge.send('git.status').catch(() => null) as Promise<WorkingTreeStatus | null>,
        bridge.send('graph.build', branchFilter
          ? { branch: branchFilter, all: false }
          : { all: true }) as Promise<{
          totalRows: number;
          maxLane: number;
          layoutVersion: number;
        }>,
      ]);
      if (!graphRefreshGate.isLatest(refreshToken)) return;

      const range = calculateVisibleRange({
        scrollTop,
        viewportHeight,
        totalRows: build.totalRows,
      });
      const count = Math.ceil(viewportHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
      const nextWindow = await bridge.send('graph.getWindow', {
        startRow: range.startRow,
        count,
        layoutVersion: build.layoutVersion,
      }) as GraphWindow;
      if (!graphRefreshGate.isLatest(refreshToken)) return;

      graphWindowRequestGate.issue();
      branches = nextBranches;
      tags = nextTags;
      stashes = nextStashes;
      worktrees = nextWorktrees;
      submodules = nextSubmodules;
      hasWorkingChanges = workingTreeStatus !== null
        && hasWorkingTreeChanges(workingTreeStatus);
      totalRows = build.totalRows;
      maxLane = build.maxLane;
      layoutVersion = build.layoutVersion;
      // Match rows are indexes into the layout that produced them, so a new
      // layout invalidates them wholesale.
      if (searchHashes.length > 0) clearCommitSearch();
      graphWindow = nextWindow;
      currentStartRow = nextWindow.startRow;
      loading = false;
      status = branchFilter
        ? `${build.totalRows} commits on ${branchFilter}`
        : `${nextBranches.length} branches, ${build.totalRows} commits`;
    } catch (refreshError) {
      if (!graphRefreshGate.isLatest(refreshToken)) return;
      // A newer build is already on its way; dropping this result is correct.
      if (isSupersededError(refreshError)) return;
      throw refreshError;
    }
  }

  async function updateGraphWindow(
    desiredRange: { startRow: number; endRow: number },
    cachedWindow: GraphWindow | null,
  ) {
    const requestedLayoutVersion = layoutVersion;
    if (requestedLayoutVersion === null) {
      graphWindowRequestGate.issue();
      loading = false;
      return;
    }
    const count = Math.ceil(viewportHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
    try {
      await graphWindowRequestCoordinator.handle({
        currentWindow: cachedWindow,
        desiredRange,
        request: () => bridge.send('graph.getWindow', {
          startRow: desiredRange.startRow,
          count,
          layoutVersion: requestedLayoutVersion,
        }) as Promise<GraphWindow>,
        apply: (requestedWindow) => {
          graphWindow = requestedWindow;
          currentStartRow = requestedWindow.startRow;
        },
        setLoading: (value) => { loading = value; },
      });
    } catch (requestError) {
      if (
        requestedLayoutVersion !== layoutVersion
        || (requestError instanceof Error && requestError.message.includes('Graph layout version mismatch'))
      ) {
        return;
      }
      throw requestError;
    }
  }

  function handleScroll() {
    if (!scrollContainer) return;
    scrollTop = scrollContainer.scrollTop;
    viewportHeight = scrollContainer.clientHeight;

    const range = calculateVisibleRange({ scrollTop, viewportHeight, totalRows });

    void updateGraphWindow(range, graphWindow);
  }

  function handleRowClick(hash: string, event?: MouseEvent) {
    clearBranchHighlight();
    if (event?.shiftKey && lastClickedHash && graphWindow) {
      const allNodes = graphWindow.nodes;
      const lastIdx = allNodes.findIndex(n => n.hash === lastClickedHash);
      const currIdx = allNodes.findIndex(n => n.hash === hash);

      if (lastIdx !== -1 && currIdx !== -1) {
        const start = Math.min(lastIdx, currIdx);
        const end = Math.max(lastIdx, currIdx);
        selectedHashes = new Set(allNodes.slice(start, end + 1).map(n => n.hash));
        selectedHash = hash;
        if (selectedHashes.size > 1) {
          detailCommit = null;
          detailFiles = null;
          return;
        }
      }
    } else {
      selectedHashes = new Set(hash !== 'WORKING' ? [hash] : []);
      lastClickedHash = hash !== 'WORKING' ? hash : null;
      selectedHash = hash;
    }

    if (hash && hash !== 'WORKING') {
      rightPanelOpen = true;
      fetchCommitDetail(hash);
    } else {
      detailCommit = null;
      detailFiles = null;
    }
  }

  function closeRightPanel() {
    rightPanelOpen = false;
    selectedHash = null;
    selectedHashes = new Set();
    detailCommit = null;
    detailFiles = null;
  }

  async function fetchCommitDetail(hash: string) {
    detailLoading = true;
    detailFiles = null;
    try {
      const result = await bridge.send('git.show', { hash }) as {
        commit: {
          hash: string;
          abbreviatedHash: string;
          subject: string;
          message: string;
          author: string;
          authorEmail: string;
          authorDate: string;
          refs: string[];
        };
        files: {
          path: string;
          oldPath: string | null;
          status: string;
          additions: number;
          deletions: number;
          binary: boolean;
        }[];
      };
      if (selectedHash === hash) {
        detailCommit = result.commit;
        detailFiles = result.files;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    } finally {
      detailLoading = false;
    }
  }

  async function handleRowContextMenu(event: MouseEvent, hash: string) {
    event.preventDefault();
    contextMenuVisible = false;
    await tick();

    if (hash === 'WORKING') {
      contextMenuTarget = { type: 'working', value: hash };
      contextMenuX = event.clientX;
      contextMenuY = event.clientY;
      contextMenuItems = [
        { label: 'Stash tracked changes', action: 'stashTracked' },
        { label: 'Refresh', action: 'refresh' },
      ];
      contextMenuVisible = true;
      return;
    }

    if (selectedHashes.size > 1 && selectedHashes.has(hash)) {
      contextMenuTarget = { type: 'commit', value: hash };
      contextMenuX = event.clientX;
      contextMenuY = event.clientY;
      const count = selectedHashes.size;

      const hashes = graphWindow
        ? graphWindow.nodes.filter(n => selectedHashes.has(n.hash)).map(n => n.hash)
        : [...selectedHashes];

      let canSquash = false;
      try {
        const result = await bridge.send('git.canSquash', { hashes }) as { ok: boolean; reason?: string };
        canSquash = result.ok;
      } catch {
        canSquash = false;
      }

      contextMenuItems = [
        ...(canSquash
          ? [{ label: `Squash ${count} commits...`, action: 'squash' }]
          : [{ label: `Squash (not available)`, action: '', disabled: true }]
        ),
        { label: '', action: '', divider: true },
        { label: 'Copy SHAs', action: 'copyShas' },
      ];
      contextMenuVisible = true;
      return;
    }

    contextMenuTarget = { type: 'commit', value: hash };
    contextMenuX = event.clientX;
    contextMenuY = event.clientY;

    let onCurrentBranch = false;
    try {
      const result = await bridge.send('git.isOnCurrentBranch', { hash }) as { onBranch: boolean };
      onCurrentBranch = result.onBranch;
    } catch {
      onCurrentBranch = false;
    }

    contextMenuItems = [
      { label: 'Checkout this commit', action: 'checkout' },
      { label: 'Create branch here...', action: 'createBranch' },
      { label: 'Create tag here...', action: 'createTag' },
      { label: '', action: '', divider: true },
      { label: 'Reword message...', action: 'reword', disabled: !onCurrentBranch },
      { label: 'Cherry-pick', action: 'cherryPick', disabled: onCurrentBranch },
      { label: 'Revert', action: 'revert', disabled: !onCurrentBranch },
      { label: '', action: '', divider: true },
      { label: 'Reset soft to here', action: 'resetSoft', disabled: !onCurrentBranch },
      { label: 'Reset mixed to here', action: 'resetMixed', disabled: !onCurrentBranch },
      { label: 'Reset hard to here', action: 'resetHard', danger: true, disabled: !onCurrentBranch },
      { label: '', action: '', divider: true },
      { label: 'Copy SHA', action: 'copySha' },
      { label: '', action: '', divider: true },
      { label: 'Review this commit', action: 'reviewCommit' },
      ...(selectedForCompare && selectedForCompare !== hash
        ? [{ label: `Review with selected ${selectedForCompare.slice(0, 7)}`, action: 'reviewWithSelected' }]
        : []),
      selectedForCompare && selectedForCompare !== hash
        ? { label: `Compare with selected ${selectedForCompare.slice(0, 7)}`, action: 'compareWithSelected' }
        : { label: 'Select for compare', action: 'selectForCompare' },
    ];
    contextMenuVisible = true;
  }

  async function handleBranchContextMenu(event: CustomEvent<{ event: MouseEvent; branch: Branch }>) {
    const { event: mouseEvent, branch } = event.detail;
    contextMenuVisible = false;
    await tick();

    contextMenuTarget = { type: 'branch', value: branch.name };
    contextMenuX = mouseEvent.clientX;
    contextMenuY = mouseEvent.clientY;

    const currentBranchName = branches.find((b) => b.current)?.name ?? 'HEAD';
    const pullTarget = resolvePullTarget(branch);
    const pullItems = pullTarget
      ? [
          { label: '', action: '', divider: true },
          { label: `Pull into '${currentBranchName}' Using Rebase`, action: 'pullIntoCurrentRebase' },
          { label: `Pull into '${currentBranchName}' Using Merge`, action: 'pullIntoCurrentMerge' },
        ]
      : [];

    if (branch.remote) {
      // Remote branch menu
      contextMenuItems = [
        { label: 'Checkout', action: 'checkout' },
        { label: `New Branch from '${branch.name}'...`, action: 'newBranchFrom' },
        { label: '', action: '', divider: true },
        { label: `Checkout and Rebase onto '${currentBranchName}'`, action: 'checkoutAndRebase' },
        { label: '', action: '', divider: true },
        { label: `Compare with '${currentBranchName}'`, action: 'compareBranch' },
        { label: 'Show Diff with Working Tree', action: 'diffWorkingTree' },
        { label: '', action: '', divider: true },
        { label: `Rebase '${currentBranchName}' onto '${branch.name}'`, action: 'rebase' },
        { label: `Merge '${branch.name}' into '${currentBranchName}'`, action: 'merge' },
        ...pullItems,
        { label: '', action: '', divider: true },
        { label: 'Delete remote branch', action: 'deleteRemoteBranch', danger: true },
      ];
    } else if (branch.current) {
      // Current branch menu (can't delete or checkout)
      const hasUpstream = !!branch.upstream;
      contextMenuItems = [
        hasUpstream
          ? { label: 'Push', action: '', children: [
              { label: 'Push', action: 'push' },
              { label: 'Push (Force with Lease)', action: 'pushForce' },
              { label: 'Push (Set Upstream)', action: 'publish' },
            ]}
          : { label: 'Publish Branch', action: 'publish' },
        ...(hasUpstream ? [{
          label: 'Pull', action: '', children: [
            { label: 'Pull', action: 'pull' },
            { label: 'Pull (Rebase)', action: 'pullRebase' },
            { label: 'Pull (Fast-forward only)', action: 'pullFF' },
          ]
        }] : []),
        { label: 'Fetch', action: 'fetch' },
        { label: '', action: '', divider: true },
        { label: 'Rename branch...', action: 'renameBranch' },
        { label: '', action: '', divider: true },
        { label: 'Compare with...', action: 'compareBranch' },
        { label: 'Show Diff with Working Tree', action: 'diffWorkingTree' },
      ];
    } else {
      // Local branch menu
      const hasUpstream = !!branch.upstream;
      contextMenuItems = [
        { label: 'Checkout', action: 'checkout' },
        { label: `New Branch from '${branch.name}'...`, action: 'newBranchFrom' },
        ...(pullTarget
          ? [{ label: '', action: '', divider: true },
             { label: `Checkout and Rebase onto '${currentBranchName}'`, action: 'checkoutAndRebase' }]
          : []),
        { label: '', action: '', divider: true },
        { label: `Compare with '${currentBranchName}'`, action: 'compareBranch' },
        { label: 'Show Diff with Working Tree', action: 'diffWorkingTree' },
        { label: '', action: '', divider: true },
        { label: `Rebase '${currentBranchName}' onto '${branch.name}'`, action: 'rebase' },
        { label: `Merge '${branch.name}' into '${currentBranchName}'`, action: 'merge' },
        ...pullItems,
        { label: '', action: '', divider: true },
        hasUpstream
          ? { label: 'Push', action: '', children: [
              { label: 'Push', action: 'push' },
              { label: 'Push (Force with Lease)', action: 'pushForce' },
            ]}
          : { label: 'Publish Branch', action: 'publish' },
        ...(hasUpstream ? [{
          label: 'Pull', action: '', children: [
            { label: 'Pull', action: 'pull' },
            { label: 'Pull (Rebase)', action: 'pullRebase' },
            { label: 'Pull (Fast-forward only)', action: 'pullFF' },
          ]
        }] : []),
        { label: 'Fetch', action: 'fetch' },
        { label: '', action: '', divider: true },
        { label: 'Rename branch...', action: 'renameBranch' },
        { label: 'Delete branch...', action: 'deleteBranch', danger: true },
      ];
    }
    contextMenuVisible = true;
  }

  async function handleTagContextMenu(event: CustomEvent<{ event: MouseEvent; tag: { name: string; hash: string } }>) {
    const { event: mouseEvent, tag } = event.detail;
    contextMenuVisible = false;
    await tick();

    contextMenuTarget = { type: 'branch', value: tag.name };
    contextMenuX = mouseEvent.clientX;
    contextMenuY = mouseEvent.clientY;
    contextMenuItems = [
      { label: 'Checkout tag', action: 'checkout' },
      { label: 'Create branch from tag...', action: 'createBranchFromTag' },
      { label: '', action: '', divider: true },
      { label: 'Push tag to remote', action: 'pushTag' },
      { label: '', action: '', divider: true },
      { label: 'Delete tag', action: 'deleteTag', danger: true },
      { label: 'Delete tag (local + remote)', action: 'deleteTagAndRemote', danger: true },
    ];
    contextMenuVisible = true;
  }

  async function handleStashContextMenu(event: CustomEvent<{ event: MouseEvent; stash: { index: number; message: string } }>) {
    const { event: mouseEvent, stash } = event.detail;
    contextMenuVisible = false;
    await tick();

    contextMenuTarget = { type: 'branch', value: String(stash.index) };
    contextMenuX = mouseEvent.clientX;
    contextMenuY = mouseEvent.clientY;
    contextMenuItems = [
      { label: 'Apply', action: 'stashApply' },
      { label: 'Pop (apply + delete)', action: 'stashPop' },
      { label: '', action: '', divider: true },
      { label: 'Drop', action: 'stashDrop', danger: true },
    ];
    contextMenuVisible = true;
  }

  async function handleWorktreeContextMenu(event: CustomEvent<{ event: MouseEvent; worktree: { path: string; isMain: boolean; branch: string | null } }>) {
    const { event: mouseEvent, worktree } = event.detail;
    contextMenuVisible = false;
    await tick();

    contextMenuTarget = { type: 'branch', value: worktree.path };
    contextMenuX = mouseEvent.clientX;
    contextMenuY = mouseEvent.clientY;

    if (worktree.isMain) {
      contextMenuItems = [
        { label: 'Add new worktree...', action: 'worktreeAdd' },
      ];
    } else {
      contextMenuItems = [
        { label: 'Open in new window', action: 'worktreeOpen' },
        { label: '', action: '', divider: true },
        { label: 'Add new worktree...', action: 'worktreeAdd' },
        { label: 'Remove worktree', action: 'worktreeRemove', danger: true },
      ];
    }
    contextMenuVisible = true;
  }

  async function runDirectMutation(label: string, operation: () => Promise<void>) {
    await mutationGate.run(label, async () => {
      mutationProgress = label;
      try {
        await operation();
      } finally {
        mutationProgress = null;
      }
    });
    await refreshGraph();
  }

  async function handleBranchCheckout(event: CustomEvent<{ name: string }>) {
    try {
      // For remote branches (origin/main), checkout the local name (main)
      let ref = event.detail.name;
      if (ref.includes('/') && branches.some(b => b.remote && b.name === ref)) {
        ref = ref.replace(/^[^/]+\//, '');
      }
      clearBranchHighlight();
      await runDirectMutation('Checking out…', () => bridge.send('git.checkout', { ref }) as Promise<void>);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function handleGraphBranchFilter(branchName: string) {
    selectedBranchFilter = branchName || null;
    clearBranchHighlight();
    selectedHash = null;
    selectedHashes = new Set();
    lastClickedHash = null;
    rightPanelOpen = false;
    detailCommit = null;
    detailFiles = null;
    scrollTop = 0;
    if (scrollContainer) scrollContainer.scrollTop = 0;

    try {
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  /**
   * Centres a graph row in the viewport. Shared by the sidebar branch jump and
   * commit search so both land a row in the same place.
   */
  async function scrollToGraphRow(row: number) {
    if (!scrollContainer) return;
    const workingRowOffset = hasWorkingChanges ? 1 : 0;
    const targetTop = (row + workingRowOffset) * ROW_HEIGHT;
    const nextScrollTop = Math.max(0, targetTop - Math.floor(viewportHeight / 2));
    scrollTop = nextScrollTop;
    scrollContainer.scrollTop = nextScrollTop;
    await updateGraphWindow(
      calculateVisibleRange({ scrollTop, viewportHeight, totalRows }),
      graphWindow,
    );
  }

  async function handleBranchSelect(event: CustomEvent<{ name: string }>) {
    const branch = branches.find(candidate => candidate.name === event.detail.name);
    const requestedLayoutVersion = layoutVersion;
    if (!branch || requestedLayoutVersion === null || !scrollContainer) return;

    try {
      const result = await bridge.send('graph.getRow', {
        hash: branch.hash,
        layoutVersion: requestedLayoutVersion,
      }) as { row: number | null };
      if (result.row === null || requestedLayoutVersion !== layoutVersion) return;

      clearBranchHighlight();
      selectedSidebarBranch = branch.name;
      focusedBranchHash = branch.hash;
      await scrollToGraphRow(result.row);
      await tick();
      scheduleBranchHighlightClear();
    } catch (e) {
      if (requestedLayoutVersion !== layoutVersion) return;
      clearBranchHighlight();
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function toggleCommitSearch() {
    searchExpanded = !searchExpanded;
    if (!searchExpanded) {
      clearCommitSearch();
      return;
    }
    await tick();
    searchComponent?.focusInput();
  }

  async function handleCommitSearch(event: CustomEvent<{ query: string }>) {
    const { query } = event.detail;
    if (classifyQuery(query) === 'empty') { clearCommitSearch(); return; }

    const token = searchGate.issue();
    searching = true;
    searchMessage = '';
    try {
      const hashes = await bridge.send('git.searchCommits', { query }) as string[];
      if (!searchGate.isLatest(token)) return;
      searchHashes = hashes;
      searchActiveIndex = 0;
      if (hashes.length === 0) { searchMessage = 'No commits found'; return; }
      await revealSearchMatch();
    } catch (searchError) {
      if (!searchGate.isLatest(token)) return;
      searchHashes = [];
      searchMessage = searchError instanceof Error ? searchError.message : String(searchError);
    } finally {
      if (searchGate.isLatest(token)) searching = false;
    }
  }

  async function revealSearchMatch() {
    // Read the cursor directly rather than through `activeSearchHash`: callers
    // move it in the same tick, and the reactive alias only catches up on flush.
    const hash = searchHashes[searchActiveIndex] ?? null;
    const requestedLayoutVersion = layoutVersion;
    if (hash === null || requestedLayoutVersion === null || !scrollContainer) return;
    try {
      const result = await bridge.send('graph.getRow', {
        hash, layoutVersion: requestedLayoutVersion,
      }) as { row: number | null };
      if (requestedLayoutVersion !== layoutVersion) return;
      if (result.row === null) {
        searchMessage = 'Commit is outside the current branch filter';
        return;
      }
      searchMessage = '';
      await scrollToGraphRow(result.row);
    } catch {
      // A layout change invalidated the lookup; the next search starts clean.
      clearCommitSearch();
    }
  }

  function handleSearchNavigate(event: CustomEvent<{ direction: 1 | -1 }>) {
    if (searchHashes.length === 0) return;
    searchActiveIndex = nextMatchIndex(searchHashes.length, searchActiveIndex, event.detail.direction);
    void revealSearchMatch();
  }

  function clearCommitSearch() {
    searchGate.issue();
    searchHashes = [];
    searchActiveIndex = 0;
    searchMessage = '';
    searching = false;
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      void toggleCommitSearch();
    }
  }

  async function handleSidebarStashApply(event: CustomEvent<{ index: number }>) {
    try {
      await runDirectMutation('Applying stash…', () => bridge.send('git.stashApply', { index: event.detail.index }) as Promise<void>);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function handleSidebarWorktreeOpen(event: CustomEvent<{ path: string }>) {
    try {
      await bridge.send('ui.openFolder', { path: event.detail.path });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function handleSidebarSubmoduleOpen(event: CustomEvent<{ path: string }>) {
    await openSubmodule(event.detail.path);
  }

  const mutationLabels: Record<string, string> = {
    checkout: 'Checking out…',
    createBranch: 'Creating branch…',
    createTag: 'Creating tag…',
    cherryPick: 'Cherry-picking…',
    revert: 'Reverting…',
    reword: 'Rewording commit…',
    resetSoft: 'Resetting…',
    resetMixed: 'Resetting…',
    resetHard: 'Resetting…',
    squash: 'Squashing commits…',
    merge: 'Merging…',
    rebase: 'Rebasing…',
    push: 'Pushing…',
    publish: 'Publishing…',
    pull: 'Pulling…',
    fetch: 'Fetching…',
    renameBranch: 'Renaming branch…',
    deleteBranch: 'Deleting branch…',
    deleteRemoteBranch: 'Deleting remote branch…',
    newBranchFrom: 'Creating branch…',
    checkoutAndRebase: 'Checking out and rebasing…',
    pullIntoCurrentRebase: 'Pulling…',
    pullIntoCurrentMerge: 'Pulling…',
    createBranchFromTag: 'Creating branch…',
    pushTag: 'Pushing tag…',
    deleteTag: 'Deleting tag…',
    deleteTagAndRemote: 'Deleting tag…',
    stashTracked: 'Stashing changes…',
    stashApply: 'Applying stash…',
    stashPop: 'Popping stash…',
    stashDrop: 'Dropping stash…',
    worktreeAdd: 'Adding worktree…',
    worktreeRemove: 'Removing worktree…',
  };

  interface ContextMutationProgress {
    start(): void;
    awaitConfirmation(): void;
  }

  async function handleContextMenuAction(event: CustomEvent<{ action: string }>) {
    const label = mutationLabels[event.detail.action];
    let shouldRefresh = false;

    try {
      if (!label) {
        shouldRefresh = await performContextMenuAction(event);
      } else {
        await mutationGate.run('Preparing…', async () => {
          mutationProgress = 'Preparing…';
          const progress: ContextMutationProgress = {
            start: () => {
              mutationGate.updateLabel(label);
              mutationProgress = label;
            },
            awaitConfirmation: () => {
              mutationGate.updateLabel(AWAITING_CONFIRMATION_LABEL);
              mutationProgress = AWAITING_CONFIRMATION_LABEL;
            },
          };

          try {
            shouldRefresh = await performContextMenuAction(event, progress);
          } finally {
            mutationProgress = null;
          }
        });
      }

      if (shouldRefresh) {
        await refreshGraph();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  /**
   * Ask what to delete. A tracked branch offers the remote as a choice rather
   * than a separate menu item, so the decision is made where the consequence
   * is stated. Returns null when the user backs out.
   */
  async function askDeleteScope(branchName: string, tracked: boolean): Promise<boolean | null> {
    if (!tracked) {
      const confirmed = await bridge.send('ui.confirm', {
        message: `Delete branch "${branchName}"?`,
      }) as boolean;
      return confirmed ? false : null;
    }

    const answer = await bridge.send('ui.confirm', {
      message: `Delete branch "${branchName}"?`,
      detail: 'This branch tracks a remote branch. You can delete the local branch only, or both.',
      choices: ['Delete local', 'Delete local + remote'],
    }) as string | null;

    if (answer === 'Delete local') return false;
    if (answer === 'Delete local + remote') return true;
    return null;
  }

  /**
   * Delete, and if git refuses because the branch is not fully merged, say what
   * would be lost and offer to force. Without this the raw git error surfaced in
   * a banner that cleared itself, leaving no way to act on it.
   */
  async function deleteBranchWithForcePrompt(
    branchName: string,
    runMutation: (method: string, params?: unknown) => Promise<unknown>,
    progress?: ContextMutationProgress,
  ): Promise<boolean> {
    try {
      await runMutation('git.deleteBranch', { name: branchName });
      return true;
    } catch (e) {
      if ((e as { kind?: string }).kind !== 'BRANCH_NOT_FULLY_MERGED') throw e;

      progress?.awaitConfirmation();
      const forced = await bridge.send('ui.confirm', {
        message: `Branch "${branchName}" is not fully merged.`,
        detail: 'It has commits that exist on no other branch. Deleting it will lose them.',
        choices: ['Force delete'],
      }) as string | null;

      if (forced !== 'Force delete') return false;

      await runMutation('git.deleteBranch', { name: branchName, force: true });
      return true;
    }
  }

  async function performContextMenuAction(
    event: CustomEvent<{ action: string }>,
    progress?: ContextMutationProgress,
  ): Promise<boolean> {
    const action = event.detail.action;
    if (!contextMenuTarget) return false;
    const runMutation = (method: string, params?: unknown) => {
      progress?.start();
      return bridge.send(method, params);
    };

    try {
      if (contextMenuTarget.type === 'commit') {
        const hash = contextMenuTarget.value;
        switch (action) {
          case 'checkout':
            await runMutation('git.checkout', { ref: hash });
            break;
          case 'createBranch': {
            const name = await bridge.send('ui.inputBox', { prompt: 'Branch name:', placeholder: 'new-branch' }) as string | null;
            if (name) await runMutation('git.createBranch', { name, startPoint: hash });
            break;
          }
          case 'createTag': {
            const name = await bridge.send('ui.inputBox', { prompt: 'Tag name:', placeholder: 'v1.0.0' }) as string | null;
            if (name) await runMutation('git.createTag', { name, hash });
            break;
          }
          case 'cherryPick':
            await runMutation('git.cherryPick', { hash });
            break;
          case 'revert':
            await runMutation('git.revert', { hash });
            break;
          case 'reword': {
            // Get current commit message
            const commitInfo = await bridge.send('git.show', { hash }) as { commit: { message: string; subject: string } };
            const currentMsg = commitInfo.commit.message || commitInfo.commit.subject;
            const newMsg = await bridge.send('ui.inputBox', {
              prompt: 'Edit commit message:',
              placeholder: currentMsg,
              value: currentMsg
            }) as string | null;
            if (newMsg && newMsg !== currentMsg) {
              const { published } = await bridge.send('git.isPublished', { hash }) as { published: boolean };
              if (published) {
                progress?.awaitConfirmation();
                const confirmed = await bridge.send('ui.confirm', {
                  message: 'Rewording this published commit changes descendant hashes and may require a force-push. Continue?'
                }) as boolean;
                if (!confirmed) break;
              }
              await runMutation('git.reword', { hash, message: newMsg });
            }
            break;
          }
          case 'resetSoft':
            await runMutation('git.reset', { mode: 'soft', ref: hash });
            break;
          case 'resetMixed':
            await runMutation('git.reset', { mode: 'mixed', ref: hash });
            break;
          case 'resetHard': {
            progress?.awaitConfirmation();
            const confirmed = await bridge.send('ui.confirm', { message: 'Reset HARD will discard all uncommitted changes. Continue?' }) as boolean;
            if (confirmed) {
              await runMutation('git.reset', { mode: 'hard', ref: hash });
            }
            break;
          }
          case 'reviewCommit':
            await bridge.send('review.setTarget', { kind: 'commit', headRef: hash });
            break;
          case 'reviewWithSelected':
            if (selectedForCompare) {
              await bridge.send('review.setTarget', { kind: 'range', baseRef: selectedForCompare, headRef: hash });
              selectedForCompare = null;
            }
            break;
          case 'selectForCompare':
            selectedForCompare = hash;
            break;
          case 'compareWithSelected':
            if (selectedForCompare) {
              await bridge.send('review.setTarget', { kind: 'range', baseRef: selectedForCompare, headRef: hash });
              selectedForCompare = null;
            }
            break;
          case 'copySha':
            await navigator.clipboard.writeText(hash);
            break;
          case 'squash': {
            const hashes = graphWindow
              ? graphWindow.nodes.filter(n => selectedHashes.has(n.hash)).map(n => n.hash)
              : [...selectedHashes];

            // Squash with no prompts: the combined message is a starting point,
            // not a decision — the oldest commit's subject leads and every
            // subject is kept in the body so nothing is lost before reword.
            const subjects = hashes.map(
              h => graphWindow?.nodes.find(n => n.hash === h)?.subject ?? h.substring(0, 7)
            );
            const chronological = [...subjects].reverse();
            const message = [chronological[0], '', ...chronological.map(sub => `* ${sub}`)].join('\n');

            await runMutation('git.squash', { hashes, message });
            selectedHashes = new Set();
            selectedHash = null;
            break;
          }
          case 'copyShas': {
            const shas = graphWindow
              ? graphWindow.nodes.filter(n => selectedHashes.has(n.hash)).map(n => n.hash)
              : [...selectedHashes];
            await navigator.clipboard.writeText(shas.join('\n'));
            break;
          }
        }
      } else if (contextMenuTarget.type === 'working') {
        switch (action) {
          case 'stashTracked':
            await runMutation('git.stashPush');
            break;
          case 'refresh':
            break;
        }
      } else if (contextMenuTarget.type === 'branch') {
        const branchName = contextMenuTarget.value;
        switch (action) {
          case 'checkout': {
            // For remote branches (origin/main), checkout the local name (main)
            // Git will create a tracking branch if it doesn't exist locally
            const checkoutRef = branchName.includes('/') && branches.some(b => b.remote && b.name === branchName)
              ? branchName.replace(/^[^/]+\//, '')
              : branchName;
            await runMutation('git.checkout', { ref: checkoutRef });
            break;
          }
          case 'merge':
            await runMutation('git.merge', { branch: branchName });
            break;
          case 'rebase':
            await runMutation('git.rebase', { onto: branchName });
            break;
          case 'newBranchFrom': {
            const name = await bridge.send('ui.inputBox', {
              prompt: `New branch from '${branchName}':`,
              placeholder: 'feature/...',
            }) as string | null;
            if (name) await runMutation('git.createBranch', { name, startPoint: branchName });
            break;
          }
          case 'checkoutAndRebase': {
            const target = branches.find((b) => b.name === branchName);
            if (!target) break;
            const previousCurrent = branches.find((b) => b.current)?.name;
            if (!previousCurrent) break;

            const local = localNameFor(target);
            progress?.awaitConfirmation();
            const confirmed = await bridge.send('ui.confirm', {
              message: `Checkout '${local}' and rebase onto '${previousCurrent}'?`,
            }) as boolean;
            if (!confirmed) break;

            // A remote ref must become a local tracking branch first, or the
            // checkout detaches HEAD and the rebase has no branch to move.
            const localExists = branches.some((b) => !b.remote && b.name === local);
            if (!localExists) {
              await runMutation('git.createBranch', { name: local, startPoint: branchName });
            }
            await runMutation('git.checkout', { ref: local });
            await runMutation('git.rebase', { onto: previousCurrent });
            break;
          }
          case 'diffWorkingTree':
            await bridge.send('git.diffWorkingTree', { ref: branchName });
            break;
          case 'pullIntoCurrentRebase':
          case 'pullIntoCurrentMerge': {
            const target = branches.find((b) => b.name === branchName);
            const pull = target ? resolvePullTarget(target) : null;
            if (!pull) break;
            await runMutation('git.pull', {
              remote: pull.remote,
              branch: pull.ref,
              options: { rebase: action === 'pullIntoCurrentRebase' },
            });
            break;
          }
          case 'push':
            await runMutation('git.push', { remote: 'origin', branch: branchName });
            break;
          case 'pushForce':
            await runMutation('git.push', { remote: 'origin', branch: branchName, options: { force: true } });
            break;
          case 'publish':
            await runMutation('git.push', { remote: 'origin', branch: branchName, options: { setUpstream: true } });
            break;
          case 'pull':
            await runMutation('git.pull', { remote: 'origin', branch: branchName });
            break;
          case 'pullRebase':
            await runMutation('git.pull', { remote: 'origin', branch: branchName, options: { rebase: true } });
            break;
          case 'pullFF':
            await runMutation('git.pull', { remote: 'origin', branch: branchName, options: { ffOnly: true } });
            break;
          case 'fetch':
            await runMutation('git.fetch', { remote: 'origin' });
            break;
          case 'renameBranch': {
            const newName = await bridge.send('ui.inputBox', { prompt: 'New branch name:', placeholder: branchName, value: branchName }) as string | null;
            if (newName && newName !== branchName) {
              await runMutation('git.renameBranch', { oldName: branchName, newName });
            }
            break;
          }
          case 'deleteBranch': {
            progress?.awaitConfirmation();
            const tracked = !!branches.find((b) => b.name === branchName)?.upstream;
            const alsoRemote = await askDeleteScope(branchName, tracked);
            if (alsoRemote === null) break;

            const deleted = await deleteBranchWithForcePrompt(branchName, runMutation, progress);
            if (!deleted) break;

            if (alsoRemote) {
              await runMutation('git.push', { remote: 'origin', branch: `:${branchName}` });
            }
            break;
          }
          case 'deleteRemoteBranch': {
            const shortName = branchName.replace(/^[^/]+\//, '');
            const remote = branchName.split('/')[0] || 'origin';
            progress?.awaitConfirmation();
            const confirmed = await bridge.send('ui.confirm', { message: `Delete remote branch "${branchName}"?` }) as boolean;
            if (confirmed) {
              await runMutation('git.push', { remote, branch: `:${shortName}` });
            }
            break;
          }
          // Tag actions
          case 'createBranchFromTag': {
            const name = await bridge.send('ui.inputBox', { prompt: 'Branch name from tag:', placeholder: `branch-from-${branchName}` }) as string | null;
            if (name) await runMutation('git.createBranch', { name, startPoint: branchName });
            break;
          }
          case 'pushTag':
            await runMutation('git.push', { remote: 'origin', branch: `refs/tags/${branchName}` });
            break;
          case 'deleteTag': {
            progress?.awaitConfirmation();
            const confirmed = await bridge.send('ui.confirm', { message: `Delete tag "${branchName}"?` }) as boolean;
            if (confirmed) {
              await runMutation('git.deleteTag', { name: branchName });
            }
            break;
          }
          case 'deleteTagAndRemote': {
            progress?.awaitConfirmation();
            const confirmed = await bridge.send('ui.confirm', { message: `Delete tag "${branchName}" locally and from remote?` }) as boolean;
            if (confirmed) {
              await runMutation('git.deleteTag', { name: branchName });
              await runMutation('git.push', { remote: 'origin', branch: `:refs/tags/${branchName}` });
            }
            break;
          }
          // Stash actions
          case 'stashApply':
            await runMutation('git.stashApply', { index: parseInt(branchName) });
            break;
          case 'stashPop':
            await runMutation('git.stashPop', { index: parseInt(branchName) });
            break;
          case 'stashDrop': {
            progress?.awaitConfirmation();
            const confirmed = await bridge.send('ui.confirm', { message: `Drop stash@{${branchName}}?` }) as boolean;
            if (confirmed) {
              await runMutation('git.stashDrop', { index: parseInt(branchName) });
            }
            break;
          }
          // Worktree actions
          case 'worktreeAdd': {
            const wtPath = await bridge.send('ui.inputBox', { prompt: 'Worktree path:', placeholder: '../my-worktree' }) as string | null;
            if (wtPath) {
              const wtBranch = await bridge.send('ui.inputBox', { prompt: 'New branch name (leave empty for detached):', placeholder: '' }) as string | null;
              await runMutation('git.worktreeAdd', { path: wtPath, newBranch: wtBranch || undefined });
            }
            break;
          }
          case 'worktreeRemove': {
            progress?.awaitConfirmation();
            const confirmed = await bridge.send('ui.confirm', { message: `Remove worktree at "${branchName}"?` }) as boolean;
            if (confirmed) {
              await runMutation('git.worktreeRemove', { path: branchName });
            }
            break;
          }
          case 'worktreeOpen':
            await bridge.send('ui.openFolder', { path: branchName });
            break;
          case 'compareBranch': {
            const currentBr = branches.find(b => b.current);
            let base = branchName;
            let head = currentBr?.name ?? '';
            if (!head || head === branchName) {
              // Right-click chính branch hiện tại: chọn base qua QuickPick, head = branch đó.
              const picked = await bridge.send('ui.pickBranch', {
                exclude: branchName, title: 'Compare with...', placeholder: 'Select the base branch',
              }) as string | null;
              if (!picked) break;
              base = picked;
              head = branchName;
            }
            await bridge.send('review.setTarget', { kind: 'branch', baseRef: base, headRef: head });
            break;
          }
        }
      }

      return action !== 'copySha' && action !== 'copyShas' && action !== 'reviewCommit' && action !== 'selectForCompare' && action !== 'compareWithSelected' && action !== 'reviewWithSelected';
    } finally {
      contextMenuTarget = null;
    }
  }

  function formatRelativeTime(dateStr: string): string {
    const now = Date.now();
    const date = new Date(dateStr).getTime();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(months / 12);
    return `${years}y ago`;
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<div class="container" class:compact={density === 'compact'}>
  {#if mutationProgress}
    <div class="mutation-progress" aria-live="polite">
      {#if mutationProgress !== AWAITING_CONFIRMATION_LABEL}
        <!-- The banner is already the live region for this state, and the visible
             caption below is its announcement. LoadingSpinner carries its own
             role="status" plus visually-hidden label, so left exposed it would nest
             a live region inside a live region and say the label twice. Hidden from
             assistive tech, the spinner is purely the visual "still working" cue. -->
        <span class="mutation-spinner" aria-hidden="true">
          <LoadingSpinner label={mutationProgress} />
        </span>
      {/if}
      <span>{mutationProgress}</span>
    </div>
  {/if}
  <header class="toolbar">
    <button
      class="toolbar-icon-btn"
      class:active={leftSidebarOpen}
      aria-pressed={leftSidebarOpen}
      aria-label="Toggle branches panel"
      title="Toggle branches panel"
      on:click={toggleLeftSidebar}
    ><Icon name="layout-sidebar-left" /></button>

    <div class="toolbar-group" class:static={repoOptionCount <= 1}>
      <span class="toolbar-glyph"><Icon name="repo" /></span>
      {#if repoOptionCount > 1}
        <select
          class="toolbar-select"
          aria-label="Repository"
          on:change={(e) => selectRepoOption(e.currentTarget.value)}
        >
          <optgroup label="Repositories">
            {#each repos as repo (repo.path)}
              <option value="repo:{repo.path}" selected={repo.active}>{repo.name}</option>
            {/each}
          </optgroup>
          {#if openableSubmodules.length > 0}
            <optgroup label="Submodules">
              {#each openableSubmodules as submodule (`${submodule.repoPath}/${submodule.path}`)}
                <option value={`submodule:${submodule.repoPath}\u0000${submodule.path}`}>
                  {repos.length > 1 ? `${submodule.repoName} / ${submodule.name}` : submodule.name}
                </option>
              {/each}
            </optgroup>
          {/if}
        </select>
      {:else if activeRepoName}
        <span class="repo-name">{activeRepoName}</span>
      {/if}
    </div>

    <div class="toolbar-group">
      <span class="toolbar-glyph"><Icon name="git-branch" /></span>
      <select
        class="toolbar-select graph-branch-filter"
        aria-label="Filter graph by branch"
        value={selectedBranchFilter ?? ''}
        on:change={(event) => handleGraphBranchFilter(event.currentTarget.value)}
      >
        <option value="">All branches</option>
        {#each branches as branch (branch.name)}
          <option value={branch.name}>{branch.name}</option>
        {/each}
      </select>
    </div>

    <span class="status">{status}</span>

    <button
      class="toolbar-icon-btn"
      class:active={searchExpanded}
      aria-label="Search commits"
      aria-pressed={searchExpanded}
      title="Search commits (Ctrl+F)"
      on:click={toggleCommitSearch}
    ><Icon name="search" /></button>
    <CommitSearch
      bind:this={searchComponent}
      expanded={searchExpanded}
      {searching}
      total={searchHashes.length}
      activeIndex={searchActiveIndex}
      message={searchMessage}
      on:search={handleCommitSearch}
      on:navigate={handleSearchNavigate}
      on:clear={() => { clearCommitSearch(); searchExpanded = false; }}
    />

    <button
      class="toolbar-icon-btn"
      aria-label="Refresh"
      title="Refresh"
      on:click={() => refreshGraph()}
    ><Icon name="refresh" /></button>
    <button
      class="toolbar-icon-btn"
      class:active={rightPanelOpen}
      aria-pressed={rightPanelOpen}
      aria-label="Toggle detail panel"
      title="Toggle detail panel"
      disabled={!rightPanelOpen}
      on:click={closeRightPanel}
    ><Icon name="layout-sidebar-right" /></button>
  </header>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <div class="content-area">
    <!-- Left sidebar: Branches -->
    {#if leftSidebarOpen}
      <aside class="left-sidebar" style="width: {leftSidebarWidth}px;">
        {#key activeRepoName}
          <BranchSidebar
            {branches}
            {tags}
            {stashes}
            {worktrees}
            {submodules}
            selectedBranch={selectedSidebarBranch}
            initialState={sidebarState}
            on:stateChange={(event) => handleSidebarStateChange(event.detail)}
            on:branchSelect={handleBranchSelect}
            on:branchContextMenu={handleBranchContextMenu}
            on:tagContextMenu={handleTagContextMenu}
            on:stashContextMenu={handleStashContextMenu}
            on:worktreeContextMenu={handleWorktreeContextMenu}
            on:checkout={handleBranchCheckout}
            on:stashApply={handleSidebarStashApply}
            on:worktreeOpen={handleSidebarWorktreeOpen}
            on:submoduleOpen={handleSidebarSubmoduleOpen}
            on:favouriteToggle={(event) => toggleFavourite(event.detail.name)}
            {favourites}
          />
        {/key}
      </aside>
      <ResizeHandle
        side="left"
        currentWidth={leftSidebarWidth}
        minWidth={leftPanelMinWidth}
        maxWidth={leftPanelMaxWidth}
        on:resize={(event) => handlePanelResize('left', event)}
        on:reset={() => handlePanelReset('left')}
      />
    {/if}

    <!-- Center: Graph -->
    <div
      class="center-panel"
      style="--graph-col-width: {graphColWidth}px; --date-col-width: {columnWidths.date}px; --sha-col-width: {columnWidths.sha}px; --author-col-width: {columnWidths.author}px"
    >
      <div class="table-header">
        {#each columnHeaders as column (column.key)}
          <div class="col-{column.key}">
            {#if column.resize && column.edge === 'left'}
              <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
              <div
                class="col-resizer left"
                class:dragging={resizingColumn === column.resize}
                on:mousedown={(e) => startColumnResize(column.resize, e)}
                on:dblclick|preventDefault={() => resetColumnWidth(column.resize)}
                on:keydown={(e) => handleColumnResizeKey(column.resize, e)}
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${column.label} column`}
                aria-valuenow={columnWidth(column.resize)}
                aria-valuemin={columnBounds[column.resize].min}
                aria-valuemax={columnBounds[column.resize].max}
                tabindex="0"
              ></div>
            {/if}
            <span class="col-title">{column.label}</span>
            {#if column.resize && column.edge === 'right'}
              <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
              <div
                class="col-resizer right"
                class:dragging={resizingColumn === column.resize}
                on:mousedown={(e) => startColumnResize(column.resize, e)}
                on:dblclick|preventDefault={() => resetColumnWidth(column.resize)}
                on:keydown={(e) => handleColumnResizeKey(column.resize, e)}
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${column.label} column`}
                aria-valuenow={columnWidth(column.resize)}
                aria-valuemin={columnBounds[column.resize].min}
                aria-valuemax={columnBounds[column.resize].max}
                tabindex="0"
              ></div>
            {/if}
          </div>
        {/each}
      </div>

      <section class="scroll-area" bind:this={scrollContainer} on:scroll={handleScroll}>
        <div class="scroll-content" style="height: {getTotalHeight(totalRows + (hasWorkingChanges ? 1 : 0))}px;">
          {#if graphWindow}
            <div
              class="graph-svg-overlay"
              style="top: {currentStartRow * ROW_HEIGHT + (hasWorkingChanges ? ROW_HEIGHT : 0)}px; width: {graphColWidth}px;"
            >
              <GraphCanvas
                nodes={graphWindow.nodes}
                edges={graphWindow.edges}
                startRow={graphWindow.startRow}
                maxLane={graphWindow.maxLane}
              />
            </div>
          {/if}

          {#if hasWorkingChanges}
            <div
              class="commit-row working-changes"
              style="top: 0"
              class:selected={selectedHash === 'WORKING'}
              on:click={() => handleRowClick('WORKING')}
              on:keydown={(e) => { if (e.key === 'Enter') handleRowClick('WORKING'); }}
              on:contextmenu={(e) => handleRowContextMenu(e, 'WORKING')}
              role="row"
              tabindex="0"
            >
              <div class="col-graph"></div>
              <div class="col-message">
                <span class="working-label">● Working Changes</span>
              </div>
              <div class="col-date"></div>
              <div class="col-sha"></div>
              <div class="col-author"></div>
            </div>
          {/if}

          {#if graphWindow}
            {#each graphWindow.nodes as node (node.hash)}
              <div
                class="commit-row"
                style="top: {(node.row - graphWindow.startRow + currentStartRow) * ROW_HEIGHT + (hasWorkingChanges ? ROW_HEIGHT : 0)}px; --lane-rgb: {getColorRgb(node.color)}"
                class:selected={selectedHash === node.hash || selectedHashes.has(node.hash)}
                class:branch-focused={focusedBranchHash === node.hash}
                class:search-match={searchMatchSet.has(node.hash)}
                class:search-match-active={activeSearchHash === node.hash}
                class:compare-selected={selectedForCompare === node.hash}
                on:click={(e) => handleRowClick(node.hash, e)}
                on:keydown={(e) => { if (e.key === 'Enter') handleRowClick(node.hash); }}
                on:contextmenu={(e) => handleRowContextMenu(e, node.hash)}
                role="row"
                tabindex="0"
              >
                <div class="col-graph"></div>
                <div class="col-message">
                  <span class="commit-subject" title={node.subject}>{node.subject}</span>
                  {#if node.refs.length > 0}
                    <span class="ref-chips">
                      {#each sortRefsForRow(node.refs) as ref (ref)}
                        <span class="ref-badge ref-{refType(ref)}" title={refDisplayName(ref)}
                        >{refDisplayName(ref)}</span>
                      {/each}
                    </span>
                  {/if}
                </div>
                <div class="col-date">{formatRelativeTime(node.authorDate)}</div>
                <div class="col-sha">{node.abbreviatedHash}</div>
                <div class="col-author">
                  <Avatar name={node.author} email={node.authorEmail ?? ''} size={18} />
                  <span class="author-name">{node.author}</span>
                </div>
              </div>
            {/each}
          {:else}
            <div class="loading">Loading graph...</div>
          {/if}
        </div>
      </section>
    </div>

    <!-- Right panel: Commit Detail -->
    {#if rightPanelOpen}
      <ResizeHandle
        side="right"
        currentWidth={rightPanelWidth}
        minWidth={rightPanelMinWidth}
        maxWidth={rightPanelMaxWidth}
        on:resize={(event) => handlePanelResize('right', event)}
        on:reset={() => handlePanelReset('right')}
      />
      <aside class="right-panel" style="width: {rightPanelWidth}px;">
        <!--
          The commit detail owns its own header — its CHANGED FILES row is the
          panel title, so there is no redundant "COMMIT" bar stacked above it.
        -->
        <CommitDetail
          commit={detailCommit}
          files={detailFiles}
          loading={detailLoading}
          initialViewMode={detailViewMode}
          on:close={closeRightPanel}
          on:viewModeChange={(e) => handleViewModeChange(e.detail.mode)}
          on:openFile={(e) => bridge.send('ui.openDiff', e.detail)}
        />
      </aside>
    {/if}
  </div>

  <ContextMenu
    items={contextMenuItems}
    x={contextMenuX}
    y={contextMenuY}
    visible={contextMenuVisible}
    on:action={handleContextMenuAction}
    on:close={() => { contextMenuVisible = false; }}
  />
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-foreground, #cccccc);
  }

  .mutation-progress {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mutation-spinner {
    display: inline-flex;
    align-items: center;
  }

  /* Toolbar */
  .toolbar {
    height: 32px;
    padding: 0 6px;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    background: var(--vscode-sideBar-background, #1e1e1e);
  }

  /* 24px hit area around a 16px glyph, the VS Code toolbar button metric. */
  .toolbar-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--vscode-icon-foreground, #cccccc);
    cursor: pointer;
    opacity: 0.85;
  }

  .toolbar-icon-btn:hover:not(:disabled) {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }

  .toolbar-icon-btn.active {
    opacity: 1;
    background: var(--vscode-inputOption-activeBackground, rgba(0, 122, 204, 0.25));
    border-color: var(--vscode-inputOption-activeBorder, transparent);
    color: var(--vscode-inputOption-activeForeground, #ffffff);
  }

  .toolbar-icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .toolbar-icon-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: 5px;
    min-width: 0;
  }

  .toolbar-group:hover,
  .toolbar-group:focus-within {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.06));
  }

  .toolbar-group:focus-within {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  /* A lone repository name is a label, not a control: no hover affordance. */
  .toolbar-group.static:hover {
    background: none;
  }

  .toolbar-glyph {
    display: flex;
    align-items: center;
    color: var(--vscode-icon-foreground, #cccccc);
    opacity: 0.7;
  }

  /* Quiet until touched: the group above supplies hover and focus affordance. */
  .toolbar-select {
    max-width: 220px;
    padding: 0 2px;
    border: none;
    background: none;
    color: var(--vscode-foreground, #cccccc);
    font-family: inherit;
    font-size: 12px;
    outline: none;
    cursor: pointer;
    text-overflow: ellipsis;
  }

  .graph-branch-filter {
    min-width: 110px;
  }

  .repo-name {
    font-size: 12px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    margin-left: auto;
    padding-right: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #767676);
    white-space: nowrap;
  }

  .error-banner {
    padding: 6px 12px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f44747);
    font-size: 12px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  }

  /* Content area: 3-panel layout */
  .content-area {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  /* Left sidebar */
  .left-sidebar {
    flex-shrink: 0;
    border-right: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: var(--vscode-sideBar-background, #1e1e1e);
    overflow: hidden;
  }

  /* Center panel */
  .center-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 300px;
    background: var(--vscode-editor-background, #1e1e1e);
  }

  /* Right panel */
  .right-panel {
    flex-shrink: 0;
    border-left: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: var(--vscode-sideBar-background, #1e1e1e);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Table header */
  .table-header {
    display: flex;
    align-items: center;
    height: 24px;
    padding: 0;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground, #767676);
    flex-shrink: 0;
    user-select: none;
  }

  .table-header > div {
    position: relative;
    height: 100%;
    display: flex;
    align-items: center;
    overflow: hidden;
  }

  .table-header .col-title {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .table-header .col-graph {
    width: var(--graph-col-width);
    min-width: var(--graph-col-width);
    flex-shrink: 0;
    padding-left: 8px;
  }

  .table-header .col-message {
    flex: 1;
    min-width: 40px;
    padding-left: 8px;
  }

  .table-header .col-date {
    width: var(--date-col-width);
    min-width: var(--date-col-width);
    flex-shrink: 0;
    padding-left: 8px;
  }

  .table-header .col-sha {
    width: var(--sha-col-width);
    min-width: var(--sha-col-width);
    flex-shrink: 0;
    padding-left: 8px;
  }

  .table-header .col-author {
    width: var(--author-col-width);
    min-width: var(--author-col-width);
    flex-shrink: 0;
    padding-left: 8px;
    padding-right: 8px;
  }

  /*
   * The divider is drawn inside the header cell and taken out of the flow, so
   * adding it costs no width — the header stays aligned with the rows below,
   * which have no dividers of their own.
   */
  .col-resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 9px;
    cursor: col-resize;
    z-index: 5;
    overflow: visible;
  }

  .col-resizer.left {
    left: -4px;
  }

  .col-resizer.right {
    right: -4px;
  }

  .col-resizer::after {
    content: '';
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 4px;
    width: 1px;
    background: var(--vscode-panel-border, #2b2b2b);
    transition: background 0.15s ease, top 0.15s ease, bottom 0.15s ease;
  }

  .col-resizer:hover::after,
  .col-resizer.dragging::after,
  .col-resizer:focus-visible::after {
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--vscode-focusBorder, #007acc);
  }

  .col-resizer:focus-visible {
    outline: none;
  }

  /* Scroll area */
  .scroll-area {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
  }

  .scroll-content {
    position: relative;
    min-width: 100%;
  }

  .graph-svg-overlay {
    position: absolute;
    left: 0;
    z-index: 1;
    pointer-events: none;
    /* Dragging the graph column narrower crops the lanes instead of letting
       them paint over the message column. */
    overflow: hidden;
  }

  /* Commit rows.
     Each row is tinted with its own lane colour (--lane-rgb), fading out to the
     right so the graph column reads as the colour source. */
  .commit-row {
    position: absolute;
    left: 0;
    right: 0;
    height: 32px;
    display: flex;
    align-items: center;
    cursor: pointer;
    user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.05));
    --lane-rgb: 120, 120, 120;
    --lane-alpha: 0.05;
    background:
      linear-gradient(
        90deg,
        rgba(var(--lane-rgb), var(--lane-alpha)) 0%,
        rgba(var(--lane-rgb), calc(var(--lane-alpha) * 0.45)) 45%,
        rgba(var(--lane-rgb), 0) 85%
      );
  }

  .commit-row:hover {
    --lane-alpha: 0.13;
  }

  .commit-row.selected {
    --lane-alpha: 0.22;
  }

  /* Selected rows keep the lane tint but add the theme's selection foreground
     and a lane-coloured accent bar so selection stays obvious. */
  .commit-row.selected {
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
    box-shadow: inset 2px 0 0 0 rgb(var(--lane-rgb));
  }

  .commit-row.compare-selected {
    outline: 1px dashed var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  /* Editor find-widget colours, so a match reads the same here as in a file. */
  .commit-row.search-match {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  }

  .commit-row.search-match-active {
    background: var(--vscode-editor-findMatchBackground, rgba(234, 92, 0, 0.56));
  }

  .commit-row.branch-focused {
    --lane-alpha: 0.72;
    z-index: 3;
    color: #ffffff;
    filter: brightness(1.45) saturate(1.35);
    box-shadow:
      inset 4px 0 0 rgb(var(--lane-rgb)),
      inset 0 0 0 1px rgba(var(--lane-rgb), 0.95),
      0 0 20px 4px rgba(var(--lane-rgb), 0.72);
    animation: branch-focus-flash 300ms ease-out;
  }

  @keyframes branch-focus-flash {
    from {
      filter: brightness(2) saturate(1.8);
      box-shadow:
        inset 6px 0 0 rgb(var(--lane-rgb)),
        inset 0 0 0 2px rgb(var(--lane-rgb)),
        0 0 28px 8px rgba(var(--lane-rgb), 0.95);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .commit-row.branch-focused {
      animation: none;
    }
  }

  .commit-row .col-graph {
    width: var(--graph-col-width);
    min-width: var(--graph-col-width);
    flex-shrink: 0;
    height: 100%;
  }

  .commit-row .col-message {
    flex: 1;
    min-width: 40px;
    padding-left: 8px;
    overflow: hidden;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .commit-row .col-date {
    width: var(--date-col-width);
    min-width: var(--date-col-width);
    flex-shrink: 0;
    padding-left: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #767676);
    white-space: nowrap;
  }

  .commit-row .col-sha {
    width: var(--sha-col-width);
    min-width: var(--sha-col-width);
    flex-shrink: 0;
    padding-left: 8px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-textLink-foreground, #4fc1ff);
    white-space: nowrap;
  }

  .commit-row .col-author {
    width: var(--author-col-width);
    min-width: var(--author-col-width);
    flex-shrink: 0;
    padding-left: 8px;
    padding-right: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
  }

  .author-name {
    font-size: 11px;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .working-changes .working-label {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
    font-weight: 600;
    font-size: 13px;
    /* The message column no longer sets nowrap for its children, so the
       refless working-changes label states it directly. */
    white-space: nowrap;
  }

  /* Ref badges */
  .ref-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 1;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ref-branch {
    background: rgba(0, 122, 204, 0.2);
    color: var(--vscode-textLink-foreground, #4fc1ff);
    border: 1px solid rgba(0, 122, 204, 0.4);
  }

  .ref-tag {
    background: rgba(215, 186, 125, 0.15);
    color: var(--vscode-editorWarning-foreground, #d7ba7d);
    border: 1px solid rgba(215, 186, 125, 0.4);
  }

  .ref-head {
    background: rgba(106, 153, 85, 0.2);
    color: var(--vscode-testing-iconPassed, #6a9955);
    border: 1px solid rgba(106, 153, 85, 0.5);
  }

  /* Remotes read as secondary: same shape as a local branch, muted text. */
  .ref-remote {
    background: rgba(0, 122, 204, 0.2);
    color: var(--vscode-descriptionForeground, #767676);
    border: 1px solid rgba(0, 122, 204, 0.4);
  }

  .commit-subject {
    flex: 1 1 auto;
    min-width: 0;            /* a flex item never ellipsises without this */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ref-chips {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 50%;          /* chips never starve the subject */
    display: flex;
    gap: 6px;
    overflow: hidden;
    /* Pack from the start so the overflow lands on the END edge: `overflow:
       hidden` clips whatever sits past the container's end, and `flex-end`
       packing pushes the negative free space out through the START edge
       instead, which would clip the HEAD/branch chips that sortRefsForRow
       deliberately puts first. The group is still flush right without
       `flex-end` because .commit-subject is `flex: 1 1 auto` and eats all the
       free space in .col-message, leaving the chips against its right edge. */
    justify-content: flex-start;
  }

  .loading {
    padding: 32px;
    text-align: center;
    color: var(--vscode-descriptionForeground, #767676);
  }

  /* The bottom Panel opens around 250px tall. Chrome that reads as breathing
     room in an editor tab costs a whole commit row down here. */
  .container.compact .toolbar {
    height: 24px;
  }

  .container.compact .status {
    display: none;
  }

  .container.compact .table-header {
    display: none;
  }

  .container.compact {
    --panel-header-height: 24px;
  }
</style>
