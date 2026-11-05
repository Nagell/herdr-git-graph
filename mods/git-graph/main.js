// Herdr mod: git-graph
// A visual Git graph viewer with topological branch lanes, commit history,
// working tree inspection, hierarchical file tree, and interactive diff viewer.

import { View, div, svg, uniform_list } from "gpui-kit";
import {
  v_flex,
  h_flex,
  InputState,
  Input,
  v_virtual_list,
  Scrollbar,
  VirtualListScrollHandle,
  v_resizable,
  resizable_panel,
} from "gpui-base";
import {
  spaces,
  panes,
  focused,
  props,
  exec,
  hc,
  pickFolder,
  watchFolder,
  theme,
  settings,
  shared,
  setShared,
  notify,
  nextCommand,
  readTextFile,
  run,
  terminals,
  layout,
} from "herdr";
import {
  countLines,
  formatRelativeTime,
  getLaneColor,
  getStatusColor,
  parseRefs,
  computeLanes,
  buildFileTree,
  flattenFileTree,
  tagArgs,
  logArgs,
  diffRows,
  highlightRows,
  buildDiffView,
  lineSegments,
  computeEffectiveRoot,
  wrapInlineRows,
  wrapSplitRows,
  isLayoutNodeVisible,
  isFreeModel,
  cleanModelLabel,
  resolveCleanAgentModelLogic,
  filterVisibleCleanModels,
} from "./git-logic.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const NON_INTERACTIVE = ["-c", "core.editor=true", "-c", "core.pager=cat"];
// Remote operations may need the network: never wait for a terminal credential
// prompt, and abort transfers that stall instead of hanging the toolbar.
const NETWORK = [
  ...NON_INTERACTIVE,
  "-c",
  "credential.interactive=false",
  "-c",
  "http.lowSpeedLimit=1000",
  "-c",
  "http.lowSpeedTime=30",
];

// Background tree-cleanup agent. OpenCode's "mini" interface keeps the session
// watchable and steerable. Free models are always preferred; the stored choice
// is only used when it is still present in `opencode models`.
const CLEAN_AGENT_MODEL_PREFERENCE = [
  "opencode/deepseek-v4.1-flash-free#low",
  "opencode/glm-5.3-flash-free#low",
  "opencode/mimo-v2.6-flash-free",
  "opencode/pulse-alpha-free#low",
  "opencode/flint-40b-free#low",
  "opencode/beam-free#low",
  "opencode/crouton-alpha-free#low",
  "opencode/nemotron-3.5-lightning-free",
  "opencode-go/beam-free#low",
  "opencode-go/iceman-contributor-free",
  "opencode/big-pickle",
];
const CLEAN_AGENT_MODEL = CLEAN_AGENT_MODEL_PREFERENCE[0];
const CLEAN_AGENT_MODEL_KEY = "git-graph.cleanAgentModel";
const CLEAN_AGENT_LABEL = "AI commit worker";
// When no curated preference matches, free models from these families are
// listed first: they are the strongest at code edits and commit slicing.
const CLEAN_AGENT_FAMILY_RANK = [
  "deepseek",
  "glm",
  "qwen",
  "kimi",
  "mimo",
  "minimax",
  "mistral",
  "gemma",
  "nemotron",
  "flint",
  "beam",
  "pulse",
  "crouton",
  "iceman",
  "big-pickle",
];

/** Lower is better; unknown families come last. */
function cleanModelRank(id) {
  const name = String(id || "").split("/").pop() || "";
  const idx = CLEAN_AGENT_FAMILY_RANK.findIndex((family) => name.includes(family));
  return idx < 0 ? CLEAN_AGENT_FAMILY_RANK.length : idx;
}

// Provider tabs in the model picker. Icons are copied into this mod so the
// picker keeps them when published; unknown providers get the generic icon.
const CLEAN_PROVIDER_ORDER = ["opencode", "opencode-go", "github-copilot", "google", "deepseek"];
const CLEAN_PROVIDER_ICONS = {
  opencode: "mods/git-graph/icons/opencode.svg",
  "opencode-go": "mods/git-graph/icons/opencode.svg",
  "github-copilot": "mods/git-graph/icons/copilot.svg",
  google: "mods/git-graph/icons/gemini.svg",
  deepseek: "mods/git-graph/icons/deepseek.svg",
};
const CLEAN_PROVIDER_NAMES = {
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  "github-copilot": "Copilot",
  google: "Google",
  deepseek: "DeepSeek",
};

/** A short, human-readable provider name. */
function cleanProviderName(id) {
  const key = String(id || "other");
  if (CLEAN_PROVIDER_NAMES[key]) return CLEAN_PROVIDER_NAMES[key];
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** The icon for a provider, with a generic fallback. */
function cleanProviderIcon(id) {
  return CLEAN_PROVIDER_ICONS[String(id || "")] || "mods/git-graph/icons/provider.svg";
}

/** @param {any} c @returns {`#${string}`} */
const color = (c) => /** @type {`#${string}`} */ (c);

/**
 * VS Code-like language badge for a changed file: a small colored square with
 * a short label. Unknown extensions return null and get the generic file icon.
 * @param {string} name
 */
function fileTypeBadge(name) {
  const base = String(name || "").toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop() : "";
  const special = {
    dockerfile: ["DK", "#2496ed", "#ffffff"],
    makefile: ["MK", "#6d8086", "#ffffff"],
    ".gitignore": ["GI", "#f14e32", "#ffffff"],
    ".env": ["E", "#ecd53f", "#1e1e1e"],
    ".editorconfig": ["EC", "#6d8086", "#ffffff"],
  };
  const types = {
    js: ["JS", "#f1e05a", "#1e1e1e"],
    mjs: ["JS", "#f1e05a", "#1e1e1e"],
    cjs: ["JS", "#f1e05a", "#1e1e1e"],
    jsx: ["JS", "#f1e05a", "#1e1e1e"],
    ts: ["TS", "#3178c6", "#ffffff"],
    mts: ["TS", "#3178c6", "#ffffff"],
    cts: ["TS", "#3178c6", "#ffffff"],
    tsx: ["TS", "#3178c6", "#ffffff"],
    css: ["#", "#2965f1", "#ffffff"],
    scss: ["#", "#c6538c", "#ffffff"],
    sass: ["#", "#c6538c", "#ffffff"],
    less: ["#", "#1d365d", "#ffffff"],
    html: ["<>", "#e44d26", "#ffffff"],
    htm: ["<>", "#e44d26", "#ffffff"],
    vue: ["V", "#41b883", "#1e1e1e"],
    svelte: ["S", "#ff3e00", "#ffffff"],
    json: ["{}", "#cbcb41", "#1e1e1e"],
    jsonc: ["{}", "#cbcb41", "#1e1e1e"],
    md: ["M", "#519aba", "#ffffff"],
    mdx: ["M", "#519aba", "#ffffff"],
    py: ["Py", "#3572a5", "#ffffff"],
    rs: ["R", "#dea584", "#1e1e1e"],
    go: ["GO", "#00add8", "#1e1e1e"],
    sh: [">_", "#89e051", "#1e1e1e"],
    bash: [">_", "#89e051", "#1e1e1e"],
    zsh: [">_", "#89e051", "#1e1e1e"],
    fish: [">_", "#89e051", "#1e1e1e"],
    yml: ["Y", "#cb171e", "#ffffff"],
    yaml: ["Y", "#cb171e", "#ffffff"],
    toml: ["T", "#9c4221", "#ffffff"],
    ini: ["T", "#9c4221", "#ffffff"],
    conf: ["T", "#9c4221", "#ffffff"],
    lock: ["L", "#f0b400", "#1e1e1e"],
    svg: ["I", "#a074c4", "#ffffff"],
    png: ["I", "#a074c4", "#ffffff"],
    jpg: ["I", "#a074c4", "#ffffff"],
    jpeg: ["I", "#a074c4", "#ffffff"],
    gif: ["I", "#a074c4", "#ffffff"],
    webp: ["I", "#a074c4", "#ffffff"],
    ico: ["I", "#a074c4", "#ffffff"],
    pdf: ["P", "#b30b00", "#ffffff"],
    sql: ["DB", "#e38c00", "#ffffff"],
    java: ["J", "#b07219", "#ffffff"],
    c: ["C", "#555555", "#ffffff"],
    h: ["C", "#555555", "#ffffff"],
    cpp: ["C", "#f34b7d", "#ffffff"],
    cc: ["C", "#f34b7d", "#ffffff"],
    cxx: ["C", "#f34b7d", "#ffffff"],
    hpp: ["C", "#f34b7d", "#ffffff"],
    cs: ["C#", "#178600", "#ffffff"],
    php: ["P", "#777bb4", "#ffffff"],
    rb: ["RB", "#cc342d", "#ffffff"],
    swift: ["S", "#f05138", "#ffffff"],
    kt: ["K", "#a97bff", "#ffffff"],
    kts: ["K", "#a97bff", "#ffffff"],
    dart: ["D", "#00b4ab", "#ffffff"],
    lua: ["L", "#000080", "#ffffff"],
    r: ["R", "#198ce7", "#ffffff"],
    xml: ["<>", "#e37933", "#ffffff"],
  };
  const hit = special[base] || types[ext];
  return hit ? { label: hit[0], bg: hit[1], fg: hit[2] } : null;
}

/** Human label for a porcelain status code. */
function statusLabel(status) {
  return { M: "Modified", A: "Added", D: "Deleted", U: "Conflict", R: "Renamed" }[status] || "Changed";
}

function resolveLocation(manualRoot, currentRoot) {
  if (manualRoot) {
    return { cwd: manualRoot, on: null };
  }
  const p = props();
  if (p?.repo || p?.cwd || p?.folder) {
    return { cwd: p.repo || p.cwd || p.folder, on: p.on || null };
  }
  const space = spaces().find((s) => s.active);
  const f = focused();
  // Herdr can keep focus in the previous space when the selected one has no
  // pane to focus (a pinned placeholder, say). Never read that pane's folder
  // as this space's: fall through to the space's own folder or terminals.
  const mine = Boolean(f && f.space === space?.id);
  const on =
    mine && f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : space?.machine ?? null;

  // A pinned space is anchored to its project. Terminals inside it may cd
  // anywhere; they must not move the graph off the pin.
  const pinnedLoc = (shared("spaces.pinned_locations") ?? {})[space?.id];
  if (pinnedLoc) return { cwd: pinnedLoc, on };

  // 1. The terminal you are looking at: the graph follows it, unless it is
  //    already inside the repo on screen.
  const focusedPane = mine && f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const focusedCwd = focusedPane?.cwd || (mine && f?.terminal ? f?.cwd : null);
  if (focusedCwd) {
    if (currentRoot && (focusedCwd === currentRoot || focusedCwd.startsWith(currentRoot + "/"))) {
      return { cwd: currentRoot, on };
    }
    return { cwd: focusedCwd, on };
  }

  // 2. The terminal in this mod's own tab: the pane it was split beside.
  const activeTabPane = mine ? panes().find((p) => p.tab === f?.tab && p.cwd && !p.mod) : null;
  if (activeTabPane?.cwd) {
    if (currentRoot && (activeTabPane.cwd === currentRoot || activeTabPane.cwd.startsWith(currentRoot + "/"))) {
      return { cwd: currentRoot, on };
    }
    return { cwd: activeTabPane.cwd, on };
  }

  // 3. The space itself.
  if (space?.folder) return { cwd: space.folder, on };

  // 4. Any terminal in the space.
  const tabIds = new Set((space?.tabs ?? []).map((t) => t.id));
  const activeSpacePane = panes().find((p) => tabIds.has(p.tab) && p.cwd && !p.mod);
  if (activeSpacePane?.cwd) return { cwd: activeSpacePane.cwd, on };

  // 5. Last resort: a root already resolved for this view.
  if (currentRoot) return { cwd: currentRoot, on };

  return { cwd: null, on };
}

async function detectInProgress(root, on) {
  const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  try {
    const mergeP = await git(["rev-parse", "--git-path", "MERGE_HEAD"]);
    if (mergeP.code === 0 && mergeP.stdout.trim()) {
      const chk = await exec("test", ["-e", mergeP.stdout.trim()], { cwd: root, on });
      if (chk.code === 0) return "merge";
    }
    const rebaseMergeP = await git(["rev-parse", "--git-path", "rebase-merge"]);
    if (rebaseMergeP.code === 0 && rebaseMergeP.stdout.trim()) {
      const chk = await exec("test", ["-d", rebaseMergeP.stdout.trim()], { cwd: root, on });
      if (chk.code === 0) return "rebase";
    }
    const rebaseApplyP = await git(["rev-parse", "--git-path", "rebase-apply"]);
    if (rebaseApplyP.code === 0 && rebaseApplyP.stdout.trim()) {
      const chk = await exec("test", ["-d", rebaseApplyP.stdout.trim()], { cwd: root, on });
      if (chk.code === 0) return "rebase";
    }
    const cherryP = await git(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]);
    if (cherryP.code === 0 && cherryP.stdout.trim()) {
      const chk = await exec("test", ["-e", cherryP.stdout.trim()], { cwd: root, on });
      if (chk.code === 0) return "cherry-pick";
    }
    const revertP = await git(["rev-parse", "--git-path", "REVERT_HEAD"]);
    if (revertP.code === 0 && revertP.stdout.trim()) {
      const chk = await exec("test", ["-e", revertP.stdout.trim()], { cwd: root, on });
      if (chk.code === 0) return "revert";
    }
  } catch {}
  return null;
}

export default class GitGraph extends View {
  init(_props, cx) {
    const p = props() || {};
    // A diff viewer tab: the mod is opened with { diffFile, diffKind, diffHash? }
    // and renders that one diff full size instead of the graph.
    this.diffMode = typeof p.diffFile === "string" && p.diffFile.length > 0;
    this.diffFile = this.diffMode ? p.diffFile : null;
    this.diffKind = p.diffKind === "commit" ? "commit" : "worktree";
    this.diffHash = typeof p.diffHash === "string" ? p.diffHash : null;
    this.diffOn = typeof p.on === "string" ? p.on : null;
    this.diffText = null;
    this.diffError = null;
    const savedDiffView = shared("git-graph.diffView");
    const requestedDiffView = typeof p.diffView === "string" ? p.diffView : null;
    const diffView =
      requestedDiffView === "inline" || requestedDiffView === "split" || requestedDiffView === "stacked"
        ? requestedDiffView
        : savedDiffView === "split" || savedDiffView === "stacked"
          ? savedDiffView
          : "inline";
    this.diffView = diffView;
    const requestedDiffWrap = typeof p.diffWrap === "boolean" ? p.diffWrap : null;
    this.diffWrap = requestedDiffWrap ?? (shared("git-graph.diffWrap") === true);
    this.diffDisplay = null;
    this.diffDisplayKey = null;

    this.commits = [];
    this.filteredCommits = [];
    this.workingTreeFiles = [];
    this.branchFilter = "all"; // 'all' | 'current' | explicit branch name
    this.currentBranch = "";
    this.availableBranches = [];
    this.hasHead = true;
    this.commitLimit = 500;

    this.selectedCommit = null;
    this.commitDetails = null;
    this.commitFiles = [];
    this.selectedFile = null;
    this.collapsedFolders = new Set();
    this.diffRows = [];
    this.diffLeft = [];
    this.diffRight = [];
    this.diffWidth = 0;
    this.diffLeftWidth = 0;
    this.diffRightWidth = 0;
    this.diffAdd = 0;
    this.diffDel = 0;
    this.diffLoading = false;
    this.diffScroll = null;

    this.maxLane = 0;
    this.loading = false;
    this.pendingRefresh = false;
    this.busy = false;
    this.error = null;
    this.root = this.diffMode && typeof p.folder === "string" && p.folder ? p.folder : null;
    this.context = null;
    this.watched = null;
    this.watchToken = null;
    this.wasVisible = false;

    this.searchQuery = "";
    this.searchOpen = false;
    this.typing = false;
    this.lastLeftClickEvent = null;
    this.lastListLeftClickEvent = null;
    this.lastRightClickRootPos = null;
    this.lastRightClickEvent = null;
    this.width = 0;
    this.height = 0;
    this.manualRoot = null;

    this.branchDropdownOpen = false;
    this.contextMenu = null; // { type: 'commit' | 'branch' | 'stash' | 'working-tree', commit?, ref?, x: number, y: number }
    this.modalDialog = null; // { type: string, commit?: any, ref?: any, resetMode?: string, ... }
    this.modalInput = null;
    this.modalTagMessageInput = null;
    this.inProgressOp = null; // { type: string, conflicts: number }

    // Saved stashes. Each one becomes a dedicated graph row above the working
    // tree instead of leaking Git's internal WIP/index/untracked commits.
    this.stashes = []; // [{ ref, hash, baseHash, subject, author, email, timestamp }]
    this.stashNodes = []; // pseudo-commits rendered in the table
    this.stagedCount = 0;

    // Remote tracking state for the fetch / pull / push toolbar buttons.
    this.upstream = null; // e.g. "origin/main"
    this.remotes = [];
    this.ahead = 0;
    this.behind = 0;
    this.detached = false;
    this.remoteAction = null; // "fetch" | "pull" | "push" while one is running

    // Background AI commit worker. The terminal it runs in is closed as soon
    // as its commits land and the tree is clean.
    this.treeAgent = null; // { address, name, sessionId, headBefore, ... }
    this.treeAgentStarting = false;
    this.treeAgentModel = null; // last resolved model id
    this.cleanModelsCache = null; // { at, root, on, models } from `opencode models`

    this.handle = cx.focus_handle();

    if (this.diffMode) {
      this.diffScroll = VirtualListScrollHandle.new();
      this.loadDiffTab(cx);
      this.wasVisible = this.isViewVisible();
      // Only a working-tree diff can change under us; a commit's cannot.
      if (this.diffKind === "worktree") {
        cx.timer.every(10000, (cx) => this.loadDiffTab(cx));
        cx.timer.every(100, (cx) => {
          const visible = this.isViewVisible();
          const justOpened = visible && !this.wasVisible;
          this.wasVisible = visible;
          if (justOpened) this.loadDiffTab(cx);
        });
      }
      return;
    }

    this.searchInput = InputState.new({ placeholder: "Filter commits, authors, hashes, refs…" });
    // OpenCode Mini does not report agent status; follow its session instead.
    cx.timer.every(3000, (cx) => this.pollTreeAgent(cx));
    this.searchInput.on("change", (_e, cx) => {
      this.searchQuery = this.searchInput.value().toLowerCase().trim();
      this.applyFilter();
      cx.notify();
    });
    this.searchInput.on("focus", (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.searchInput.on("blur", (_e, cx) => {
      this.typing = false;
      cx.notify();
    });

    // Herdr command listener
    cx.spawn(async (cx) => {
      while (true) {
        const cmd = await nextCommand();
        if (cmd === "focus") {
          this.handle.focus();
          cx.notify();
        }
      }
    });

    this.wasVisible = this.isViewVisible();
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // Switching spaces or opening the Changes panel does not re-render the
    // panel by itself: watch visibility and location (in memory only, no git)
    // so the graph reloads automatically as soon as it opens or changes.
    cx.timer.every(100, (cx) => {
      const visible = this.isViewVisible();
      const justOpened = visible && !this.wasVisible;
      this.wasVisible = visible;
      if (justOpened || this.getKey() !== this.context) {
        this.refresh(cx);
      }
    });
  }

  /**
   * Releases watchers and resources on tab close.
   *
   * @param {import("./gpui-kit.js").Context} _cx
   */
  async close(_cx) {
    this.watched = null;
    this.watchToken = null;
  }

  /** Reads the one diff this tab was opened for, as a unified diff string. */
  async readDiff(root) {
    const path = this.diffFile;
    const on = this.diffOn;

    if (this.diffKind === "commit") {
      if (!this.diffHash) throw new Error("No commit for this diff");
      const r = await exec(
        "git",
        [
          ...READ,
          "show",
          "-m",
          "--first-parent",
          "--root",
          "--format=",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          this.diffHash,
          "--",
          path,
        ],
        { cwd: root, on }
      );
      if (r.code !== 0) throw new Error(r.stderr.trim() || "git show failed");
      const text = r.stdout.trim() ? r.stdout : "No differences found";
      return text.length > 500000 ? text.slice(0, 500000) + "\n… (diff truncated)" : text;
    }

    // Working tree: an untracked file has no git diff at all, so synthesize
    // an all-added diff from its contents instead.
    const tracked = await exec("git", [...READ, "ls-files", "--error-unmatch", "--", path], { cwd: root, on });
    if (tracked.code !== 0) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) return "Cannot preview this file (binary, too large, or unreadable)";
      if (text.includes("\0")) return "Binary file · no text diff";
      const lines = text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500);
      const header = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`;
      return header + lines.map((l) => `+${l}`).join("\n");
    }

    const head = await exec("git", [...READ, "rev-parse", "--verify", "HEAD"], { cwd: root, on });
    const r = await exec(
      "git",
      [
        ...READ,
        "diff",
        ...(head.code === 0 ? ["HEAD"] : ["--cached"]),
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        path,
      ],
      { cwd: root, on }
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || "git diff failed");
    const text = r.stdout.trim() ? r.stdout : "No differences found";
    return text.length > 500000 ? text.slice(0, 500000) + "\n… (diff truncated)" : text;
  }

  /** Loads the tab's diff and rebuilds the editor only when the text changed. */
  loadDiffTab(cx) {
    if (this.diffLoading || !this.diffFile) return;
    this.diffLoading = true;
    cx.notify();

    const cwd = this.root;
    cx.spawn(async (cx) => {
      try {
        if (!cwd) throw new Error("No folder for this diff");
        const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on: this.diffOn });
        if (top.code !== 0) throw new Error(top.stderr.trim() || "Not a git repository");
        const root = top.stdout.trim();
        this.root = root;

        const text = await this.readDiff(root);
        this.diffError = null;
        if (text !== this.diffText) {
          this.diffText = text;
          const highlighted = highlightRows(diffRows(text), this.diffFile);
          const view = buildDiffView(highlighted);
          this.diffRows = view.inline;
          this.diffLeft = view.left;
          this.diffRight = view.right;
          this.diffDisplayKey = null;
          this.diffAdd = this.diffRows.filter((row) => row.kind === "+").length;
          this.diffDel = this.diffRows.filter((row) => row.kind === "-").length;
          const longest = this.diffRows.reduce((n, row) => Math.max(n, row.text.length), 0);
          this.diffWidth = Math.max(320, 132 + Math.ceil(longest * 7.6));
          const leftLongest = this.splitLongest(view.left, "old");
          const rightLongest = this.splitLongest(view.right, "new");
          this.diffLeftWidth = Math.max(240, 76 + Math.ceil(leftLongest * 7.6));
          this.diffRightWidth = Math.max(240, 76 + Math.ceil(rightLongest * 7.6));
        }
        // A working-tree diff goes stale as files change; a commit's does not.
        if (this.diffKind === "worktree") this.watchDiff(cx, root);
      } catch (err) {
        this.diffError = err instanceof Error ? err.message : String(err);
      } finally {
        this.diffLoading = false;
        cx.notify();
      }
    });
  }

  /** Keeps a working-tree diff tab live while files are edited. */
  watchDiff(cx, root) {
    if (this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.loadDiffTab(cx);
        }
      } catch {
        if (this.watched === root) this.watched = null;
      }
    });
  }

  /** Longest line in one split column, used as that pane's scroll width. */
  splitLongest(rows, side) {
    let longest = 0;
    for (const row of rows) {
      const text =
        row.kind === "pair"
          ? side === "old"
            ? row.left?.text ?? ""
            : row.right?.text ?? ""
          : row.text ?? "";
      if (text.length > longest) longest = text.length;
    }
    return longest;
  }

  /** Switches between the inline, side-by-side and stacked diff layouts. */
  setDiffView(mode, cx) {
    if (this.diffView === mode) return;
    this.diffView = mode;
    setShared("git-graph.diffView", mode);
    cx.notify();
  }

  /** Turns soft wrapping on or off for diff lines. */
  setDiffWrap(wrap, cx) {
    if (this.diffWrap === wrap) return;
    this.diffWrap = wrap;
    setShared("git-graph.diffWrap", wrap);
    cx.notify();
  }

  /** Approximate code-point width available to one wrapped diff line. */
  diffColumns(panes) {
    const width = this.width > 0 ? this.width : 1200;
    const paneWidth = width / panes;
    const gutter = this.diffView === "inline" ? 132 : 76;
    return Math.max(1, Math.floor((paneWidth - gutter) / 7.6));
  }

  /**
   * The rows the visible diff list draws: the parsed rows when wrapping is
   * off, or their wrapped display rows when it is on. Cached per layout, row
   * set and width so scrolling and repainting do not re-wrap every frame.
   */
  diffDisplayRows() {
    const panes = this.diffView === "split" ? 2 : 1;
    const columns = this.diffColumns(panes);
    const key = `${this.diffWrap ? "wrap" : "scroll"}|${this.diffView}|${columns}|${this.diffRows.length}|${this.diffLeft.length}`;
    if (this.diffDisplayKey === key) return this.diffDisplay;

    /** @type {Record<string, any>} */
    let display;
    if (this.diffView === "inline") {
      display = {
        inline: this.diffWrap ? wrapInlineRows(this.diffRows, columns) : this.diffRows,
      };
    } else {
      const split = this.diffWrap
        ? wrapSplitRows(this.diffLeft, this.diffRight, columns)
        : { left: this.diffLeft, right: this.diffRight };
      display = { left: split.left, right: split.right };
    }

    this.diffDisplayKey = key;
    this.diffDisplay = display;
    return display;
  }

  /** Theme color for a token kind emitted by the diff highlighter. */
  tokenColor(kind, t) {
    switch (kind) {
      case "keyword":
        return t.ansi5;
      case "string":
        return t.ansi2;
      case "number":
        return t.ansi3;
      case "comment":
        return t.dim;
      case "function":
        return t.ansi4;
      case "property":
        return t.ansi6;
      case "type":
        return t.ansi4;
      default:
        return null;
    }
  }

  /** One row of the unified diff: both gutters, a sign, and the line. */
  diffRow(row, t) {
    const mono = String(settings().font_family ?? "JetBrains Mono");

    if (row.kind === "@") {
      return h_flex()
        .w_full()
        .h(22)
        .flex_none()
        .px(12)
        .items_center()
        .bg(color(t.raised))
        .font_family(mono)
        .text_size(10.5)
        .text_color(color(t.ansi4))
        .child(div().truncate().child(row.text));
    }

    if (row.kind === "\\") {
      return h_flex()
        .w_full()
        .h(22)
        .flex_none()
        .px(12)
        .items_center()
        .font_family(mono)
        .text_size(10.5)
        .text_color(color(t.dim))
        .child(div().truncate().child(row.text));
    }

    const add = row.kind === "+";
    const del = row.kind === "-";
    const changeBg = color((add ? t.ansi2 : t.ansi1) + "55");
    return h_flex()
      .w_full()
      .h(22)
      .flex_none()
      .when(add, (e) => e.bg(color(t.ansi2 + "18")))
      .when(del, (e) => e.bg(color(t.ansi1 + "18")))
      .child(
        div()
          .w(44)
          .flex_none()
          .pr(8)
          .text_right()
          .text_size(10)
          .text_color(color(t.dim))
          .child(row.oldNum != null ? String(row.oldNum) : "")
      )
      .child(
        div()
          .w(44)
          .flex_none()
          .pr(8)
          .text_right()
          .text_size(10)
          .text_color(color(add || del ? t.muted : t.dim))
          .child(row.newNum != null ? String(row.newNum) : "")
      )
      .child(
        div()
          .w(18)
          .flex_none()
          .text_center()
          .font_semibold()
          .text_color(color(add ? t.ansi2 : del ? t.ansi1 : t.muted))
          .child(add ? "+" : del ? "−" : " ")
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .overflow_hidden()
          .children(
            lineSegments(row.spans, row.changes).map((span) =>
              div()
                .flex_none()
                .text_color(color(this.tokenColor(span.kind, t) ?? (add || del ? t.foreground : t.muted)))
                .when(span.changed, (e) => e.bg(changeBg))
                .child(span.text)
            )
          )
      );
  }

  /** One line cell in a split pane: gutter, sign, and character-level spans. */
  splitLineCell(cell, t) {
    const add = cell.kind === "+";
    const del = cell.kind === "-";
    const changeBg = color((add ? t.ansi2 : t.ansi1) + "55");
    return h_flex()
      .w_full()
      .h(22)
      .flex_none()
      .when(add, (e) => e.bg(color(t.ansi2 + "18")))
      .when(del, (e) => e.bg(color(t.ansi1 + "18")))
      .child(
        div()
          .w(44)
          .flex_none()
          .pr(8)
          .text_right()
          .text_size(10)
          .text_color(color(t.dim))
          .child(cell.num != null ? String(cell.num) : "")
      )
      .child(
        div()
          .w(18)
          .flex_none()
          .text_center()
          .font_semibold()
          .text_color(color(add ? t.ansi2 : del ? t.ansi1 : t.muted))
          .child(add ? "+" : del ? "−" : " ")
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .overflow_hidden()
          .child(
            h_flex()
              .flex_none()
              .children(
                lineSegments(cell.spans, cell.changes).map((span) =>
                  div()
                    .flex_none()
                    .text_color(color(this.tokenColor(span.kind, t) ?? (add || del ? t.foreground : t.muted)))
                    .when(span.changed, (e) => e.bg(changeBg))
                    .child(span.text)
                )
              )
          )
      );
  }

  /** The hatched-looking filler on the side where a paired line has no counterpart. */
  splitFillerCell(t) {
    return h_flex().w_full().h(22).flex_none().bg(color(t.raised + "40"));
  }

  /** One row of a split pane; both panes get the same row count and heights. */
  splitRow(row, side, t) {
    if (row.kind === "pair") {
      const cell = side === "old" ? row.left : row.right;
      return cell ? this.splitLineCell(cell, t) : this.splitFillerCell(t);
    }

    if (row.kind === "@") {
      return h_flex()
        .w_full()
        .h(22)
        .flex_none()
        .px(12)
        .items_center()
        .bg(color(t.raised))
        .text_size(10.5)
        .text_color(color(t.ansi4))
        .child(div().truncate().child(row.text));
    }

    return h_flex()
      .w_full()
      .h(22)
      .flex_none()
      .px(12)
      .items_center()
      .text_size(10.5)
      .text_color(color(t.dim))
      .child(div().truncate().child(row.text ?? ""));
  }

  /**
   * One half of a split diff. Both halves are virtual lists tracking the same
   * scroll handle, so a wheel, trackpad or scrollbar drag in either pane moves
   * them together; each keeps its own horizontal scrollbar.
   */
  renderSplitPane(side, t) {
    const display = this.diffDisplayRows();
    const rows = side === "old" ? display.left : display.right;
    const width = side === "old" ? this.diffLeftWidth : this.diffRightWidth;
    const id = side === "old" ? "diff-split-old" : "diff-split-new";

    return v_flex()
      .size_full()
      .min_w(0)
      .min_h(0)
      .relative()
      .font_family(String(settings().font_family ?? "JetBrains Mono"))
      .text_size(11.5)
      .child(
        div()
          .id(`${id}-x`)
          .size_full()
          .min_w(0)
          .overflow_hidden()
          .child(
            div()
              .size_full()
              .min_w(0)
              .when(!this.diffWrap, (e) => e.overflow_x_scrollbar())
              .when(this.diffWrap, (e) => e.overflow_hidden())
              .child(
                div()
                  .w_full()
                  .when(!this.diffWrap, (e) => e.min_w(width))
                  .h_full()
                  .child(
                    v_virtual_list(id, rows.length, 22, (i) => String(i), (range) =>
                      rows.slice(range.start, range.end).map((row) => this.splitRow(row, side, t))
                    )
                      .track_scroll(this.diffScroll)
                      .size_full()
                  )
              )
          )
      )
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }

  /** The inline diff, as a single virtualized column with full-width scrolling. */
  renderInlineDiff(t) {
    const rows = this.diffDisplayRows().inline;
    return div()
      .flex_1()
      .min_h(0)
      .relative()
      .font_family(String(settings().font_family ?? "JetBrains Mono"))
      .text_size(11.5)
      .child(
        div()
          .id("diff-scroll-x")
          .size_full()
          .when(!this.diffWrap, (e) => e.overflow_x_scrollbar())
          .when(this.diffWrap, (e) => e.overflow_hidden())
          .child(
            div()
              .w_full()
              .when(!this.diffWrap, (e) => e.min_w(this.diffWidth))
              .h_full()
              .child(
                v_virtual_list(
                  "diff-rows",
                  rows.length,
                  22,
                  (i) => String(i),
                  (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))
                ).size_full()
              )
          )
      )
      .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0());
  }

  /** Side-by-side or stacked panes, both scrolled to the same row. */
  renderSplitDiff(t) {
    const stacked = this.diffView === "stacked";
    const container = div().flex_1().min_h(0).w_full().relative();

    if (stacked) {
      return container
        .child(
          div()
            .absolute()
            .left(0)
            .right(0)
            .top(0)
            .h("50%")
            .child(this.renderSplitPane("old", t))
        )
        .child(
          div()
            .absolute()
            .left(0)
            .right(0)
            .top("50%")
            .bottom(0)
            .child(this.renderSplitPane("new", t))
        )
        .child(div().absolute().left(0).right(0).top("50%").h(1).bg(color(t.border)));
    }

    return container
      .child(
        div()
          .absolute()
          .left(0)
          .top(0)
          .bottom(0)
          .w("50%")
          .child(this.renderSplitPane("old", t))
      )
      .child(
        div()
          .absolute()
          .left("50%")
          .right(0)
          .top(0)
          .bottom(0)
          .child(this.renderSplitPane("new", t))
      )
      .child(div().absolute().left("50%").top(0).bottom(0).w(1).bg(color(t.border)));
  }
  /** One label of the diff layout switcher. */
  diffViewButton(mode, label, tooltip, t, cx) {
    const active = this.diffView === mode;
    return div()
      .id(`diff-view-${mode}`)
      .px(7)
      .py(2)
      .rounded(4)
      .text_size(10)
      .cursor_pointer()
      .when(active, (e) => e.bg(color(t.selected)).text_color(color(t.foreground)))
      .when(!active, (e) => e.text_color(color(t.dim)))
      .hover((s) => s.bg(color(active ? t.selected : t.hover)))
      .tooltip(tooltip)
      .on_click((_e, cx) => this.setDiffView(mode, cx))
      .child(label);
  }

  /** The wrap toggle that sits beside the layout switcher. */
  diffWrapButton(t, cx) {
    const active = this.diffWrap;
    return div()
      .id("diff-wrap")
      .px(7)
      .py(2)
      .rounded(4)
      .text_size(10)
      .cursor_pointer()
      .when(active, (e) => e.bg(color(t.selected)).text_color(color(t.foreground)))
      .when(!active, (e) => e.text_color(color(t.dim)))
      .hover((s) => s.bg(color(active ? t.selected : t.hover)))
      .tooltip(active ? "Wrap long lines to the pane width" : "Scroll long lines horizontally instead of wrapping")
      .on_click((_e, cx) => this.setDiffWrap(!this.diffWrap, cx))
      .child("Wrap");
  }

  /** Records the view size; wrapping needs the current pane width. */
  updateSize(size, cx) {
    const w = size && typeof size.width === "number" ? Math.round(size.width) : 0;
    const h = size && typeof size.height === "number" ? Math.round(size.height) : 0;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      cx.notify();
    }
  }

  /** The full-size diff view a "Diff · <file>" tab renders. */
  renderDiffTab(cx) {
    const t = theme();
    const path = this.diffFile || "";
    const base = path.split("/").pop() || "Diff";
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const kind = this.diffKind === "commit" ? `commit ${(this.diffHash || "").slice(0, 7)}` : "working tree";
    const hasRows = this.diffRows.length > 0;

    return v_flex()
      .id("diff-tab")
      .size_full()
      .min_h(0)
      .bg(color(t.background))
      .text_color(color(t.foreground))
      .text_size(13)
      .on_size_change((size, cx) => this.updateSize(size, cx))
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(color(t.chrome))
          .border_b(1)
          .border_color(color(t.border))
          .child(svg("mods/git-graph/icons/file.svg").size(14).flex_none().text_color(color(t.muted)))
          .child(div().font_semibold().text_size(12.5).truncate().child(base))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(color(t.dim)).child(dir))
          .when(this.diffAdd > 0, (e) =>
            e.child(div().flex_none().text_size(10).text_color(color(t.ansi2)).child(`+${this.diffAdd}`))
          )
          .when(this.diffDel > 0, (e) =>
            e.child(div().flex_none().text_size(10).text_color(color(t.ansi1)).child(`−${this.diffDel}`))
          )
          .child(
            div()
              .flex_none()
              .px(6)
              .py(1)
              .rounded(4)
              .bg(color(t.raised))
              .text_size(10)
              .text_color(color(t.muted))
              .child(kind)
          )
          .child(
            h_flex()
              .flex_none()
              .items_center()
              .gap(2)
              .p(2)
              .rounded(6)
              .bg(color(t.raised))
              .child(this.diffViewButton("inline", "Inline", "Old and new lines stacked in one column", t, cx))
              .child(this.diffViewButton("split", "Split", "Old and new side by side", t, cx))
              .child(this.diffViewButton("stacked", "Stacked", "Old above new, both panes in sync", t, cx))
              .child(div().w(1).h(12).mx(2).bg(color(t.border)))
              .child(this.diffWrapButton(t, cx))
          )
          .child(
            h_flex()
              .id("diff-tab-copy")
              .flex_none()
              .p(4)
              .rounded(4)
              .cursor_pointer()
              .hover((s) => s.bg(color(t.hover)))
              .text_color(color(t.muted))
              .on_click((_e, cx) => {
                cx.write_to_clipboard(this.diffText ?? "");
                notify({ title: "Diff copied", body: base, level: "success", timeout: 1500 });
              })
              .child(svg("mods/git-graph/icons/copy.svg").size(12))
          )
          .child(
            h_flex()
              .id("diff-tab-refresh")
              .flex_none()
              .p(4)
              .rounded(4)
              .cursor_pointer()
              .hover((s) => s.bg(color(t.hover)))
              .text_color(color(t.accent))
              .on_click((_e, cx) => this.loadDiffTab(cx))
              .child(svg("mods/git-graph/icons/refresh.svg").size(12))
          )
      )
      .child(
        hasRows
          ? this.diffView === "inline"
            ? this.renderInlineDiff(t)
            : this.renderSplitDiff(t)
          : v_flex()
              .flex_1()
              .min_h(0)
              .p(24)
              .gap(8)
              .items_center()
              .justify_center()
              .child(
                div()
                  .max_w(620)
                  .text_size(12)
                  .text_color(color(t.dim))
                  .child(this.diffLoading ? "Loading diff…" : this.diffError || this.diffText || "No diff to show")
              )
      );
  }

  /**
   * Opens a file's diff in its own Herdr tab, so the editor gets the whole
   * pane instead of the small slice at the bottom of the graph.
   */
  openDiffTab(path, cx) {
    const c = this.selectedCommit;
    if (!c || !this.root) return;
    const kind = c.isWorkingTree ? "worktree" : "commit";
    const hash = kind === "commit" ? c.hash : null;
    const base = path.split("/").pop() || path;
    const suffix = kind === "commit" && c.shortHash ? ` (${c.shortHash})` : "";
    const name = `Diff · ${base}${suffix}`;

    this.selectedFile = path;
    const existing = (spaces().find((s) => s.active)?.tabs ?? []).find((tab) => tab.name === name && !tab.settled);
    if (existing) {
      run("tab.select", { id: existing.id });
      cx.notify();
      return;
    }

    /** @type {Record<string, any>} */
    const tabProps = { folder: this.root, diffFile: path, diffKind: kind };
    if (hash) tabProps.diffHash = hash;
    if (this.on) tabProps.on = this.on;
    run("tab.new", { name, mod: "git-graph", props: tabProps });
    cx.notify();
  }

  /**
   * Opens the full graph for this repository in its own tab. The docked panel
   * keeps the compact view; this gives the wide, multi-column one.
   */
  openGraphTab(cx) {
    const loc = this.getLocation();
    const folder = this.root || loc.cwd;
    if (!folder) {
      notify({ title: "No repository", body: "Open a folder inside a Git repository first.", level: "error" });
      return;
    }
    /** @type {Record<string, any>} */
    const tabProps = { folder };
    if (loc.on) tabProps.on = loc.on;
    run("tab.new", { name: "Git Graph", mod: "git-graph", props: tabProps });
    cx.notify();
  }

  getLocation() {
    return resolveLocation(this.manualRoot, this.root);
  }

  getKey() {
    const loc = this.getLocation();
    const effectiveRoot = computeEffectiveRoot(this.root, loc.cwd);
    return JSON.stringify({ root: effectiveRoot, on: loc.on });
  }

  isViewVisible() {
    const p = props();
    if (p?.panel) {
      const root = layout();
      return isLayoutNodeVisible(root, (n) => n?.id === "changes" || n?.content?.mod === "git-graph");
    }
    const space = spaces().find((s) => s.active);
    if (!space) return false;
    const activeTab = (space.tabs ?? []).find((t) => t.active);
    if (!activeTab) return false;
    const allPanes = panes();
    if (p?.pane) {
      const myPane = allPanes.find((pane) => pane.pane === p.pane);
      if (myPane) return myPane.tab === activeTab.id;
    }
    return allPanes.some((pane) => pane.tab === activeTab.id && pane.mod === "git-graph");
  }

  /**
   * Watches the repository root folder for filesystem changes and triggers refresh.
   * Uses a per-loop token to prevent orphaned loops from piling up across repo switches.
   *
   * @param {string} root
   * @param {import("./gpui-kit.js").Context} cx
   */
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const token = (this.watchToken = {});
    cx.spawn(async (cx) => {
      try {
        while (this.watchToken === token && this.watched === root) {
          await watchFolder(root);
          if (this.watchToken === token && this.watched === root) this.refresh(cx);
        }
      } catch {
        if (this.watchToken === token) {
          this.watched = null;
          this.watchToken = null;
        }
      }
    });
  }

  shouldShowWorkingTree() {
    if (!this.workingTreeFiles.length) return false;
    if (!this.searchQuery) return true;
    const q = this.searchQuery;
    return (
      "working tree".includes(q) ||
      "uncommitted changes".includes(q) ||
      "dirty".includes(q) ||
      this.workingTreeFiles.some((f) => f.path.toLowerCase().includes(q))
    );
  }

  /** Turns saved stashes into pseudo-commit rows for the table. */
  buildStashNodes() {
    const q = this.searchQuery;
    return this.stashes
      .map((st) => ({
        hash: st.hash,
        shortHash: st.hash.slice(0, 7),
        isStash: true,
        stashRef: st.ref,
        stashHash: st.hash,
        baseHash: st.baseHash,
        parents: [],
        subject: st.subject,
        author: st.author,
        email: st.email,
        timestamp: st.timestamp,
        refs: [{ kind: "stash", text: st.ref }],
        // Standalone row: no lane edges into the DAG.
        lane: 0,
        colorIdx: 0,
        edgesUp: [],
        edgesDown: [],
        parentConnections: [],
        maxLaneAtRow: 0,
      }))
      .filter(
        (node) =>
          !q ||
          "stash".includes(q) ||
          "stashes".includes(q) ||
          node.stashRef.toLowerCase().includes(q) ||
          node.subject.toLowerCase().includes(q)
      );
  }

  applyFilter() {
    let matched = this.commits;
    if (this.searchQuery) {
      const q = this.searchQuery;
      matched = this.commits.filter(
        (c) =>
          c.subject.toLowerCase().includes(q) ||
          c.author.toLowerCase().includes(q) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          c.hash.toLowerCase().includes(q) ||
          c.refs.some((r) => r.text.toLowerCase().includes(q))
      );
    }
    this.filteredCommits = matched;
    this.stashNodes = this.buildStashNodes();

    // Q4: If working tree is active, prepend virtual WT node with HEAD commit as parent
    const laneItems = [];
    if (this.shouldShowWorkingTree()) {
      const headCommit = this.commits.find((c) => c.isHead);
      const headHash = headCommit ? headCommit.hash : (this.commits[0]?.hash ?? null);
      this.workingTreeNode = {
        hash: "__WORKING_TREE__",
        isWorkingTree: true,
        parents: headHash ? [headHash] : [],
        subject: `Working Tree · ${this.workingTreeFiles.length} uncommitted file${this.workingTreeFiles.length === 1 ? "" : "s"}`,
        author: "Local Workspace",
        email: "local",
        timestamp: Math.floor(Date.now() / 1000),
        shortHash: "Unsaved",
        refs: [],
      };
      laneItems.push(this.workingTreeNode);
    } else {
      this.workingTreeNode = null;
    }
    this.maxLane = computeLanes([...laneItems, ...matched]);
  }

  getVisibleItems() {
    /** @type {Array<any>} */
    const items = [];
    for (const stash of this.stashNodes) {
      items.push(stash);
    }
    if (this.shouldShowWorkingTree() && this.workingTreeNode) {
      items.push(this.workingTreeNode);
    }
    for (const c of this.filteredCommits) {
      items.push(c);
    }
    return items;
  }

  refresh(cx) {
    if (this.loading) {
      this.pendingRefresh = true;
      return;
    }
    const { cwd, on } = this.getLocation();
    const context = this.getKey();

    if (context !== this.context) {
      this.context = context;
    }
    if (!cwd) return;

    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (this.getKey() !== context) return;
        if (top.code !== 0) {
          this.root = null;
          this.commits = [];
          this.filteredCommits = [];
          this.workingTreeFiles = [];
          this.selectedCommit = null;
          this.commitDetails = null;
          this.commitFiles = [];
          this.selectedFile = null;
          this.error = "Not a git repository";
          this.upstream = null;
          this.remotes = [];
          this.ahead = 0;
          this.behind = 0;
          this.detached = false;
          this.stashes = [];
          this.stashNodes = [];
          this.stagedCount = 0;
          return;
        }
        const root = top.stdout.trim();
        if (this.root && root !== this.root) {
          // Switched to a DIFFERENT repository!
          this.root = root;
          this.commits = [];
          this.filteredCommits = [];
          this.workingTreeFiles = [];
          this.selectedCommit = null;
          this.commitDetails = null;
          this.commitFiles = [];
          this.selectedFile = null;
          this.watched = null;
          this.watchToken = null;
          this.contextMenu = null;
          this.modalDialog = null;
          this.upstream = null;
          this.remotes = [];
          this.ahead = 0;
          this.behind = 0;
          this.detached = false;
          this.stashes = [];
          this.stashNodes = [];
          this.stagedCount = 0;
          cx.notify();
        }
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });

        // Check in-progress operations
        const op = await detectInProgress(root, on);

        // Branch & HEAD check
        const branchRes = await git(["branch", "--show-current"]);
        const branchName = branchRes.code === 0 ? branchRes.stdout.trim() : "";
        let currentBranch = branchName;
        const headRes = await git(["rev-parse", "--verify", "HEAD"]);
        const hasHead = headRes.code === 0;
        const detached = hasHead && !branchName;

        if (!currentBranch) {
          if (hasHead) {
            const shortHead = await git(["rev-parse", "--short", "HEAD"]);
            currentBranch = shortHead.code === 0 ? shortHead.stdout.trim() : "HEAD";
          } else {
            currentBranch = "main (unborn)";
          }
        }

        // Available local and remote branches
        const branchesRes = await git(["branch", "--list", "--all", "--format=%(refname:short)"]);
        const availableBranches = [];
        if (branchesRes.code === 0 && branchesRes.stdout) {
          for (const b of branchesRes.stdout.split("\n")) {
            const trimmed = b.trim();
            if (trimmed && !trimmed.endsWith("/HEAD") && trimmed !== "HEAD") {
              availableBranches.push(trimmed);
            }
          }
        }

        // Upstream tracking state (ahead / behind) and configured remotes.
        // These drive the fetch, pull and push buttons in the toolbar.
        const remotesRes = await git(["remote"]);
        const remotes =
          remotesRes.code === 0
            ? remotesRes.stdout
                .split("\n")
                .map((r) => r.trim())
                .filter(Boolean)
            : [];
        let upstream = null;
        let ahead = 0;
        let behind = 0;
        if (hasHead) {
          const upstreamRes = await git([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
          ]);
          if (upstreamRes.code === 0 && upstreamRes.stdout.trim()) {
            upstream = upstreamRes.stdout.trim();
            const countsRes = await git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
            if (countsRes.code === 0 && countsRes.stdout.trim()) {
              const [a, b] = countsRes.stdout.trim().split(/\s+/);
              ahead = Number(a) || 0;
              behind = Number(b) || 0;
            }
          }
        }

        // Stash entries become their own rows. `%gs` is the reflog subject
        // (the custom message, or "WIP on <branch>: …").
        const stashRes = await git([
          "stash",
          "list",
          "--format=%gd%x1f%H%x1f%P%x1f%gs%x1f%at%x1f%an%x1f%ae",
        ]);
        const stashes = [];
        if (stashRes.code === 0 && stashRes.stdout) {
          for (const line of stashRes.stdout.split("\n")) {
            if (!line) continue;
            const [ref, hash, parentStr, subject, at, author, email] = line.split("\x1f");
            const stashRef = (ref || "").trim();
            if (!stashRef || !hash) continue;
            stashes.push({
              ref: stashRef,
              hash: hash.trim(),
              baseHash: (parentStr || "").trim().split(" ").filter(Boolean)[0] || null,
              subject: (subject || "").trim() || stashRef,
              timestamp: Number(at) || 0,
              author: (author || "").trim() || "Stash",
              email: (email || "").trim(),
            });
          }
        }

        // Working tree status & numstat
        const wtFiles = [];
        let stagedCount = 0;
        const statusRes = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (statusRes.code === 0 && statusRes.stdout) {
          const stats = {};
          const diffResults = hasHead
            ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
            : [
                await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
                await git(["diff", "--numstat", "-z", "--no-renames"]),
              ];

          for (const res of diffResults) {
            if (res.code === 0 && res.stdout) {
              const entries = res.stdout.split("\0");
              for (const entry of entries) {
                if (!entry) continue;
                const parts = entry.split("\t");
                if (parts.length < 3) continue;
                const [add, del, ...pParts] = parts;
                const filePath = pParts.join("\t");
                const old = stats[filePath] ?? { add: 0, del: 0, binary: false };
                stats[filePath] = {
                  add: old.add + (Number(add) || 0),
                  del: old.del + (Number(del) || 0),
                  binary: add === "-",
                };
              }
            }
          }

          const statusEntries = statusRes.stdout.split("\0").filter(Boolean);
          for (const entry of statusEntries.slice(0, 1000)) {
            const xy = entry.slice(0, 2);
            const filePath = entry.slice(3);
            const fresh = xy === "??";
            const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
            if (!conflict && xy[0] !== " " && xy[0] !== "?") stagedCount++;
            const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
            const stat = stats[filePath] ?? { add: 0, del: 0, binary: false };
            wtFiles.push({ path: filePath, status: s, fresh, ...stat });
          }

          // Untracked files have no numstat entry. Count their lines so the
          // tree can show the same +N next to the file name.
          const freshPaths = wtFiles.filter((f) => f.fresh).map((f) => f.path);
          if (freshPaths.length) {
            const wcRes = await exec("wc", ["-l", "--", ...freshPaths], { cwd: root, on });
            if (wcRes.code === 0 && wcRes.stdout) {
              const counts = {};
              for (const line of wcRes.stdout.split("\n")) {
                const m = /^\s*(\d+)\s+(.*)$/.exec(line);
                if (m) counts[m[2]] = Number(m[1]) || 0;
              }
              for (const f of wtFiles) {
                if (f.fresh && counts[f.path] !== undefined) {
                  f.add = counts[f.path];
                  f.binary = false;
                }
              }
            }
          }
        }

        // In-progress operation state
        if (op) {
          const conflictCount = wtFiles.filter((f) => f.status === "U").length;
          this.inProgressOp = { type: op, conflicts: conflictCount };
        } else {
          this.inProgressOp = null;
        }

        // Commit Log Parsing using --decorate=full and Unit Separator %x1f
        const commits = [];
        let logError = null;
        if (hasHead) {
          const args = logArgs(this.branchFilter, this.commitLimit);
          const logRes = await git(args);
          if (logRes.code === 0 && logRes.stdout.trim()) {
            const rawLines = logRes.stdout.trim().split("\n").filter(Boolean);
            for (const line of rawLines) {
              const parts = line.split("\x1f");
              if (parts.length < 7) continue;
              const [hash, parentStr, author, email, timestamp, refStr, ...subjectParts] = parts;
              const subject = subjectParts.join("\x1f");
              const parents = parentStr ? parentStr.trim().split(" ").filter(Boolean) : [];
              const refs = parseRefs(refStr);
              commits.push({
                hash,
                shortHash: hash.slice(0, 7),
                parents,
                author,
                email,
                timestamp: parseInt(timestamp, 10) || 0,
                subject,
                refs,
                isHead: refs.some((r) => r.kind === "head"),
              });
            }
          } else if (logRes.code !== 0) {
            logError = logRes.stderr?.trim() || `git log failed with code ${logRes.code}`;
          }
        }

        this.root = root;
        this.context = this.getKey();
        this.on = on;
        this.hasHead = hasHead;
        this.currentBranch = currentBranch;
        this.availableBranches = availableBranches;
        this.upstream = upstream;
        this.remotes = remotes;
        this.ahead = ahead;
        this.behind = behind;
        this.detached = detached;
        this.workingTreeFiles = wtFiles;
        this.stagedCount = stagedCount;
        this.stashes = stashes;
        this.commits = commits;
        this.error = logError;
        this.applyFilter();

        // Maintain selection across refreshes
        if (this.selectedCommit) {
          if (this.selectedCommit.isWorkingTree) {
            if (this.workingTreeFiles.length > 0) {
              // Update working tree files in place without clearing selection
              this.selectedCommit.subject = `Working Tree · ${this.workingTreeFiles.length} uncommitted file${this.workingTreeFiles.length === 1 ? "" : "s"}`;
              this.commitFiles = this.workingTreeFiles;
              if (this.selectedFile) {
                const stillExists = this.workingTreeFiles.some((f) => f.path === this.selectedFile);
                if (!stillExists) {
                  this.selectedFile = null;
                }
              }
            } else {
              this.clearSelection(cx);
            }
          } else {
            const stillThere =
              this.commits.find((c) => c.hash === this.selectedCommit.hash) ||
              this.stashNodes.find((c) => c.hash === this.selectedCommit.hash);
            if (stillThere) {
              this.selectedCommit = stillThere;
            } else if (this.workingTreeFiles.length > 0) {
              this.selectWorkingTree(cx);
            } else if (this.commits.length > 0) {
              this.selectCommit(this.commits[0], cx);
            } else {
              this.clearSelection(cx);
            }
          }
        } else if (this.workingTreeFiles.length > 0) {
          this.selectWorkingTree(cx);
        } else if (this.commits.length > 0) {
          this.selectCommit(this.commits[0], cx);
        }

        const p = props();
        const preview = p?.preview;
        if (preview === "branch-menu" || preview === "dropdown" || p?.openBranchDropdown) {
          this.branchDropdownOpen = true;
        } else if ((preview === "context-menu" || p?.openContextMenu) && this.commits.length > 0) {
          this.contextMenu = { type: "commit", commit: this.commits[0], x: 180, y: 100 };
        } else if ((preview === "branch-context-menu" || p?.openBranchContextMenu) && this.commits.length > 0) {
          const branchName =
            this.availableBranches.find((b) => b !== this.currentBranch) ||
            this.currentBranch ||
            this.availableBranches[0] ||
            "my-test-branch";
          this.contextMenu = {
            type: "branch",
            ref: { kind: this.branchRefKind(branchName), text: branchName },
            x: 180,
            y: 70,
          };
        } else if (preview === "modal-merge-branch" && this.commits.length > 0) {
          const branchName =
            this.availableBranches.find((b) => b !== this.currentBranch) ||
            this.currentBranch ||
            "my-test-branch";
          this.openModal("confirm-merge-branch", { ref: { kind: this.branchRefKind(branchName), text: branchName } }, cx);
        } else if (preview === "modal-branch" && this.commits.length > 0) {
          this.openModal("branch", this.commits[0], cx);
        } else if (preview === "modal-tag" && this.commits.length > 0) {
          this.openModal("tag", this.commits[0], cx);
        } else if (preview === "modal-reset" && this.commits.length > 0) {
          this.openModal("reset", this.commits[0], cx);
        } else if (preview === "modal-clean-model") {
          this.openCleanAgentModelPicker(
            cx,
            null,
            typeof p?.previewProvider === "string" ? p.previewProvider : null
          );
        } else if ((preview === "confirm-merge" || preview === "modal-confirm") && this.commits.length > 0) {
          this.openModal("confirm-merge", this.commits[0], cx);
        } else if (preview === "file-diff" && this.workingTreeFiles.length > 0) {
          this.selectWorkingTree(cx);
          this.selectedFile = this.workingTreeFiles[0].path;
        } else if (p?.openModal && this.commits.length > 0) {
          this.openModal(p.openModal, this.commits[0], cx);
        }

        this.watch(root, cx);
      } catch (err) {
        if (this.getKey() === context || this.context === context) {
          this.error = err instanceof Error ? err.message : String(err);
        }
      } finally {
        this.loading = false;
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          this.refresh(cx);
        } else {
          cx.notify();
        }
      }
    });
  }

  /** Human label for a remote action. */
  remoteLabel(kind) {
    return kind === "fetch" ? "Fetch" : kind === "pull" ? "Pull" : "Push";
  }

  /** Remote used when pushing a branch that has no upstream yet. */
  pushRemote() {
    return this.remotes.includes("origin") ? "origin" : this.remotes[0] || null;
  }

  /** Repository name suggested for a new GitHub repo: the folder name, sanitized. */
  suggestRepoName() {
    const root = (this.root || "").replace(/[\\/]+$/, "");
    const base = root.split(/[\\/]/).pop() || "repository";
    const cleaned = base
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
    return cleaned || "repository";
  }

  /**
   * Push requested with no remotes: publish the repository to GitHub instead.
   * `gh` must exist and be authenticated; the create form opens only then.
   */
  startPublishFlow(cx) {
    if (!this.root || this.busy || this.remoteAction) return;
    const root = this.root;
    const on = this.on;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      // The toolbar can render before the first refresh finishes; confirm with
      // git before offering to create a repository that may already exist.
      let remotes = [];
      try {
        const remotesRes = await exec("git", [...READ, "remote"], { cwd: root, on });
        if (remotesRes.code === 0) {
          remotes = remotesRes.stdout
            .split("\n")
            .map((r) => r.trim())
            .filter(Boolean);
        }
      } catch {
        // Git failed unexpectedly; fall through to the GitHub CLI check.
      }

      let auth = null;
      let available = false;
      if (!remotes.length) {
        try {
          auth = await exec("gh", ["auth", "status"], { cwd: root, on });
          available = true;
        } catch {
          // `gh` is not installed (or cannot start on this machine).
        }
      }

      this.busy = false;
      if (remotes.length) {
        this.remotes = remotes;
        this.runRemoteAction("push", cx);
        return;
      }
      if (!available) {
        notify({
          title: "GitHub CLI not found",
          body: "Install gh (https://cli.github.com) to publish this repository, or add a remote manually.",
          level: "error",
        });
        cx.notify();
        return;
      }
      if (auth.code !== 0) {
        notify({
          title: "Not signed in to GitHub",
          body: 'Run "gh auth login" in a terminal, then push again.',
          level: "error",
        });
        cx.notify();
        return;
      }
      const account = /account\s+(\S+)/i.exec(`${auth.stdout}\n${auth.stderr}`)?.[1] || null;
      this.openModal("publish", { account }, cx);
    });
  }

  /** Runs `git fetch`, `git pull` or `git push` for the current repository. */
  runRemoteAction(kind, cx) {
    if (!this.root || this.busy || this.remoteAction) return;
    if (kind === "pull" && !this.upstream) {
      notify({
        title: "Nothing to pull",
        body: "The current branch has no upstream. Push it first to set one.",
        level: "error",
      });
      return;
    }
    if (kind === "push" && !this.hasHead) {
      notify({ title: "Nothing to push", body: "This repository has no commits yet.", level: "error" });
      return;
    }
    if (kind === "push" && this.detached) {
      notify({ title: "Cannot push", body: "HEAD is detached. Check out a branch first.", level: "error" });
      return;
    }
    if (kind === "fetch" && !this.remotes.length) {
      notify({ title: "No remote", body: "Add a git remote before fetching.", level: "error" });
      return;
    }
    if (kind === "push" && !this.remotes.length) {
      this.startPublishFlow(cx);
      return;
    }

    const label = this.remoteLabel(kind);
    const root = this.root;
    const on = this.on;
    const branch = this.currentBranch;
    const upstream = this.upstream;
    const remotes = this.remotes.slice();
    const pushRemote = this.pushRemote();

    this.remoteAction = kind;
    cx.notify();

    cx.spawn(async (cx) => {
      let ok = false;
      let body = "";
      let target = upstream;
      try {
        let args;
        if (kind === "fetch") {
          args = [...NETWORK, "fetch", "--all", "--prune"];
          target = remotes.length === 1 ? remotes[0] : `${remotes.length} remotes`;
        } else if (kind === "pull") {
          args = [...NETWORK, "pull", "--no-edit"];
        } else if (upstream) {
          args = [...NETWORK, "push"];
        } else {
          args = [...NETWORK, "push", "--set-upstream", "--end-of-options", pushRemote, branch];
          target = `${pushRemote}/${branch}`;
        }

        const r = await exec("git", args, { cwd: root, on });
        ok = r.code === 0;
        if (ok) {
          body =
            kind === "fetch"
              ? `Updated remote refs from ${target}.`
              : kind === "pull"
                ? `Updated ${branch} from ${target}.`
                : upstream
                  ? `Pushed ${branch} to ${target}.`
                  : `Pushed ${branch} and set upstream to ${target}.`;
        } else {
          const detail = (r.stderr || r.stdout).trim() || `git exited with code ${r.code}`;
          body = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
        }
      } catch (err) {
        body = err instanceof Error ? err.message : String(err);
      } finally {
        this.remoteAction = null;
        notify({
          title: `${label} ${ok ? "complete" : "failed"}`,
          body,
          level: ok ? "success" : "error",
          ...(ok ? { timeout: 2000 } : {}),
        });
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  openFolder(cx) {
    cx.spawn(async (cx) => {
      const picked = await pickFolder({ prompt: "Select a Git repository" });
      if (picked) {
        this.manualRoot = picked;
        this.context = this.getKey();
        this.root = picked;
        this.refresh(cx);
      }
    });
  }

  setBranchFilter(branch, cx) {
    this.branchFilter = branch;
    this.branchDropdownOpen = false;
    this.refresh(cx);
  }

  setSearch(query, cx) {
    this.searchQuery = (query || "").toLowerCase().trim();
    this.searchInput?.set_value(query || "");
    this.searchOpen = Boolean(query);
    this.applyFilter();
    if (cx) cx.notify();
  }

  clearSearch(cx) {
    this.searchQuery = "";
    this.searchInput?.set_value("");
    this.searchOpen = false;
    this.applyFilter();
    if (cx) cx.notify();
  }

  clearSelection(cx) {
    this.selectedCommit = null;
    this.commitDetails = null;
    this.commitFiles = [];
    this.selectedFile = null;
    this.collapsedFolders.clear();
    if (cx) cx.notify();
  }

  selectWorkingTree(cx) {
    this.selectedCommit = {
      hash: "__WORKING_TREE__",
      isWorkingTree: true,
      subject: `Working Tree · ${this.workingTreeFiles.length} uncommitted file${this.workingTreeFiles.length === 1 ? "" : "s"}`,
      author: "Local Workspace",
      email: "local",
      timestamp: Math.floor(Date.now() / 1000),
      shortHash: "Unsaved",
      refs: [],
    };
    this.commitDetails = {
      fullMessage: "Uncommitted changes in local working tree",
    };
    this.commitFiles = this.workingTreeFiles;
    this.selectedFile = null;
    this.collapsedFolders.clear();
    cx.notify();
  }

  selectCommit(commit, cx) {
    if (this.selectedCommit?.hash === commit.hash && !this.selectedCommit.isWorkingTree) {
      return;
    }
    this.selectedCommit = commit;
    this.commitDetails = null;
    this.commitFiles = [];
    this.selectedFile = null;
    this.collapsedFolders.clear();
    cx.notify();

    const root = this.root,
      on = this.on,
      hash = commit.hash;
    cx.spawn(async (cx) => {
      try {
        const [showRes, numRes, nameStatusRes] = await Promise.all([
          exec("git", [...READ, "show", "-s", "--format=%B", hash], { cwd: root, on }),
          exec("git", [...READ, "show", "-m", "--first-parent", "--root", "--numstat", "-z", "--no-renames", "--format=", hash], {
            cwd: root,
            on,
          }),
          exec("git", [...READ, "show", "-m", "--first-parent", "--root", "--name-status", "-z", "--no-renames", "--format=", hash], {
            cwd: root,
            on,
          }),
        ]);

        const fullMessage = showRes.code === 0 ? showRes.stdout.trim() : commit.subject;

        const statusMap = {};
        if (nameStatusRes.code === 0 && nameStatusRes.stdout) {
          const parts = nameStatusRes.stdout.split("\0");
          let i = 0;
          while (i < parts.length) {
            const code = parts[i++];
            if (!code) continue;
            const path = parts[i++];
            if (path) statusMap[path] = code[0];
          }
        }

        const files = [];
        if (numRes.code === 0 && numRes.stdout) {
          const entries = numRes.stdout.split("\0");
          for (const entry of entries) {
            if (!entry) continue;
            const parts = entry.split("\t");
            if (parts.length < 3) continue;
            const [add, del, ...pathParts] = parts;
            const path = pathParts.join("\t");
            const s = statusMap[path] || (add === "-" ? "M" : "M");
            files.push({
              path,
              status: s,
              add: Number(add) || 0,
              del: Number(del) || 0,
              binary: add === "-",
            });
          }
        }

        if (this.selectedCommit?.hash === hash) {
          this.commitDetails = { fullMessage };
          this.commitFiles = files;
        }
      } catch {
        if (this.selectedCommit?.hash === hash) {
          this.commitDetails = { fullMessage: commit.subject };
          this.commitFiles = [];
        }
      } finally {
        cx.notify();
      }
    });
  }

  toggleFolder(path, cx) {
    if (this.collapsedFolders.has(path)) {
      this.collapsedFolders.delete(path);
    } else {
      this.collapsedFolders.add(path);
    }
    cx.notify();
  }

  openCommitContextMenu(commit, e, cx, overrideX, overrideY) {
    const menuWidth = 240;
    const menuHeight = 310;
    const origin = this.rootOrigin;
    const b = /** @type {any} */ (this.rootBounds);
    let x = overrideX != null ? overrideX : origin ? e?.position?.x - origin.x : b ? e?.position?.x - b.x : (e?.bounds ? e.position.x - e.bounds.x : (e?.local_position?.x ?? 120));
    let y = overrideY != null ? overrideY : origin ? e?.position?.y - origin.y : b ? e?.position?.y - b.y : (e?.local_position?.y ?? 120);

    const maxW = this.width || b?.width || 600;
    const maxH = this.height || b?.height || 600;
    if (x + menuWidth > maxW) {
      x = Math.max(10, maxW - menuWidth - 10);
    }
    if (y + menuHeight > maxH) {
      y = Math.max(10, maxH - menuHeight - 10);
    }
    this.contextMenu = { type: "commit", commit, x, y };
    cx.notify();
  }

  /** Classify a `git branch --all` name as a remote-tracking ref. */
  branchRefKind(name) {
    return this.remotes.some((remote) => name.startsWith(`${remote}/`)) ? "remote" : "local";
  }

  openBranchContextMenu(ref, e, cx, overrideX, overrideY) {
    const normRef = typeof ref === "string" ? { kind: this.branchRefKind(ref), text: ref } : ref;
    const menuWidth = 260;
    const menuHeight = 180;
    const origin = this.rootOrigin;
    const b = /** @type {any} */ (this.rootBounds);
    let x = overrideX != null ? overrideX : origin ? e?.position?.x - origin.x : b ? e?.position?.x - b.x : (e?.bounds ? e.position.x - e.bounds.x : (e?.local_position?.x ?? 120));
    let y = overrideY != null ? overrideY : origin ? e?.position?.y - origin.y : b ? e?.position?.y - b.y : (e?.local_position?.y ?? 120);

    const maxW = this.width || b?.width || 600;
    const maxH = this.height || b?.height || 600;
    if (x + menuWidth > maxW) {
      x = Math.max(10, maxW - menuWidth - 10);
    }
    if (y + menuHeight > maxH) {
      y = Math.max(10, maxH - menuHeight - 10);
    }
    this.contextMenu = { type: "branch", ref: normRef, x, y };
    cx.notify();
  }

  /** Right-click menu for a saved stash row. */
  openStashContextMenu(stash, e, cx, overrideX, overrideY) {
    const menuWidth = 240;
    const menuHeight = 190;
    const origin = this.rootOrigin;
    const b = /** @type {any} */ (this.rootBounds);
    let x = overrideX != null ? overrideX : origin ? e?.position?.x - origin.x : b ? e?.position?.x - b.x : (e?.bounds ? e.position.x - e.bounds.x : (e?.local_position?.x ?? 120));
    let y = overrideY != null ? overrideY : origin ? e?.position?.y - origin.y : b ? e?.position?.y - b.y : (e?.local_position?.y ?? 120);

    const maxW = this.width || b?.width || 600;
    const maxH = this.height || b?.height || 600;
    if (x + menuWidth > maxW) {
      x = Math.max(10, maxW - menuWidth - 10);
    }
    if (y + menuHeight > maxH) {
      y = Math.max(10, maxH - menuHeight - 10);
    }
    this.contextMenu = { type: "stash", stash, x, y };
    cx.notify();
  }

  /** Right-click menu for the Working Tree row: stash and restore changes. */
  openWorkingTreeContextMenu(e, cx, overrideX, overrideY) {
    const menuWidth = 260;
    const menuHeight = 190;
    const origin = this.rootOrigin;
    const b = /** @type {any} */ (this.rootBounds);
    let x = overrideX != null ? overrideX : origin ? e?.position?.x - origin.x : b ? e?.position?.x - b.x : (e?.bounds ? e.position.x - e.bounds.x : (e?.local_position?.x ?? 120));
    let y = overrideY != null ? overrideY : origin ? e?.position?.y - origin.y : b ? e?.position?.y - b.y : (e?.local_position?.y ?? 120);

    const maxW = this.width || b?.width || 600;
    const maxH = this.height || b?.height || 600;
    if (x + menuWidth > maxW) {
      x = Math.max(10, maxW - menuWidth - 10);
    }
    if (y + menuHeight > maxH) {
      y = Math.max(10, maxH - menuHeight - 10);
    }
    this.contextMenu = { type: "working-tree", x, y };
    cx.notify();
  }

  closeContextMenu(cx) {
    if (this.contextMenu) {
      this.contextMenu = null;
      if (cx) cx.notify();
    }
  }

  /** Focus a modal input now and again over the next few frames. */
  focusModalInput(cx) {
    this.modalInput?.focus();
    if (cx?.timer?.after) {
      cx.timer.after(60, () => this.modalInput?.focus());
      cx.timer.after(180, () => this.modalInput?.focus());
      cx.timer.after(500, () => this.modalInput?.focus());
    }
  }

  openModal(type, target, cx) {
    this.closeContextMenu();
    if (type === "branch") {
      this.modalDialog = { type, commit: target, checkoutAfterCreate: true, error: null };
      this.modalInput = InputState.new({ placeholder: "Branch name (e.g. feat/new-feature)" });
      this.modalInput.on("change", (_e, cx) => {
        if (this.modalDialog?.error) {
          this.modalDialog.error = null;
        }
        cx.notify();
      });
      this.modalInput.on("submit", (_e, cx) => this.submitModal(cx));
      this.focusModalInput(cx);
    } else if (type === "tag") {
      this.modalDialog = { type, commit: target, error: null };
      this.modalInput = InputState.new({ placeholder: "Tag name (e.g. v1.0.0)" });
      this.modalTagMessageInput = InputState.new({ placeholder: "Tag message (optional)" });
      this.modalInput.on("change", (_e, cx) => {
        if (this.modalDialog?.error) {
          this.modalDialog.error = null;
        }
        cx.notify();
      });
      this.modalInput.on("submit", (_e, cx) => this.submitModal(cx));
      this.focusModalInput(cx);
    } else if (type === "publish") {
      const suggested = this.suggestRepoName();
      this.modalDialog = {
        type,
        visibility: "private",
        account: target?.account || null,
        error: null,
      };
      this.modalInput = InputState.new({ placeholder: "Repository name", value: suggested });
      this.modalInput.on("change", (_e, cx) => {
        if (this.modalDialog?.error) {
          this.modalDialog.error = null;
        }
        cx.notify();
      });
      this.modalInput.on("submit", (_e, cx) => this.submitModal(cx));
      this.focusModalInput(cx);
    } else if (type === "stash") {
      this.modalDialog = {
        type,
        stashStaged: Boolean(target?.staged),
        includeUntracked: true,
        error: null,
      };
      this.modalInput = InputState.new({ placeholder: "Stash message (optional)" });
      this.modalInput.on("change", (_e, cx) => {
        if (this.modalDialog?.error) {
          this.modalDialog.error = null;
        }
        cx.notify();
      });
      this.modalInput.on("submit", (_e, cx) => this.submitModal(cx));
      this.focusModalInput(cx);
    } else if (type === "unstash" || type === "drop-stash") {
      this.modalDialog = {
        type,
        stashRef: target?.stashRef || target?.ref || "stash@{0}",
        stashSubject: target?.subject || "",
        error: null,
      };
      this.modalInput = null;
    } else if (type === "reset") {
      this.modalDialog = { type, commit: target, resetMode: "mixed", error: null };
      this.modalInput = null;
    } else if (type === "confirm-merge-branch") {
      this.modalDialog = { type, ref: target?.ref || target, error: null };
      this.modalInput = null;
    } else if (type.startsWith("confirm-")) {
      this.modalDialog = { type, commit: target?.commit || target, ref: target?.ref, error: null };
      this.modalInput = null;
    } else {
      this.modalDialog = null;
      this.modalInput = null;
    }
    cx.notify();
  }

  closeModal(cx) {
    this.modalDialog = null;
    this.modalInput = null;
    this.modalTagMessageInput = null;
    this.handle.focus();
    if (cx) cx.notify();
  }

  submitModal(cx) {
    if (!this.modalDialog || this.busy) return;
    const dialog = this.modalDialog;
    const { type, commit, ref } = dialog;
    const root = this.root;
    const on = this.on;
    const branchName = this.currentBranch;

    // Choosing a model is a local preference change, not a git mutation.
    if (type === "clean-model") {
      const chosen = dialog.selected;
      if (!chosen) {
        dialog.error = "Choose a model first";
        cx.notify();
        return;
      }
      setShared(CLEAN_AGENT_MODEL_KEY, chosen);
      this.treeAgentModel = chosen;
      this.closeModal(cx);
      if (this.workingTreeFiles.length || this.inProgressOp) {
        this.startTreeAgent(cx, chosen);
      } else {
        notify({
          title: "AI model saved",
          body: `${cleanModelLabel(chosen)} will clean the next dirty tree.`,
          level: "success",
        });
      }
      return;
    }

    // The handler's Context is valid only until it returns, so the name is
    // read and checked synchronously; everything after the first await runs
    // in a spawned task with an AsyncContext.
    let name = null;
    let stashMessage = null;
    if (type === "branch" || type === "tag" || type === "publish") {
      name = this.modalInput?.value().trim();
      const what = type === "branch" ? "Branch" : type === "tag" ? "Tag" : "Repository";
      if (!name) {
        dialog.error = `${what} name cannot be empty`;
        cx.notify();
        return;
      }
      if (name.startsWith("-") || name.startsWith("/")) {
        dialog.error = `${what} name cannot start with '-' or '/'`;
        cx.notify();
        return;
      }
      if (type === "publish" && !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(name)) {
        dialog.error = "Use letters, digits, dots, dashes, underscores, or owner/name";
        cx.notify();
        return;
      }
    }
    if (type === "stash") {
      stashMessage = this.modalInput?.value().trim() || "";
      if (dialog.stashStaged && this.stagedCount === 0) {
        dialog.error = "There are no staged changes to stash.";
        cx.notify();
        return;
      }
    }
    if (type === "publish" && (!this.hasHead || this.detached)) {
      dialog.error = this.hasHead ? "Cannot push from a detached HEAD" : "This repository has no commits yet";
      cx.notify();
      return;
    }
    if (type === "confirm-merge-branch" && !ref?.text) {
      dialog.error = "No branch selected";
      cx.notify();
      return;
    }

    this.busy = true;
    cx.notify();

    cx.spawn(async (cx) => {
      /** Only touch the dialog if it is still the one this task started on. */
      const fail = (message) => {
        if (this.modalDialog === dialog) dialog.error = message;
      };
      try {
        if (type === "branch") {
          const val = await exec("git", ["check-ref-format", "--branch", name], { cwd: root, on });
          if (val.code !== 0) {
            fail(`'${name}' is not a valid branch name`);
            return;
          }
          const doCheckout = Boolean(dialog.checkoutAfterCreate);
          const r = await exec("git", [...NON_INTERACTIVE, "branch", "--end-of-options", name, commit.hash], { cwd: root, on });
          if (r.code === 0) {
            if (doCheckout) {
              await exec("git", [...NON_INTERACTIVE, "checkout", "--end-of-options", name], { cwd: root, on });
            }
            this.closeModal(cx);
            notify({ title: "Branch created", body: `Created '${name}' at ${commit.shortHash}`, level: "success" });
            this.refresh(cx);
          } else {
            fail((r.stderr || r.stdout).trim() || "Failed to create branch");
          }
        } else if (type === "tag") {
          const val = await exec("git", ["check-ref-format", `refs/tags/${name}`], { cwd: root, on });
          if (val.code !== 0) {
            fail(`'${name}' is not a valid tag name`);
            return;
          }
          const msg = this.modalTagMessageInput?.value().trim();
          const r = await exec("git", [...NON_INTERACTIVE, ...tagArgs(name, msg, commit.hash)], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Tag added", body: `Created tag '${name}' at ${commit.shortHash}`, level: "success" });
            this.refresh(cx);
          } else {
            fail((r.stderr || r.stdout).trim() || "Failed to add tag");
          }
        } else if (type === "publish") {
          const visibility = dialog.visibility === "public" ? "--public" : "--private";
          const create = await exec(
            "gh",
            ["repo", "create", name, "--source", root, "--remote", "origin", visibility],
            { cwd: root, on }
          );
          if (create.code !== 0) {
            const detail = (create.stderr || create.stdout).trim();
            fail(detail.length > 800 ? `${detail.slice(0, 800)}…` : detail || "gh repo create failed");
            return;
          }

          const url =
            create.stdout
              .split("\n")
              .map((line) => line.trim())
              .find((line) => line.startsWith("http")) || null;
          this.remotes = ["origin"];
          const push = await exec(
            "git",
            [...NETWORK, "push", "--set-upstream", "--end-of-options", "origin", branchName],
            { cwd: root, on }
          );
          if (push.code !== 0) {
            this.closeModal(cx);
            notify({
              title: "Repository created, push failed",
              body: (push.stderr || push.stdout).trim().slice(0, 600) || "git push failed",
              level: "error",
            });
            this.refresh(cx);
            return;
          }
          this.closeModal(cx);
          notify({
            title: "Published to GitHub",
            body: `Created ${url || name} and pushed '${branchName}'.`,
            level: "success",
            timeout: url ? 6000 : 2500,
          });
          this.refresh(cx);
        } else if (type === "stash") {
          const args = [...NON_INTERACTIVE, "stash", "push"];
          if (dialog.stashStaged) args.push("--staged");
          else if (dialog.includeUntracked) args.push("--include-untracked");
          if (stashMessage) args.push("-m", stashMessage);
          const count = this.workingTreeFiles.length;
          const r = await exec("git", args, { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({
              title: "Changes stashed",
              body: dialog.stashStaged
                ? "Saved staged changes to a new stash."
                : `Saved ${count} uncommitted file${count === 1 ? "" : "s"} to a new stash.`,
              level: "success",
            });
            this.refresh(cx);
          } else {
            fail((r.stderr || r.stdout).trim().slice(0, 800) || "git stash failed");
          }
        } else if (type === "unstash") {
          const stashRef = dialog.stashRef || "stash@{0}";
          const r = await exec(
            "git",
            [...NON_INTERACTIVE, "stash", "pop", "--index", "--end-of-options", stashRef],
            { cwd: root, on }
          );
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Stash restored", body: `Applied ${stashRef}.`, level: "success" });
            this.refresh(cx);
          } else {
            fail((r.stderr || r.stdout).trim().slice(0, 800) || `Failed to restore ${stashRef}`);
            this.refresh(cx);
          }
        } else if (type === "drop-stash") {
          const stashRef = dialog.stashRef || "stash@{0}";
          const r = await exec("git", [...NON_INTERACTIVE, "stash", "drop", "--end-of-options", stashRef], {
            cwd: root,
            on,
          });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Stash dropped", body: `Removed ${stashRef}.`, level: "success" });
            this.refresh(cx);
          } else {
            fail((r.stderr || r.stdout).trim().slice(0, 800) || `Failed to drop ${stashRef}`);
          }
        } else if (type === "reset") {
          const mode = dialog.resetMode || "mixed";
          const r = await exec("git", [...NON_INTERACTIVE, "reset", `--${mode}`, "--end-of-options", commit.hash], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({
              title: "Branch reset",
              body: `Reset '${this.currentBranch}' to ${commit.shortHash} (--${mode})`,
              level: "success",
            });
            this.refresh(cx);
          } else {
            fail((r.stderr || r.stdout).trim() || "Failed to reset branch");
          }
        } else if (type === "confirm-checkout") {
          const r = await exec("git", [...NON_INTERACTIVE, "checkout", "--end-of-options", commit.hash], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Checked out", body: `Switched to ${commit.shortHash}`, level: "success" });
            this.refresh(cx);
          } else {
            fail((r.stderr || r.stdout).trim() || "Checkout failed");
          }
        } else if (type === "confirm-cherry-pick") {
          const r = await exec("git", [...NON_INTERACTIVE, "cherry-pick", "--end-of-options", commit.hash], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Cherry-pick complete", body: `Applied ${commit.shortHash}`, level: "success" });
            this.refresh(cx);
          } else {
            this.closeModal(cx);
            notify({ title: "Cherry-pick conflict/error", body: (r.stderr || r.stdout).trim(), level: "error" });
            this.refresh(cx);
          }
        } else if (type === "confirm-revert") {
          const r = await exec("git", [...NON_INTERACTIVE, "revert", "--no-edit", "--end-of-options", commit.hash], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Revert complete", body: `Reverted ${commit.shortHash}`, level: "success" });
            this.refresh(cx);
          } else {
            this.closeModal(cx);
            notify({ title: "Revert conflict/error", body: (r.stderr || r.stdout).trim(), level: "error" });
            this.refresh(cx);
          }
        } else if (type === "confirm-merge") {
          const r = await exec("git", [...NON_INTERACTIVE, "merge", "--end-of-options", commit.hash], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Merge complete", body: `Merged into ${this.currentBranch}`, level: "success" });
            this.refresh(cx);
          } else {
            this.closeModal(cx);
            notify({ title: "Merge conflict/error", body: (r.stderr || r.stdout).trim(), level: "error" });
            this.refresh(cx);
          }
        } else if (type === "confirm-merge-branch") {
          const r = await exec("git", [...NON_INTERACTIVE, "merge", "--no-edit", "--end-of-options", ref.text], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({
              title: "Merge complete",
              body: `Merged '${ref.text}' into ${this.currentBranch}`,
              level: "success",
            });
            this.refresh(cx);
          } else {
            this.closeModal(cx);
            notify({ title: "Merge conflict/error", body: (r.stderr || r.stdout).trim(), level: "error" });
            this.refresh(cx);
          }
        } else if (type === "confirm-rebase") {
          const r = await exec("git", [...NON_INTERACTIVE, "rebase", "--end-of-options", commit.hash], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Rebase complete", body: `Rebased ${this.currentBranch} on ${commit.shortHash}`, level: "success" });
            this.refresh(cx);
          } else {
            this.closeModal(cx);
            notify({ title: "Rebase conflict/error", body: (r.stderr || r.stdout).trim(), level: "error" });
            this.refresh(cx);
          }
        } else if (type === "confirm-delete-branch") {
          const bName = ref.text;
          const modal = /** @type {any} */ (dialog);
          const force = Boolean(modal.forceDelete);
          const r = await exec("git", ["branch", force ? "-D" : "-d", "--end-of-options", bName], { cwd: root, on });
          if (r.code === 0) {
            this.closeModal(cx);
            notify({ title: "Branch deleted", body: `Deleted branch '${bName}'`, level: "success" });
            this.refresh(cx);
          } else {
            const errStr = (r.stderr || r.stdout).trim();
            if (!force && errStr.includes("not fully merged")) {
              modal.forceDelete = true;
              fail("Branch is not fully merged. Delete with force (-D)?");
            } else {
              fail(errStr || "Failed to delete branch");
            }
          }
        }
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  abortOperation(cx) {
    if (!this.inProgressOp || this.busy) return;
    const op = this.inProgressOp.type;
    const root = this.root,
      on = this.on;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...NON_INTERACTIVE, op, "--abort"], { cwd: root, on });
        if (r.code === 0) {
          notify({ title: "Operation aborted", body: `${op} was cleanly aborted`, level: "success" });
          this.inProgressOp = null;
          this.refresh(cx);
        } else {
          notify({ title: "Abort failed", body: (r.stderr || r.stdout).trim(), level: "error" });
        }
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  continueOperation(cx) {
    if (!this.inProgressOp || this.busy) return;
    const op = this.inProgressOp.type;
    const root = this.root,
      on = this.on;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...NON_INTERACTIVE, op, "--continue"], { cwd: root, on });
        if (r.code === 0) {
          notify({ title: "Operation continued", body: `${op} completed`, level: "success" });
          this.inProgressOp = null;
          this.refresh(cx);
        } else {
          notify({ title: "Continue failed", body: (r.stderr || r.stdout).trim(), level: "error" });
        }
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  /** Applies a stash without dropping it. */
  applyStash(stash, cx) {
    if (!this.root || this.busy) return;
    const root = this.root;
    const on = this.on;
    const stashRef = stash.stashRef || stash.ref || "stash@{0}";
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let ok = false;
      let body = "";
      try {
        const r = await exec(
          "git",
          [...NON_INTERACTIVE, "stash", "apply", "--index", "--end-of-options", stashRef],
          { cwd: root, on }
        );
        ok = r.code === 0;
        body = ok
          ? `Applied ${stashRef} and kept it in the stash list.`
          : (r.stderr || r.stdout).trim().slice(0, 800) || "git stash apply failed";
      } catch (err) {
        body = err instanceof Error ? err.message : String(err);
      } finally {
        this.busy = false;
        notify({
          title: ok ? "Stash applied" : "Stash apply failed",
          body,
          level: ok ? "success" : "error",
        });
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  handleKeyDown(e, cx) {
    if (e.key === "escape") {
      if (this.modalDialog) {
        this.closeModal(cx);
        return;
      }
      if (this.contextMenu) {
        this.closeContextMenu(cx);
        return;
      }
      if (this.branchDropdownOpen) {
        this.branchDropdownOpen = false;
        cx.notify();
        return;
      }
      if (this.typing) {
        this.typing = false;
        this.handle.focus();
        cx.notify();
        return;
      }
      if (this.selectedFile) {
        this.selectedFile = null;
        cx.notify();
        return;
      }
      if (this.selectedCommit) {
        this.clearSelection(cx);
        return;
      }
    }

    if (e.key === "enter") {
      if (this.modalDialog) {
        this.submitModal(cx);
        return;
      }
    }

    if (this.modalDialog) return;

    if (e.key === "r" && !this.typing) {
      this.refresh(cx);
      return;
    }

    if (e.key === "b" && !this.typing) {
      this.setBranchFilter(this.branchFilter === "all" ? "current" : "all", cx);
      return;
    }

    const isDown = e.key === "down" || (!this.typing && e.key === "j");
    const isUp = e.key === "up" || (!this.typing && e.key === "k");

    if (isDown || isUp) {
      const visible = this.getVisibleItems();
      if (!visible.length) return;

      let currentIndex = -1;
      if (this.selectedCommit) {
        currentIndex = visible.findIndex((item) =>
          item.isWorkingTree
            ? this.selectedCommit?.isWorkingTree
            : item.hash === this.selectedCommit?.hash
        );
      }

      let nextIndex = currentIndex;
      if (isDown) {
        nextIndex = currentIndex + 1 < visible.length ? currentIndex + 1 : 0;
      } else if (isUp) {
        nextIndex = currentIndex - 1 >= 0 ? currentIndex - 1 : visible.length - 1;
      }

      const nextItem = visible[nextIndex];
      if (nextItem) {
        if (nextItem.isWorkingTree) {
          this.selectWorkingTree(cx);
        } else {
          this.selectCommit(nextItem, cx);
        }
      }
    }
  }

  loadMoreCommits(cx) {
    this.commitLimit += 500;
    this.refresh(cx);
  }

  // --- Rendering Helpers ---

  renderWorkingTreeLanes(t) {
    const laneWidth = 16;
    const height = 30;
    const centerY = 15;
    const startX = 12;
    const wtColor = color(t.working || t.ansi3 || t.accent);

    const elements = [
      div()
        .id("wt-lane-line")
        .absolute()
        .left(startX - 1)
        .top(centerY)
        .w(2)
        .h(height - centerY)
        .bg(wtColor),
      div()
        .id("wt-node")
        .absolute()
        .left(startX - 4)
        .top(centerY - 4)
        .size(8)
        .rounded_full()
        .bg(wtColor)
        .border_1()
        .border_color(color(t.background)),
    ];

    const totalGraphWidth = startX + (this.maxLane + 1) * laneWidth + 12;
    return div().relative().w(totalGraphWidth).h(height).flex_none().children(elements);
  }

  renderGraphLanes(commit, t) {
    const laneWidth = 16;
    const height = 30;
    const centerY = 15;
    const startX = 12;
    const strokeW = 2;
    const elements = [];
    const laneX = (lane) => startX + lane * laneWidth;
    const laneColor = (idx) => color(getLaneColor(idx, t));
    const wtColor = color(t.working || t.ansi3 || t.accent);
    const stashColor = color(t.ansi3 || t.accent);

    // Every edge runs node-row center to node-row center as one cosine S-curve
    // (vertical at both ends), split across the two rows it crosses: the upper
    // half is drawn in the row it leaves, the lower half in the row it enters.
    // Curves are sampled as overlapping 1px-step slices (stroke-tall, so slopes
    // keep the rail weight); working-tree edges are dotted.
    const edge = (id, e, half) => {
      const c = e.fromWorkingTree ? wtColor : laneColor(e.colorIdx);
      const x1 = laneX(e.from);
      const dx = laneX(e.to) - x1;
      // Row-local y range and the matching span of the full curve (0..1).
      const y0 = half === "down" ? centerY : 0;
      const y1 = half === "down" ? height : centerY;
      const v0 = half === "down" ? 0 : 0.5;
      const at = (y) => {
        const v = v0 + ((y - y0) / (y1 - y0)) * 0.5;
        return x1 + (dx * (1 - Math.cos(Math.PI * v))) / 2;
      };
      if (dx === 0 && !e.fromWorkingTree) {
        return [
          div()
            .id(id)
            .absolute()
            .left(x1 - strokeW / 2)
            .top(y0)
            .w(strokeW)
            .h(y1 - y0)
            .bg(c),
        ];
      }
      const out = [];
      for (let y = y0; y < y1; y++) {
        if (e.fromWorkingTree && y % 4 >= 2) continue;
        const xa = at(y);
        const xb = at(y + 1);
        out.push(
          div()
            .id(`${id}-s${y}`)
            .absolute()
            .left(Math.min(xa, xb) - strokeW / 2)
            .top(y)
            .w(Math.abs(xb - xa) + strokeW)
            .h(Math.min(strokeW, y1 - y))
            .bg(c)
        );
      }
      return out;
    };

    (commit.edgesUp || []).forEach((e, i) => {
      elements.push(...edge(`up-${commit.hash}-${i}`, e, "up"));
    });
    (commit.edgesDown || []).forEach((e, i) => {
      elements.push(...edge(`down-${commit.hash}-${i}`, e, "down"));
    });

    const myColor = commit.isWorkingTree
      ? wtColor
      : commit.isStash
      ? stashColor
      : laneColor(commit.colorIdx ?? commit.lane);
    const cx0 = laneX(commit.lane);

    // Parents outside the loaded view: a fading stub to the row bottom.
    commit.parentConnections.forEach((conn, idx) => {
      if (!conn.terminated) return;
      elements.push(
        div()
          .id(`term-${commit.hash}-${idx}`)
          .absolute()
          .left(cx0 - strokeW / 2)
          .top(centerY)
          .w(strokeW)
          .h(height - centerY)
          .bg(myColor)
          .opacity(0.5)
      );
    });

    // Node: a solid dot; the working tree is a hollow ring; HEAD adds a halo.
    const node = (size) =>
      div()
        .id(`node-${commit.hash}`)
        .absolute()
        .left(cx0 - size / 2)
        .top(centerY - size / 2)
        .size(size)
        .rounded_full();
    if (commit.isStash) {
      elements.push(node(9).rounded(2).bg(color(t.background)).border_2().border_color(stashColor));
    } else if (commit.isWorkingTree) {
      elements.push(node(11).bg(color(t.background)).border_2().border_color(wtColor));
    } else {
      if (commit.isHead) {
        elements.push(
          div()
            .id(`head-ring-${commit.hash}`)
            .absolute()
            .left(cx0 - 8)
            .top(centerY - 8)
            .size(16)
            .rounded_full()
            .border_2()
            .border_color(myColor)
        );
      }
      elements.push(node(10).bg(myColor));
    }

    const totalGraphWidth = Math.max(64, startX + (this.maxLane + 1) * laneWidth + 12);
    return div().relative().w(totalGraphWidth).h(height).flex_none().children(elements);
  }

  renderWorkingTreeRow(item, t, isCompact, cx) {
    const isSelected = this.selectedCommit?.isWorkingTree;
    let totalAdd = 0,
      totalDel = 0;
    for (const f of this.workingTreeFiles) {
      totalAdd += f.add || 0;
      totalDel += f.del || 0;
    }
    const count = this.workingTreeFiles.length;

    return h_flex()
      .id("commit-working-tree")
      .w_full()
      .h(30)
      .flex_none()
      .items_center()
      .border_b(1)
      .border_color(color(t.border))
      .cursor_pointer()
      .when(isSelected, (e) => e.bg(color(t.selected)))
      .hover((s) => s.bg(color(isSelected ? t.selected : t.hover)))
      .child(this.renderGraphLanes(item, t))
      .child(div().id("wt-graph-divider").w(1).h_full().flex_none().bg(color(t.border)))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .gap(10)
          .pr(10)
          .child(
            div()
              .id("wt-badge")
              .px(5)
              .py(1)
              .rounded(4)
              .bg(color((t.ansi3 || t.accent) + "26"))
              .border_1()
              .border_color(color((t.ansi3 || t.accent) + "77"))
              .text_color(color(t.ansi3 || t.accent))
              .text_size(10)
              .font_semibold()
              .child("WIP")
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12)
              .font_medium()
              .text_color(color(t.foreground))
              .child(`Working Tree · ${count} uncommitted file${count === 1 ? "" : "s"}`)
          )
          .when(totalAdd > 0, (e) =>
            e.child(div().text_size(10).font_semibold().text_color(color(t.ansi2)).child(`+${totalAdd}`))
          )
          .when(totalDel > 0, (e) =>
            e.child(div().text_size(10).font_semibold().text_color(color(t.ansi1)).child(`−${totalDel}`))
          )
          .child(div().w(56).flex_none().pl(4).truncate().text_size(11).text_color(color(t.muted)).child("now"))
          .when(!isCompact, (e) =>
            e.child(
              div().w(130).flex_none().truncate().text_size(11).text_color(color(t.muted)).child("Local Workspace")
            )
          )
          .when(!isCompact, (e) =>
            e.child(
              div()
                .w(70)
                .flex_none()
                .text_center()
                .text_size(11)
                .font_family(String(settings().font_family ?? "JetBrains Mono"))
                .text_color(color(t.dim))
                .child("Unsaved")
            )
          )
      );
  }

  /** One saved stash, rendered as a standalone row above the working tree. */
  renderStashRow(item, t, isCompact, cx) {
    const isSelected = this.selectedCommit?.hash === item.hash && !this.selectedCommit.isWorkingTree;
    const base = item.baseHash ? item.baseHash.slice(0, 7) : null;
    const showBase = Boolean(base && !item.subject.includes(base));

    return h_flex()
      .id(`commit-stash-${item.hash}`)
      .w_full()
      .h(30)
      .flex_none()
      .items_center()
      .border_b(1)
      .border_color(color(t.border))
      .cursor_pointer()
      .when(isSelected, (e) => e.bg(color(t.selected)))
      .when(!isSelected, (e) => e.bg(color((t.ansi3 || t.accent) + "0d")))
      .hover((s) => s.bg(color(isSelected ? t.selected : t.hover)))
      .child(this.renderGraphLanes(item, t))
      .child(div().id("stash-graph-divider").w(1).h_full().flex_none().bg(color(t.border)))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .gap(10)
          .pr(10)
          .child(
            h_flex()
              .id(`stash-badge-${item.hash}`)
              .gap(4)
              .items_center()
              .px(5)
              .py(1)
              .rounded(4)
              .bg(color((t.ansi3 || t.accent) + "26"))
              .border_1()
              .border_color(color((t.ansi3 || t.accent) + "77"))
              .child(svg("mods/git-graph/icons/stash.svg").size(9).text_color(color(t.ansi3 || t.accent)))
              .child(
                div()
                  .text_color(color(t.ansi3 || t.accent))
                  .text_size(10)
                  .font_semibold()
                  .child(item.stashRef)
              )
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12)
              .font_medium()
              .text_color(color(t.foreground))
              .child(item.subject)
          )
          .when(showBase, (e) =>
            e.child(div().flex_none().text_size(9).text_color(color(t.muted)).child(`on ${base}`))
          )
          .child(
            div()
              .w(56)
              .flex_none()
              .pl(4)
              .truncate()
              .text_size(11)
              .text_color(color(t.muted))
              .child(formatRelativeTime(item.timestamp))
          )
          .when(!isCompact, (e) =>
            e.child(
              div()
                .w(130)
                .flex_none()
                .truncate()
                .text_size(11)
                .text_color(color(t.muted))
                .child(item.author)
            )
          )
          .when(!isCompact, (e) =>
            e.child(
              div()
                .w(70)
                .flex_none()
                .text_center()
                .text_size(11)
                .font_family(String(settings().font_family ?? "JetBrains Mono"))
                .text_color(color(t.dim))
                .child(item.shortHash)
            )
          )
      );
  }

  renderCommitRow(commit, t, isCompact, cx) {
    const isSelected = this.selectedCommit?.hash === commit.hash && !this.selectedCommit.isWorkingTree;

    // HEAD is folded into the checked-out branch pill (like Git Graph's ✓ main)
    // instead of being painted as a separate badge.
    const refs = [];
    for (let i = 0; i < commit.refs.length; i++) {
      const ref = commit.refs[i];
      if (ref.kind !== "head") {
        refs.push(ref);
        continue;
      }
      const next = commit.refs[i + 1];
      if (next && next.kind === "local") {
        refs.push({ ...next, isHead: true });
        i++;
      } else {
        refs.push(ref);
      }
    }

    // A local branch and its matching remote at the same commit share one pill:
    // `main | origin`, like VS Code's ref label. Remote-only refs keep the full
    // `origin/main` label.
    const pairedRemoteTexts = new Set();
    const pairByLocal = new Map();
    for (const ref of refs) {
      if (ref.kind !== "local") continue;
      const remote = refs.find(
        (r) => r.kind === "remote" && !pairedRemoteTexts.has(r.text) && r.text.endsWith("/" + ref.text)
      );
      if (remote) {
        pairedRemoteTexts.add(remote.text);
        pairByLocal.set(ref.text, remote);
      }
    }
    const displayRefs = [];
    for (const ref of refs) {
      if (ref.kind === "remote" && pairedRemoteTexts.has(ref.text)) continue;
      displayRefs.push(
        ref.kind === "local" && pairByLocal.has(ref.text)
          ? { ...ref, pairedRemote: pairByLocal.get(ref.text) }
          : ref
      );
    }

    // Q5 & Q1: Cap badges to max 2 + "+N" chip if > 3 (or > 2 in compact)
    const maxVisibleRefs = isCompact ? 2 : 3;
    let visibleRefs = displayRefs;
    let extraRefCount = 0;
    if (displayRefs.length > maxVisibleRefs) {
      visibleRefs = displayRefs.slice(0, 2);
      extraRefCount = displayRefs.length - 2;
    }

    commit._badgeBoxes = [];
    const laneWidth = 16;
    const startX = 12;
    const graphWidth = Math.max(64, startX + (this.maxLane + 1) * laneWidth + 12);
    // The graph column is closed by a 1px rule; badges start after it.
    let curX = graphWidth + 1;

    // Badges are laid out at a fixed, estimated width so the hit boxes recorded
    // in `_badgeBoxes` match the painted boxes exactly. Measuring them with
    // `on_size_change` is not an option here: handlers registered inside a
    // virtual-list item renderer throw, which blanks the whole list.
    const badgeWidth = (ref) => {
      const maxBadgeW = isCompact ? 118 : 190;
      if (ref.kind === "head") return 46;
      const textWidth = Math.ceil(ref.text.length * 6.2);
      if (ref.pairedRemote) {
        const remoteW = Math.ceil((ref.pairedRemote.text.split("/")[0] || "").length * 6.2);
        return Math.min(maxBadgeW, 34 + textWidth + remoteW);
      }
      return Math.min(maxBadgeW, 28 + textWidth);
    };

    const renderedBadges = visibleRefs.map((ref, idx) => {
      const badgeW = badgeWidth(ref);

      // Combined pills store two hit boxes (branch and remote) so clicking
      // either side still filters to that ref.
      if (ref.pairedRemote) {
        const branchW = Math.ceil(ref.text.length * 6.2);
        const splitAt = Math.max(12, Math.min(badgeW - 2, 21 + branchW));
        commit._badgeBoxes.push({ ref, xStart: curX, xEnd: curX + splitAt });
        commit._badgeBoxes.push({ ref: ref.pairedRemote, xStart: curX + splitAt, xEnd: curX + badgeW });
      } else {
        commit._badgeBoxes.push({ ref, xStart: curX, xEnd: curX + badgeW });
      }
      curX += badgeW + 5;

      if (ref.kind === "head") {
        return h_flex()
          .id(`ref-head-${commit.hash}-${idx}`)
          .w(badgeW)
          .flex_none()
          .gap(4)
          .items_center()
          .px(5)
          .py(1)
          .rounded(5)
          .bg(color(t.accent))
          .text_color(color(t.accent_foreground))
          .text_size(10)
          .font_semibold()
          .overflow_hidden()
          .child(svg("mods/git-graph/icons/check.svg").size(10).flex_none())
          .child(div().min_w(0).truncate().child("HEAD"));
      }

      const isTag = ref.kind === "tag";
      const isRemote = ref.kind === "remote";
      const bColor = isTag ? t.ansi3 : isRemote ? t.ansi5 : t.ansi4;
      const isFilteredThis = this.branchFilter === ref.text;
      const fg = isFilteredThis ? t.background : bColor;

      // Local branch + its remote: one neon pill, [⎇ main | origin].
      if (ref.pairedRemote) {
        const remoteName = ref.pairedRemote.text.split("/")[0] || ref.pairedRemote.text;
        const head = Boolean(ref.isHead);
        const remoteFiltered = this.branchFilter === ref.pairedRemote.text;

        return h_flex()
          .id(`ref-pair-${commit.hash}-${idx}-${ref.text}`)
          .w(badgeW)
          .flex_none()
          .gap(4)
          .items_center()
          .px(5)
          .py(1)
          .rounded(5)
          .bg(color(bColor + "26"))
          .border_1()
          .border_color(color(bColor + "77"))
          .text_color(color(bColor))
          .text_size(10)
          .overflow_hidden()
          .child(
            svg(`mods/git-graph/icons/${head ? "check" : "branch"}.svg`)
              .size(10)
              .flex_none()
          )
          .child(div().min_w(0).truncate().font_medium().child(ref.text))
          .child(div().w(1).h(9).flex_none().bg(color(bColor + "66")))
          .child(
            div()
              .flex_none()
              .text_color(color(remoteFiltered ? bColor : bColor + "b3"))
              .child(remoteName)
          );
      }

      return h_flex()
        .id(`ref-${ref.kind}-${commit.hash}-${idx}-${ref.text}`)
        .w(badgeW)
        .flex_none()
        .gap(4)
        .items_center()
        .px(5)
        .py(1)
        .rounded(5)
        .bg(color(isFilteredThis ? bColor : bColor + "26"))
        .border_1()
        .border_color(color(bColor + "77"))
        .text_color(color(fg))
        .text_size(10)
        .overflow_hidden()
        .child(
          svg(`mods/git-graph/icons/${isTag ? "tag" : ref.isHead ? "check" : "branch"}.svg`)
            .size(10)
            .flex_none()
        )
        .child(div().min_w(0).truncate().child(ref.text));
    });

    if (extraRefCount > 0) {
      const extraW = Math.min(60, 20 + String(extraRefCount).length * 7);
      commit._badgeBoxes.push({
        ref: { kind: "extra", text: `+${extraRefCount}` },
        xStart: curX,
        xEnd: curX + extraW,
      });
      curX += extraW + 5;

      renderedBadges.push(
        div()
          .id(`ref-extra-${commit.hash}`)
          .w(extraW)
          .flex_none()
          .overflow_hidden()
          .text_center()
          .px(4)
          .py(1)
          .rounded(4)
          .bg(color(t.raised))
          .border_1()
          .border_color(color(t.border))
          .text_color(color(t.dim))
          .text_size(9)
          .font_semibold()
          .truncate()
          .child(`+${extraRefCount}`)
      );
    }

    return h_flex()
      .id(`commit-${commit.hash}`)
      .w_full()
      .h(30)
      .flex_none()
      .items_center()
      .border_b(1)
      .border_color(color(t.border))
      .cursor_pointer()
      .when(isSelected, (e) => e.bg(color(t.selected)))
      .hover((s) => s.bg(color(isSelected ? t.selected : t.hover)))
      .child(this.renderGraphLanes(commit, t))
      .child(div().id(`graph-divider-${commit.hash}`).w(1).h_full().flex_none().bg(color(t.border)))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .gap(10)
          .pr(10)
          // Ref Badges with Vector Icons and stable IDs
          .when(renderedBadges.length > 0, (e) =>
            e.child(
              h_flex()
                .id(`ref-badges-group-${commit.hash}`)
                .max_w(isCompact ? 150 : 300)
                .flex_shrink(1)
                .overflow_hidden()
                .items_center()
                .gap(5)
                .children(renderedBadges)
            )
          )
          // Merge Commit icon indicator
          .when(commit.parents.length > 1, (e) =>
            e.child(
              div()
                .id(`merge-icon-${commit.hash}`)
                .flex_none()
                .text_color(color(t.muted))
                .child(svg("mods/git-graph/icons/merge.svg").size(12))
            )
          )
          // Commit Subject
          .child(
            div()
              .id(`subject-${commit.hash}`)
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12)
              .text_color(color(t.foreground))
              .child(commit.subject)
          )
          // Relative Date
          .child(
            div()
              .w(56)
              .flex_none()
              .pl(4)
              .truncate()
              .text_size(11)
              .text_color(color(t.muted))
              .child(formatRelativeTime(commit.timestamp, true))
          )
          // Author
          .when(!isCompact, (e) =>
            e.child(
              div().w(130).flex_none().truncate().text_size(11).text_color(color(t.muted)).child(commit.author)
            )
          )
          // Commit SHA
          .when(!isCompact, (e) =>
            e.child(
              div()
                .w(70)
                .flex_none()
                .text_center()
                .text_size(11)
                .font_family(String(settings().font_family ?? "JetBrains Mono"))
                .text_color(color(t.dim))
                .child(commit.shortHash)
            )
          )
      );
  }

  /** Every directory path in a built file tree, for the collapse-all header. */
  allFolderPaths(node, paths = []) {
    for (const child of node.children.values()) {
      if (child.isDir) {
        paths.push(child.path);
        this.allFolderPaths(child, paths);
      }
    }
    return paths;
  }

  /** Collapse every folder, or expand them all when they are already collapsed. */
  toggleAllFolders(folderPaths, allCollapsed, cx) {
    this.collapsedFolders = allCollapsed ? new Set() : new Set(folderPaths);
    cx.notify();
  }

  /** Vertical guide lines for one tree row, one per ancestor level. */
  treeIndentGuides(depth, t) {
    return Array.from({ length: depth }, () =>
      div()
        .w(14)
        .h_full()
        .flex_none()
        .border_l(1)
        .border_color(color(t.border))
        .opacity(0.7)
    );
  }

  /** One VS Code-style folder or file row in the changes tree. */
  renderTreeRow(row, t, cx) {
    const isFileSelected = !row.isDir && this.selectedFile === row.path;
    const badge = row.isDir ? null : fileTypeBadge(row.name);
    const status = row.status || "M";
    const tip = row.isDir
      ? `${row.path}\n${row.add} added · ${row.del} removed\nClick to ${row.isExpanded ? "collapse" : "expand"}`
      : `${row.path}\n${statusLabel(status)} · ${row.add} added · ${row.del} removed\nClick to open the diff`;

    return h_flex()
      .id(`${row.isDir ? "dir" : "file"}-${row.path}`)
      .h(24)
      .flex_none()
      .w_full()
      .pl(6)
      .pr(8)
      .items_center()
      .when(isFileSelected, (e) => e.bg(color(t.selected)))
      .hover((s) => s.bg(color(isFileSelected ? t.selected : t.hover)))
      .cursor_pointer()
      .tooltip(tip)
      .on_click((_e, cx) => {
        if (row.isDir) this.toggleFolder(row.path, cx);
        else this.openDiffTab(row.path, cx);
      })
      .children(this.treeIndentGuides(row.depth, t))
      .child(
        div()
          .w(16)
          .h_full()
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .when(row.isDir, (e) =>
            e.child(
              svg(
                row.isExpanded
                  ? "mods/git-graph/icons/chevron-down.svg"
                  : "mods/git-graph/icons/chevron-right.svg"
              )
                .size(11)
                .text_color(color(t.dim))
            )
          )
          .when(!row.isDir, (e) =>
            e.child(
              badge
                ? div()
                    .w(16)
                    .h(16)
                    .rounded(3)
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(color(badge.bg))
                    .child(
                      div()
                        .text_size(8)
                        .font_semibold()
                        .text_color(color(badge.fg))
                        .child(badge.label)
                    )
                : svg("mods/git-graph/icons/file.svg").size(12).text_color(color(t.muted))
            )
          )
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .pl(4)
          .truncate()
          .text_size(11)
          .when(row.isDir, (e) => e.font_medium())
          .text_color(color(t.foreground))
          .child(row.name)
      )
      .when(!row.isDir, (e) =>
        e.child(
          div()
            .w(16)
            .flex_none()
            .text_center()
            .font_semibold()
            .text_size(10)
            .text_color(color(getStatusColor(status, t)))
            .child(status)
        )
      )
      .when(row.isDir, (e) =>
        e.child(
          div()
            .w(16)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .child(div().w(4).h(4).rounded_full().bg(color(t.muted)).opacity(0.8))
        )
      )
      // VS Code-style line counts: green additions, red deletions.
      .when(!row.isDir && (row.add > 0 || row.del > 0), (e) =>
        e.child(
          h_flex()
            .flex_none()
            .gap(4)
            .items_center()
            .pl(6)
            .when(row.add > 0, (r) =>
              r.child(
                div()
                  .text_size(10)
                  .font_medium()
                  .text_color(color(t.ansi2))
                  .child(`+${row.add}`)
              )
            )
            .when(row.del > 0, (r) =>
              r.child(
                div()
                  .text_size(10)
                  .font_medium()
                  .text_color(color(t.ansi1))
                  .child(`−${row.del}`)
              )
            )
        )
      );
  }

  renderTreeList(t, cx) {
    const tree = buildFileTree(this.commitFiles);
    const rows = flattenFileTree(tree, 0, this.collapsedFolders, []);
    const folderPaths = this.allFolderPaths(tree);
    const allCollapsed = folderPaths.length > 0 && folderPaths.every((p) => this.collapsedFolders.has(p));
    const count = this.commitFiles.length;
    const add = this.commitFiles.reduce((n, f) => n + (f.add || 0), 0);
    const del = this.commitFiles.reduce((n, f) => n + (f.del || 0), 0);

    return v_flex()
      .id("tree-file-list")
      .flex_1()
      .min_h(0)
      .w_full()
      // Fixed "Changes" group header, like VS Code's Source Control tree.
      .child(
        h_flex()
          .id("tree-changes-header")
          .h(28)
          .flex_none()
          .px(8)
          .gap(6)
          .items_center()
          .bg(color(t.raised))
          .border_b(1)
          .border_color(color(t.border))
          .when(folderPaths.length > 0, (e) => e.cursor_pointer().hover((s) => s.bg(color(t.hover))))
          .tooltip(
            `${count} changed file${count === 1 ? "" : "s"} · ${add} added · ${del} removed${
              folderPaths.length ? "\nClick to collapse or expand every folder" : ""
            }`
          )
          .on_click((_e, cx) => {
            if (folderPaths.length) this.toggleAllFolders(folderPaths, allCollapsed, cx);
          })
          .child(
            svg(
              allCollapsed
                ? "mods/git-graph/icons/chevron-right.svg"
                : "mods/git-graph/icons/chevron-down.svg"
            )
              .size(10)
              .flex_none()
              .text_color(color(t.dim))
          )
          .child(div().text_size(11).font_semibold().text_color(color(t.foreground)).child("Changes"))
          .child(div().flex_1())
          .child(
            div()
              .min_w(18)
              .h(16)
              .px(5)
              .rounded_full()
              .flex()
              .items_center()
              .justify_center()
              .bg(color(t.border))
              .text_size(9)
              .font_medium()
              .text_color(color(t.muted))
              .child(String(count))
          )
      )
      .child(
        rows.length
          ? v_flex()
              .id("tree-file-rows")
              .flex_1()
              .min_h(0)
              .overflow_y_scrollbar()
              .py(3)
              .children(rows.map((row) => this.renderTreeRow(row, t, cx)))
          : div()
              .flex_1()
              .p(12)
              .text_size(11)
              .text_color(color(t.dim))
              .child("No changed files in this commit")
      );
  }

  /** Commit table plus its load-more bar, shared by both detail layouts. */
  renderCommitArea(t, isCompact, cx) {
    const visibleItems = this.getVisibleItems();
    return v_flex()
      .id("commits-container")
      .relative()
      .flex_1()
      .min_h(0)
      .on_mouse_down("left", (e, _cx) => {
        this.lastLeftClickEvent = e;
        this.lastListLeftClickEvent = e;
      })
      .on_mouse_down("right", (e, _cx) => {
        this.lastRightClickEvent = e;
      })
      // Empty or Error states
      .when(Boolean(this.error), (e) =>
        e.child(
          v_flex()
            .p(30)
            .gap(12)
            .items_center()
            .justify_center()
            .child(div().text_size(13).text_color(color(t.dim)).child(this.error || ""))
            .child(
              h_flex()
                .id("open-folder-btn")
                .gap(6)
                .items_center()
                .px(12)
                .py(5)
                .rounded(6)
                .bg(color(t.solid))
                .text_color(color(t.solid_foreground))
                .text_size(12)
                .cursor_pointer()
                .on_click((_e, cx) => this.openFolder(cx))
                .child(svg("mods/git-graph/icons/folder.svg").size(14))
                .child("Open Repository Folder…")
            )
        )
      )
      .when(!this.loading && !this.error && !visibleItems.length, (e) =>
        e.child(
          v_flex()
            .p(30)
            .gap(10)
            .items_center()
            .justify_center()
            .child(
              div()
                .text_color(color(t.dim))
                .text_size(13)
                .child(
                  !this.hasHead
                    ? "No commits yet in this repository"
                    : this.searchQuery
                    ? "No commits match your filter"
                    : "No commits found on this branch"
                )
            )
            .when(!this.hasHead, (el) =>
              el.child(
                div()
                  .text_size(11)
                  .text_color(color(t.muted))
                  .child(`Current branch is '${this.currentBranch}'. Make your first commit to see the graph.`)
              )
            )
        )
      )
      // Virtual list when items exist
      .when(visibleItems.length > 0, (e) =>
        e
          .child(
            uniform_list(
              "commits-virtual-list",
              visibleItems.length,
              (i) => (visibleItems[i]?.isWorkingTree ? "__WORKING_TREE__" : visibleItems[i]?.hash || String(i)),
              (range, cx) => {
                const slice = visibleItems.slice(range.start, range.end);
                return slice.map((item) => {
                  if (item.isStash) {
                    return this.renderStashRow(item, t, isCompact, cx);
                  }
                  if (item.isWorkingTree) {
                    return this.renderWorkingTreeRow(item, t, isCompact, cx);
                  }
                  return this.renderCommitRow(item, t, isCompact, cx);
                });
              }
            )
              .size_full()
              .on_item_click((key, cx) => {
                const event = this.lastListLeftClickEvent || this.lastLeftClickEvent;
                if (key === "__WORKING_TREE__") {
                  this.selectWorkingTree(cx);
                } else {
                  const item =
                    this.commits.find((c) => c.hash === key) ||
                    this.stashNodes.find((c) => c.hash === key);
                  if (item) {
                    if (item.isStash) {
                      this.selectCommit(item, cx);
                      return;
                    }
                    const clickX = event?.local_position?.x;
                    if (typeof clickX === "number" && item._badgeBoxes) {
                      const hit = item._badgeBoxes.find((b) => clickX >= b.xStart && clickX <= b.xEnd);
                      if (hit) {
                        if (hit.ref.kind === "local" || hit.ref.kind === "remote" || hit.ref.kind === "branch") {
                          if (this.branchFilter === hit.ref.text) {
                            this.setBranchFilter("all", cx);
                          } else {
                            this.setBranchFilter(hit.ref.text, cx);
                          }
                          return;
                        }
                        if (hit.ref.kind === "tag") {
                          this.setSearch(hit.ref.text, cx);
                          return;
                        }
                      }
                    }
                    this.selectCommit(item, cx);
                  }
                }
              })
              .on_item_secondary_click((key, event, cx) => {
                if (key === "__WORKING_TREE__") {
                  this.openWorkingTreeContextMenu(event, cx);
                  return;
                }
                const item =
                  this.commits.find((c) => c.hash === key) ||
                  this.stashNodes.find((c) => c.hash === key);
                if (item) {
                  if (item.isStash) {
                    this.openStashContextMenu(item, event, cx);
                    return;
                  }
                  const clickX = event?.local_position?.x;
                  if (typeof clickX === "number" && item._badgeBoxes) {
                    const hit = item._badgeBoxes.find((b) => clickX >= b.xStart && clickX <= b.xEnd);
                    if (hit && (hit.ref.kind === "local" || hit.ref.kind === "remote" || hit.ref.kind === "branch")) {
                      this.openBranchContextMenu(hit.ref, event, cx);
                      return;
                    }
                  }
                  this.openCommitContextMenu(item, event, cx);
                }
              })
          )
          .child(Scrollbar.vertical("commits-virtual-list").absolute().inset_0())
      )
      // Load more bar if at commit limit
      .when(this.commits.length >= this.commitLimit, (e) =>
        e.child(
          h_flex()
            .id("load-more-btn")
            .h(28)
            .flex_none()
            .justify_center()
            .items_center()
            .bg(color(t.raised))
            .border_t(1)
            .border_color(color(t.border))
            .cursor_pointer()
            .hover((s) => s.bg(color(t.hover)))
            .on_click((_e, cx) => this.loadMoreCommits(cx))
            .child(
              div()
                .text_size(11)
                .text_color(color(t.accent))
                .child(`Showing ${this.commits.length} commits · Load 500 more…`)
            )
        )
      );
  }

  /**
   * Pixel height for a wrapped commit message: grows with its line count and
   * stops at a readable cap, where the body becomes scrollable.
   */
  commitMessageHeight(message, isCompact) {
    const text = String(message || "");
    const width = Math.max(160, this.width - 24);
    // 11px UI text averages ~6.2px per glyph; keep room for the scrollbar.
    const charsPerLine = Math.max(20, Math.floor((width - 20) / 6.2));
    const lines = text
      .split("\n")
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
    const natural = lines * 16 + 16;
    return Math.max(32, Math.min(natural, isCompact ? 150 : 200));
  }

  renderDetailsPanel(t, isCompact, cx) {
    const c = this.selectedCommit;
    if (!c) return null;

    const fullMsg = this.commitDetails?.fullMessage || c.subject;

    return v_flex()
      .id("commit-details-panel")
      .size_full()
      .min_h(0)
      .border_t(1)
      .border_color(color(t.border))
      .bg(color(t.background))
      // Panel Header
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(color(t.border))
          .child(div().font_semibold().text_size(12).truncate().child(c.subject))
          .child(div().flex_1())
          // Copy SHA button
          .when(!c.isWorkingTree, (e) =>
            e.child(
              h_flex()
                .id("copy-sha-btn")
                .gap(4)
                .items_center()
                .px(6)
                .py(2)
                .rounded(4)
                .bg(color(t.raised))
                .border_1()
                .border_color(color(t.border))
                .cursor_pointer()
                .hover((s) => s.bg(color(t.hover)))
                .font_family(String(settings().font_family ?? "JetBrains Mono"))
                .text_size(11)
                .text_color(color(t.foreground))
                .on_click((_e, cx) => {
                  cx.write_to_clipboard(c.hash);
                  notify({
                    title: "Commit SHA copied",
                    body: c.shortHash,
                    level: "success",
                    timeout: 1500,
                  });
                })
                .child(svg("mods/git-graph/icons/copy.svg").size(11))
                .child(c.shortHash)
            )
          )
          .when(!isCompact, (e) =>
            e.child(
              div()
                .text_size(11)
                .text_color(color(t.muted))
                .child(`${c.author} · ${formatRelativeTime(c.timestamp)}`)
            )
          )
          .child(
            div()
              .id("close-details-btn")
              .px(8)
              .py(3)
              .rounded(6)
              .cursor_pointer()
              .hover((s) => s.bg(color(t.hover)))
              .text_size(11)
              .text_color(color(t.dim))
              .on_click((_e, cx) => this.clearSelection(cx))
              .child("✕ Close")
          )
      )
      // Panel Body: the commit message, then the changed-file tree. Files open
      // their diff in a dedicated tab instead of a cramped inline editor.
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .child(
            div()
              .flex_none()
              .h(this.commitMessageHeight(fullMsg, isCompact))
              .p(8)
              .overflow_y_scrollbar()
              .whitespace_normal()
              .border_b(1)
              .border_color(color(t.border))
              .text_size(11)
              .text_color(color(t.dim))
              .child(fullMsg)
          )
          .child(this.renderTreeList(t, cx))
      );
  }

  renderBranchDropdown(t, cx) {
    // In a narrow docked panel the menu must fit inside the card (which clips
    // its children), so anchor it to the panel edge instead of the toolbar.
    const narrow = this.width > 0 && this.width < 400;
    return div()
      .id("branch-dropdown-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => {
        this.branchDropdownOpen = false;
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        this.branchDropdownOpen = false;
        cx.notify();
      })
      .child(
        v_flex()
          .id("branch-dropdown-menu")
          .absolute()
          .left(narrow ? 8 : 100)
          .top(40)
          .when(narrow, (e) => e.w(Math.max(240, this.width - 16)))
          .when(!narrow, (e) => e.min_w(280).max_w(380))
          .max_h(280)
          .overflow_y_scrollbar()
          .p(4)
          .rounded(8)
          .bg(color(t.popover))
          .border_1()
          .border_color(color(t.border))
          .shadow_lg()
          .text_size(11)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          // All branches option
          .child(
            h_flex()
              .id("branch-filter-all")
              .flex_none()
              .h(26)
              .px(8)
              .gap(6)
              .items_center()
              .rounded(5)
              .cursor_pointer()
              .when(this.branchFilter === "all", (el) => el.bg(color(t.selected)).font_semibold())
              .hover((s) => s.bg(color(this.branchFilter === "all" ? t.selected : t.hover)))
              .on_click((_e, cx) => this.setBranchFilter("all", cx))
              .child(svg("mods/git-graph/icons/branch.svg").size(12).text_color(color(t.accent)))
              .child(div().flex_1().truncate().child("All branches (--all)"))
          )
          // Current branch option
          .child(
            h_flex()
              .id("branch-filter-current")
              .flex_none()
              .h(26)
              .px(8)
              .gap(6)
              .items_center()
              .rounded(5)
              .cursor_pointer()
              .when(this.branchFilter === "current", (el) => el.bg(color(t.selected)).font_semibold())
              .hover((s) => s.bg(color(this.branchFilter === "current" ? t.selected : t.hover)))
              .on_click((_e, cx) => this.setBranchFilter("current", cx))
              .child(svg("mods/git-graph/icons/branch.svg").size(12).text_color(color(t.accent)))
              .child(div().flex_1().truncate().child(`Current branch (${this.currentBranch || "HEAD"})`))
          )
          // Upstream tracking summary
          .when(Boolean(this.upstream), (e) =>
            e.child(
              h_flex()
                .id("branch-upstream-status")
                .flex_none()
                .h(22)
                .px(8)
                .gap(6)
                .items_center()
                .text_size(10)
                .text_color(color(t.muted))
                .child(svg("mods/git-graph/icons/branch.svg").size(10).text_color(color(t.dim)))
                .child(div().flex_1().truncate().child(`Tracking ${this.upstream}`))
                .when(this.ahead > 0, (el) =>
                  el.child(div().text_color(color(t.ansi2)).child(`↑${this.ahead}`))
                )
                .when(this.behind > 0, (el) =>
                  el.child(div().text_color(color(t.ansi1)).child(`↓${this.behind}`))
                )
            )
          )
          // Specific branches list
          .when(this.availableBranches.length > 0, (e) =>
            e
              .child(div().flex_none().h(1).bg(color(t.border)).my(3))
              .child(div().flex_none().px(8).py(2).text_size(10).text_color(color(t.muted)).child("BRANCHES"))
              .children(
                this.availableBranches.map((bName) => {
                  const isActive = this.branchFilter === bName;
                  return h_flex()
                    .id(`branch-item-${bName}`)
                    .flex_none()
                    .h(24)
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .when(isActive, (el) => el.bg(color(t.selected)).font_semibold())
                    .hover((s) => s.bg(color(isActive ? t.selected : t.hover)))
                    .on_click((_e, cx) => this.setBranchFilter(bName, cx))
                    .on_mouse_down("right", (e, cx) => {
                      cx.stop_propagation();
                      this.branchDropdownOpen = false;
                      this.openBranchContextMenu(bName, e, cx);
                    })
                    .child(svg("mods/git-graph/icons/branch.svg").size(11).text_color(color(t.dim)))
                    .child(div().flex_1().truncate().child(bName));
                })
              )
          )
          // Stash actions stay reachable after the dirty row disappears.
          .when(this.workingTreeFiles.length > 0 || this.stashes.length > 0, (e) =>
            e
              .child(div().flex_none().h(1).bg(color(t.border)).my(3))
              .when(this.workingTreeFiles.length > 0, (el) =>
                el.child(
                  h_flex()
                    .id("branch-stash-changes")
                    .flex_none()
                    .h(26)
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .hover((s) => s.bg(color(t.hover)))
                    .on_click((_e, cx) => {
                      this.branchDropdownOpen = false;
                      this.openModal("stash", { staged: false }, cx);
                    })
                    .child(svg("mods/git-graph/icons/stash.svg").size(12).text_color(color(t.dim)))
                    .child(div().flex_1().truncate().child("Stash changes…"))
                    .child(
                      div()
                        .text_size(9)
                        .text_color(color(t.muted))
                        .child(`${this.workingTreeFiles.length} file${this.workingTreeFiles.length === 1 ? "" : "s"}`)
                    )
                )
              )
              .when(this.stashes.length > 0, (el) =>
                el
                  .child(
                    div()
                      .flex_none()
                      .px(8)
                      .py(2)
                      .text_size(10)
                      .text_color(color(t.muted))
                      .child(`STASHES (${this.stashes.length})`)
                  )
                  .children(
                    this.stashes.map((st, index) =>
                      h_flex()
                        .id(`branch-stash-${index}`)
                        .flex_none()
                        .h(24)
                        .px(8)
                        .gap(6)
                        .items_center()
                        .rounded(5)
                        .cursor_pointer()
                        .hover((s) => s.bg(color(t.hover)))
                        .on_click((_e, cx) => {
                          this.branchDropdownOpen = false;
                          this.openModal("unstash", st, cx);
                        })
                        .child(svg("mods/git-graph/icons/unstash.svg").size(11).text_color(color(t.dim)))
                        .child(div().flex_1().truncate().child(st.subject))
                        .child(div().text_size(9).text_color(color(t.muted)).child(st.ref))
                    )
                  )
              )
          )
          // Background AI commit worker
          .when(Boolean(this.workingTreeFiles.length || this.inProgressOp || this.treeAgentBusy()), (e) =>
            e
              .child(div().flex_none().h(1).bg(color(t.border)).my(3))
              .child(
                h_flex()
                  .id("branch-clean-agent")
                  .flex_none()
                  .h(26)
                  .px(8)
                  .gap(6)
                  .items_center()
                  .rounded(5)
                  .when(this.treeAgentBusy(), (row) => row.opacity(0.75))
                  .cursor_pointer()
                  .hover((s) => s.bg(color(t.hover)))
                  .on_click((_e, cx) => {
                    this.branchDropdownOpen = false;
                    if (this.treeAgentBusy() && this.treeAgent?.address) {
                      run("terminal.peek", { terminal: this.treeAgent.address });
                      return;
                    }
                    this.startTreeAgent(cx);
                  })
                  .child(svg("mods/git-graph/icons/sparkles.svg").size(12).text_color(color(t.accent)))
                  .child(div().flex_1().truncate().child(`Clean tree with ${CLEAN_AGENT_LABEL}`))
                  .child(
                    div()
                      .max_w(120)
                      .truncate()
                      .text_size(9)
                      .text_color(color(t.muted))
                      .child(this.treeAgentBusy() ? "working · peek" : cleanModelLabel(this.cleanAgentModelLabel()))
                  )
              )
              .child(
                h_flex()
                  .id("branch-clean-model")
                  .flex_none()
                  .h(24)
                  .px(8)
                  .gap(6)
                  .items_center()
                  .rounded(5)
                  .cursor_pointer()
                  .hover((s) => s.bg(color(t.hover)))
                  .on_click((_e, cx) => {
                    this.branchDropdownOpen = false;
                    this.openCleanAgentModelPicker(cx);
                  })
                  .child(svg("mods/git-graph/icons/sparkles.svg").size(10).text_color(color(t.dim)))
                  .child(div().flex_1().truncate().text_size(10).text_color(color(t.muted)).child("AI commit model"))
                  .child(div().text_size(9).text_color(color(t.accent)).child("Change"))
              )
          )
      );
  }

  /** One fetch / pull / push button for the toolbar. */
  remoteActionButton(kind, t, cx) {
    const icon = {
      fetch: "mods/git-graph/icons/fetch.svg",
      pull: "mods/git-graph/icons/pull.svg",
      push: "mods/git-graph/icons/push.svg",
    }[kind];
    const label = this.remoteLabel(kind);
    const running = this.remoteAction === kind;
    const anotherRunning = Boolean(this.remoteAction) && !running;
    const needsUpstream = kind === "pull" && !this.upstream;
    const needsRemote = kind === "fetch" && !this.remotes.length;
    const cannotPush = kind === "push" && (!this.hasHead || this.detached);
    const operationLocked = kind !== "fetch" && Boolean(this.inProgressOp);
    const disabled =
      Boolean(this.remoteAction) || this.busy || needsUpstream || needsRemote || cannotPush || operationLocked;

    let tip;
    if (running) {
      tip = kind === "fetch" ? "Fetching…" : kind === "pull" ? "Pulling…" : "Pushing…";
    } else if (this.busy || anotherRunning) {
      tip = "Another git operation is running";
    } else if (needsRemote) {
      tip = "No remote configured";
    } else if (needsUpstream) {
      tip = "No upstream branch to pull from";
    } else if (cannotPush) {
      tip = this.hasHead ? "Cannot push from a detached HEAD" : "Nothing to push yet";
    } else if (operationLocked) {
      tip = `Finish the in-progress ${this.inProgressOp.type} first`;
    } else if (kind === "fetch") {
      tip = "Fetch all remotes (git fetch --all --prune)";
    } else if (kind === "pull") {
      tip = `Pull from ${this.upstream}${this.behind > 0 ? ` · ${this.behind} behind` : ""}`;
    } else if (!this.remotes.length) {
      tip = "Publish to GitHub: create a repository and push this branch";
    } else if (this.upstream) {
      tip = `Push to ${this.upstream}${this.ahead > 0 ? ` · ${this.ahead} ahead` : ""}`;
    } else {
      tip = `Push and set upstream to ${this.pushRemote()}/${this.currentBranch}`;
    }

    return div()
      .id(`remote-${kind}-btn`)
      .w(23)
      .h(23)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(5)
      .border_1()
      .border_color(color(running ? t.accent : t.border))
      .bg(color(running ? t.accent + "26" : t.raised))
      .when(disabled && !running, (e) => e.opacity(0.4).cursor_not_allowed())
      .when(running, (e) => e.cursor_default())
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(color(t.hover))))
      .accessibility_label(`${label}${disabled ? " (unavailable)" : ""}`)
      .tooltip(tip)
      .disabled(disabled)
      .on_click((_e, cx) => this.runRemoteAction(kind, cx))
      .child(svg(icon).size(12).text_color(color(running ? t.accent : t.dim)));
  }

  /** Live status of the background AI worker, or null when it is idle/gone. */
  treeAgentStatus() {
    if (!this.treeAgent?.address) return null;
    const term = terminals().find((t) => t.address === this.treeAgent.address);
    if (!term || term.state !== "live") return null;
    return term.status || null;
  }

  /** True while the launched AI worker still owns the working tree. */
  treeAgentBusy() {
    if (this.treeAgentStarting) return true;
    const agent = this.treeAgent;
    if (!agent || agent.finished) return false;
    // Once `hc run` returns, the worker keeps the button locked until its
    // session is done and the tree is clean (or its terminal is gone and the
    // finish check retires it).
    return true;
  }

  /** The model the next run will use (explicit choice, else the free default). */
  cleanAgentModelLabel() {
    return this.treeAgentModel || shared(CLEAN_AGENT_MODEL_KEY) || CLEAN_AGENT_MODEL;
  }

  /**
   * Every model `opencode models` reports, with free ones first. When the
   * catalog cannot be read, the known free preference still gives the picker
   * something useful to show.
   */
  async loadCleanAgentModels(root, on, options = {}) {
    const cache = this.cleanModelsCache;
    if (
      !options.force &&
      cache &&
      cache.root === root &&
      cache.on === on &&
      Date.now() - cache.at < 60000
    ) {
      return cache.models;
    }
    let ids = [];
    try {
      const r = await exec("opencode", ["models"], { cwd: root, on });
      if (r.code === 0) {
        ids = r.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      }
    } catch {
      // Fall through to the known free list.
    }
    if (!ids.length) {
      ids = CLEAN_AGENT_MODEL_PREFERENCE.map((id) => id.split("#")[0]);
      const saved = this.treeAgentModel || shared(CLEAN_AGENT_MODEL_KEY);
      if (saved && !ids.includes(saved.split("#")[0])) {
        ids.unshift(saved.split("#")[0]);
      }
    }
    const models = ids
      .filter((id) => /^[^\s/]+\/[^\s]+$/.test(id))
      .map((id) => ({
        id,
        provider: id.split("/")[0],
        label: cleanModelLabel(id),
        free: isFreeModel(id),
      }))
      .sort(
        (a, b) =>
          Number(b.free) - Number(a.free) ||
          (a.free && b.free ? cleanModelRank(a.id) - cleanModelRank(b.id) : 0) ||
          a.id.localeCompare(b.id)
      );
    this.cleanModelsCache = { at: Date.now(), root, on, models };
    return models;
  }

  /**
   * Resolve a model id: an explicit choice wins, a saved choice is used while
   * it exists, then the free preference list, then any free model. A paid
   * model is only ever used when the person chose it explicitly.
   */
  resolveCleanAgentModel(models, override = null) {
    const saved = this.treeAgentModel || shared(CLEAN_AGENT_MODEL_KEY);
    return resolveCleanAgentModelLogic(models, {
      override,
      saved,
      preferences: CLEAN_AGENT_MODEL_PREFERENCE,
    });
  }

  /** Models from the selected provider tab, or everything on the All tab. */
  cleanProviderPool(dialog) {
    const models = dialog.models || [];
    return dialog.provider ? models.filter((m) => m.provider === dialog.provider) : models;
  }

  /** What the picker shows: provider tab + search, then free-only or all, with active pinned. */
  cleanVisibleModels(dialog) {
    return filterVisibleCleanModels(dialog.models, {
      provider: dialog.provider,
      query: dialog.search,
      showAll: dialog.showAll,
      activeModel: dialog.activeModel,
    });
  }

  /** Provider tabs with their icons, like a compact browser tab strip. */
  cleanProviderTabs(dialog, t, cx) {
    const groups = new Map();
    for (const model of dialog.models || []) {
      const id = model.provider || "other";
      const group = groups.get(id) || {
        id,
        name: cleanProviderName(id),
        icon: cleanProviderIcon(id),
        count: 0,
        free: 0,
      };
      group.count += 1;
      if (model.free) group.free += 1;
      groups.set(id, group);
    }
    const providers = [...groups.values()].sort((a, b) => {
      const ai = CLEAN_PROVIDER_ORDER.indexOf(a.id);
      const bi = CLEAN_PROVIDER_ORDER.indexOf(b.id);
      return (
        (ai < 0 ? CLEAN_PROVIDER_ORDER.length : ai) -
          (bi < 0 ? CLEAN_PROVIDER_ORDER.length : bi) || a.id.localeCompare(b.id)
      );
    });

    const allModels = dialog.models || [];
    const tab = (id, name, icon, count, free) => {
      const active = (dialog.provider || null) === id;
      const tip = `${name} · ${count} model${count === 1 ? "" : "s"}${
        free > 0 ? ` · ${free} free` : ""
      }`;
      return h_flex()
        .id(id ? `model-provider-${id}` : "model-provider-all")
        .flex_none()
        .h(25)
        .px(7)
        .gap(5)
        .items_center()
        .rounded(5)
        .border_1()
        .border_color(color(active ? t.accent + "66" : t.border))
        .bg(color(active ? t.selected : t.background))
        .cursor_pointer()
        .hover((s) => s.bg(color(t.hover)))
        .tooltip(tip)
        .on_click((_e, cx) => {
          dialog.provider = id;
          const pool = this.cleanProviderPool(dialog);
          if (id && !pool.some((m) => m.free)) dialog.showAll = true;
          const visible = this.cleanVisibleModels(dialog);
          const selBase = String(dialog.selected || "").split("#")[0];
          const activeBase = String(dialog.activeModel || "").split("#")[0];
          if (activeBase && visible.some((m) => m.id === activeBase) && (!selBase || selBase === activeBase)) {
            dialog.selected = dialog.activeModel;
          } else if (!visible.some((m) => m.id === selBase)) {
            dialog.selected = visible[0]?.id || null;
          }
          cx.notify();
        })
        .child(svg(icon).size(11).text_color(color(active ? t.accent : t.dim)))
        .child(div().text_size(10).text_color(color(active ? t.accent : t.muted)).child(name));
    };

    return h_flex()
      .id("model-provider-tabs")
      .flex_none()
      .flex_wrap()
      .gap(4)
      .child(
        tab(
          null,
          "All",
          "mods/git-graph/icons/sparkles.svg",
          allModels.length,
          allModels.filter((m) => m.free).length
        )
      )
      .children(providers.map((p) => tab(p.id, p.name, p.icon, p.count, p.free)));
  }

  /**
   * Opens a model picker for the AI worker. It is used both as an explicit
   * choice (right-click the toolbar button or the branch-menu entry) and as
   * the recovery path when the preferred model cannot start.
   */
  openCleanAgentModelPicker(cx, error = null, provider = null) {
    this.closeContextMenu();
    const location = this.getLocation();
    const root = this.root || location.cwd;
    const on = this.on ?? location.on;
    const searchInput = InputState.new({ placeholder: "Search models…" });
    const currentModel = this.cleanAgentModelLabel();
    const dialog = {
      type: "clean-model",
      models: [],
      selected: currentModel,
      activeModel: currentModel,
      search: "",
      searchInput,
      provider,
      showAll: false,
      loading: true,
      error,
    };
    this.modalDialog = dialog;
    this.modalInput = searchInput;
    this.modalTagMessageInput = null;
    searchInput.on("change", (_e, cx) => {
      if (this.modalDialog !== dialog) return;
      dialog.search = searchInput.value().trim();
      const visible = this.cleanVisibleModels(dialog);
      const selBase = String(dialog.selected || "").split("#")[0];
      const activeBase = String(dialog.activeModel || "").split("#")[0];
      if (activeBase && visible.some((m) => m.id === activeBase) && (!selBase || selBase === activeBase)) {
        dialog.selected = dialog.activeModel;
      } else if (!visible.some((m) => m.id === selBase)) {
        dialog.selected = visible[0]?.id || null;
      }
      cx.notify();
    });
    searchInput.on("submit", (_e, cx) => this.submitModal(cx));
    this.focusModalInput(cx);
    cx.notify();

    cx.spawn(async (cx) => {
      const models = await this.loadCleanAgentModels(root, on, { force: true });
      if (this.modalDialog !== dialog) return;
      dialog.models = models;
      const activeModel = this.resolveCleanAgentModel(models, currentModel);
      dialog.activeModel = activeModel;
      const visible = this.cleanVisibleModels(dialog);
      const activeBase = String(activeModel || "").split("#")[0];
      if (activeModel && visible.some((m) => m.id === activeBase)) {
        dialog.selected = activeModel;
      } else {
        dialog.selected = visible[0]?.id || null;
      }
      dialog.loading = false;
      if (!models.length) dialog.error = error || "No OpenCode models were found.";
      cx.notify();
    });
  }

  /** A session id the mini UI creates, so we can follow its busy state. */
  treeAgentSessionId() {
    return `ses_gitgraph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * OpenCode Mini never reports OSC 7501 status, so poll its session. The
   * session is idle once `time.idle` is at or after `time.busy`. When it
   * settles, `checkTreeAgentFinished` decides whether the worker is done.
   *
   * Polls the background AI commit agent session for status changes.
   * Abandons hung requests after 30 s and ignores superseded poll generations.
   *
   * @param {import("./gpui-kit.js").Context} cx
   */
  pollTreeAgent(cx) {
    const agent = this.treeAgent;
    if (!agent?.sessionId || agent.finished) return;
    if (agent.polling) {
      if (agent.pollStartedAt && Date.now() - agent.pollStartedAt > 30000) {
        agent.polling = false;
      } else {
        return;
      }
    }
    const term = terminals().find((t) => t.address === agent.address);
    // A missing address means `hc run`'s JSON was unusable; follow the session
    // instead of treating the worker as already gone.
    const live = agent.address ? Boolean(term) && term.state === "live" : true;
    const elapsed = Date.now() - (agent.startedAt || 0);

    // `hc run` returns before the terminal shows up; give it a moment.
    if (!live && !agent.found && elapsed < 15000) return;
    if (!live || (!agent.found && elapsed > 30000)) {
      agent.busy = false;
      agent.idleSince = agent.idleSince || Date.now();
      this.checkTreeAgentFinished(cx, agent);
      return;
    }

    agent.polling = true;
    agent.pollStartedAt = Date.now();
    const pollGen = (agent.pollGen = (agent.pollGen || 0) + 1);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("opencode", ["api", "GET", `/api/session/${agent.sessionId}`], {
          cwd: agent.root,
          on: agent.on,
        });
        if (this.treeAgent !== agent || agent.pollGen !== pollGen) return;
        if (r.code !== 0) return;
        const payload = JSON.parse(r.stdout);
        const session = payload?.data ?? payload;
        const time = session?.time ?? {};
        const started = time.busy || time.created;
        const failed = session?.outcome === "failed" || session?.outcome === "error";
        const busy = !failed && Boolean(started) && (!time.idle || time.idle < started);
        if (this.treeAgent !== agent || agent.pollGen !== pollGen) return;
        agent.found = true;
        if (failed) {
          agent.failed = true;
          agent.busy = false;
          agent.idleSince = agent.idleSince || Date.now();
        } else if (busy) {
          agent.sawBusy = true;
          agent.idleSince = null;
        } else if (agent.busy !== false) {
          agent.idleSince = Date.now();
        }
        agent.busy = busy;
        cx.notify();
        if (!busy) this.checkTreeAgentFinished(cx, agent);
      } catch {
        // The API may not be available; the terminal-status fallback applies.
      } finally {
        if (agent.pollGen === pollGen) {
          agent.polling = false;
        }
      }
    });
  }

  /**
   * The session went idle (or the terminal ended). A clean tree means the
   * worker did its job: report the new commits and close its tab. A dirty
   * tree with a dead terminal means it failed, so offer another model.
   */
  checkTreeAgentFinished(cx, agent) {
    if (this.treeAgent !== agent || agent.finished || agent.checking) return;
    const term = terminals().find((t) => t.address === agent.address);
    const live = agent.address ? Boolean(term) && term.state === "live" : true;
    const idleMs = Date.now() - (agent.idleSince || agent.startedAt || Date.now());
    // The first poll can catch the session before its prompt starts. Only a
    // session that has been busy, or an exited terminal, may finish the run.
    const settled = live
      ? agent.failed ||
        (agent.busy === false && ((agent.sawBusy && idleMs >= 3000) || (!agent.sawBusy && idleMs >= 30000)))
      : true;
    if (!settled) return;
    if (agent.lastCheckAt && Date.now() - agent.lastCheckAt < 5000) return;
    agent.checking = true;
    agent.lastCheckAt = Date.now();

    cx.spawn(async (cx) => {
      try {
        const now = terminals().find((t) => t.address === agent.address);
        if (now && now.state === "live" && agent.busy !== false) return;

        const status = await exec(
          "git",
          [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
          { cwd: agent.root, on: agent.on }
        );
        if (this.treeAgent !== agent || agent.finished) return;
        if (status.code !== 0) return;

        if (status.stdout.trim()) {
          if ((!live || agent.failed) && !agent.retryOffered) {
            agent.retryOffered = true;
            this.treeAgent = null;
            this.treeAgentStarting = false;
            this.closeTreeAgentTab(agent);
            notify({
              title: "AI commit worker stopped",
              body: "The working tree still has changes. Choose a model to try again.",
              level: "error",
            });
            this.openCleanAgentModelPicker(
              cx,
              "The AI model stopped before the tree was clean. Choose another model to retry."
            );
            cx.notify();
          }
          return;
        }

        let commitCount = 0;
        const from = agent.headBefore;
        const countArgs = from ? ["rev-list", "--count", `${from}..HEAD`] : ["rev-list", "--count", "HEAD"];
        const count = await exec("git", countArgs, { cwd: agent.root, on: agent.on });
        if (count.code === 0) commitCount = Number(count.stdout.trim()) || 0;
        if (this.treeAgent !== agent || agent.finished) return;
        this.finishTreeAgent(agent, cx, commitCount);
      } finally {
        agent.checking = false;
        if (this.treeAgent === agent) cx.notify();
      }
    });
  }

  /** Kill the worker terminal and close the tab/pane that showed it. */
  closeTreeAgentTab(agent) {
    const address = agent?.address;
    const pane = address ? panes().find((p) => p.terminal === address) : null;
    const tab = pane ? spaces().flatMap((s) => s.tabs).find((t) => t.id === pane.tab) : null;
    if (address) run("terminal.kill", { terminal: address });
    if (tab && tab.panes <= 1) {
      run("tab.close", { id: tab.id });
    } else if (pane) {
      run("pane.close", { pane: pane.pane });
    }
  }

  /** The commits landed and the tree is clean: close the worker for good. */
  finishTreeAgent(agent, cx, commitCount) {
    if (this.treeAgent !== agent) return;
    agent.finished = true;
    this.treeAgent = null;
    this.treeAgentStarting = false;
    this.closeTreeAgentTab(agent);
    notify({
      title: "AI commit worker finished",
      body:
        commitCount > 0
          ? `${commitCount} new commit${commitCount === 1 ? "" : "s"} · working tree clean · worker tab closed`
          : "Working tree is clean · worker tab closed",
      level: "success",
    });
    this.refresh(cx);
    cx.notify();
  }

  /** A unique, human-readable `hc run` name for the cleanup terminal. */
  treeAgentName() {
    const slug =
      String(this.currentBranch || "tree")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 22) || "tree";
    const base = `clean-${slug}`.slice(0, 28);
    let name = base;
    let suffix = 2;
    while (terminals().some((t) => t.name === name && t.state === "live")) {
      name = `${base.slice(0, 28)}-${suffix++}`;
    }
    return name;
  }

  /** The first message the cleanup agent receives: current state and hard rules. */
  treeCleanupPrompt() {
    const branch = this.currentBranch || "HEAD";
    const files = this.workingTreeFiles;
    const shown = files.slice(0, 24).map((f) => {
      const status = f.status === "U" ? "conflict" : f.status;
      return `- ${status} ${f.path}`;
    });
    if (files.length > shown.length) shown.push(`- …and ${files.length - shown.length} more`);
    const op = this.inProgressOp;
    const operation = op
      ? `An operation is in progress: ${op.type}${
          op.conflicts > 0 ? ` with ${op.conflicts} conflicted file${op.conflicts === 1 ? "" : "s"}` : ""
        }.`
      : "No merge, rebase, cherry-pick, or revert is in progress.";

    return [
      `Clean the Git working tree in this repository (${this.root}).`,
      `Current branch: ${branch}.`,
      `Uncommitted files: ${files.length}.`,
      operation,
      shown.length ? `Changed paths:\n${shown.join("\n")}` : "",
      "Work only on the current branch. Do not create or switch branches or worktrees.",
      "Read the repository's AGENTS.md, CLAUDE.md, and CONTRIBUTING.md first and follow them.",
      "Load and follow the @git-change-workflow skill for commit slicing and Conventional Commit messages. This task is an explicit exception to its branch rule: commit on the current branch.",
      "If a merge, rebase, cherry-pick, or revert is in progress, understand and resolve every conflict, stage the resolutions, and complete the operation non-interactively with `git -c core.editor=true merge --continue` (or rebase/cherry-pick/revert --continue). Always pass -m to git commit.",
      "Then split the remaining changes into cohesive atomic commits, staging only the files that belong to each commit. Validate each slice when the repository has a quick check.",
      "Never run git push or any remote-writing command. Do not fetch, force-push, rewrite history, reset --hard, or discard user work. Do not run git clean or amend existing commits.",
      "When done, report the commits you created and confirm the working tree is clean. If there is nothing to commit and no operation to finish, say so and stop.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Starts OpenCode's mini interface in a background Herdr terminal. It picks
   * the best available free model, gets the current branch, dirty paths and
   * in-progress operation in its first message, plus explicit
   * no-push/no-branch-switch rules. If no free model can start, the model
   * picker opens so the person can choose one.
   */
  startTreeAgent(cx, requestedModel = null) {
    if (!this.root || this.treeAgentStarting) return;
    if (this.treeAgentBusy()) return;
    if (this.detached) {
      notify({
        title: "Cannot clean a detached HEAD",
        body: "Check out a branch before starting the cleanup agent.",
        level: "error",
      });
      return;
    }
    if (!this.workingTreeFiles.length && !this.inProgressOp) {
      notify({ title: "Working tree is clean", body: "There is nothing for the agent to commit.", level: "success" });
      return;
    }

    const root = this.root;
    const on = this.on;
    const prompt = this.treeCleanupPrompt();
    const name = this.treeAgentName();
    const sessionId = this.treeAgentSessionId();
    const space = spaces().find((s) => s.active);
    const tab = focused()?.tab;

    this.treeAgentStarting = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const headRes = await exec("git", [...READ, "rev-parse", "HEAD"], { cwd: root, on });
        const headBefore = headRes.code === 0 ? headRes.stdout.trim() : null;

        const models = await this.loadCleanAgentModels(root, on);
        const model = this.resolveCleanAgentModel(models, requestedModel);
        if (!model) {
          notify({
            title: "No free AI model is available",
            body: "Choose a model for the AI commit worker.",
            level: "error",
          });
          this.openCleanAgentModelPicker(
            cx,
            "No free model is available. Choose one of the available models to run the AI commit worker."
          );
          return;
        }
        this.treeAgentModel = model;

        const args = ["run", "--bg", "--json", "--keep", "--no-parent", "--cwd", root, "--name", name];
        if (on) args.push("--on", on);
        if (!on && space?.id) args.push("--label", `herdr.space=${space.id}`);
        if (!on && tab) args.push("--label", `herdr.tab=${tab}`);
        args.push(
          "--",
          "opencode",
          "mini",
          "--session",
          sessionId,
          "--agent",
          "build",
          "--model",
          model,
          "--prompt",
          prompt
        );

        const r = await hc(args);
        if (r.code !== 0) {
          const detail = (r.stderr || r.stdout).trim() || `hc exited with code ${r.code}`;
          throw new Error(detail);
        }

        let address = null;
        try {
          address = JSON.parse(r.stdout).address ?? null;
        } catch {}
        this.treeAgent = {
          address,
          name,
          sessionId,
          root,
          on,
          headBefore,
          model,
          startedAt: Date.now(),
          found: false,
          busy: null,
          checking: false,
          finished: false,
          retryOffered: false,
        };
        notify({
          title: `${CLEAN_AGENT_LABEL} is cleaning the tree`,
          body: `${cleanModelLabel(model)} · started ${name} in the background${
            address ? ` (${address})` : ""
          }. The worker tab closes when the commits land.`,
          level: "success",
          ...(address ? { action: { name: "terminal.peek", args: { terminal: address } } } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify({
          title: "Could not start the AI commit worker",
          body: msg.length > 600 ? `${msg.slice(0, 600)}…` : msg,
          level: "error",
        });
        this.openCleanAgentModelPicker(cx, msg);
      } finally {
        this.treeAgentStarting = false;
        cx.notify();
      }
    });
  }

  /** One AI commit-worker button for the toolbar, beside the branch controls. */
  treeAgentButton(t, cx, isCompact) {
    const status = this.treeAgentStatus();
    const busy = this.treeAgentBusy();
    const clean = !this.workingTreeFiles.length && !this.inProgressOp;
    const hardDisabled = !this.root || clean || this.detached || this.busy;
    const disabled = this.treeAgentStarting || (!busy && hardDisabled);
    const showLabel = !isCompact && this.width >= 900;
    const model = cleanModelLabel(this.cleanAgentModelLabel());

    let tip;
    if (this.treeAgentStarting) {
      tip = `Starting ${CLEAN_AGENT_LABEL} with ${model}…`;
    } else if (busy && status === "blocked") {
      tip = `${CLEAN_AGENT_LABEL} is waiting for you (${model}) · click to peek`;
    } else if (busy) {
      tip = `${CLEAN_AGENT_LABEL} is cleaning the tree with ${model} · click to peek · right-click to change model`;
    } else if (!this.root) {
      tip = "Open a Git repository first";
    } else if (this.detached) {
      tip = "Check out a branch before cleaning the tree";
    } else if (clean) {
      tip = "Working tree is clean";
    } else if (this.inProgressOp) {
      tip = `Resolve the ${this.inProgressOp.type} and commit with ${CLEAN_AGENT_LABEL} (${model}, no push)`;
    } else {
      tip = `Clean the tree with ${CLEAN_AGENT_LABEL} (${model}, free when available, no push) · right-click to choose a model`;
    }

    return h_flex()
      .id("clean-tree-agent-btn")
      .h(23)
      .flex_none()
      .items_center()
      .rounded(5)
      .border_1()
      .border_color(color(disabled ? t.border : t.accent + "66"))
      .bg(color(disabled ? t.raised : t.accent + "1f"))
      .when(showLabel, (e) => e.px(7).gap(5))
      .when(!showLabel, (e) => e.w(23).justify_center())
      .when(disabled, (e) => e.opacity(this.treeAgentStarting ? 0.75 : 0.4).cursor_not_allowed())
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(color(t.hover))))
      .accessibility_label(`Clean tree with ${CLEAN_AGENT_LABEL}${disabled ? " (unavailable)" : ""}`)
      .tooltip(tip)
      .disabled(disabled)
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        if (disabled) return;
        this.openCleanAgentModelPicker(cx);
      })
      .on_click((_e, cx) => {
        if (busy && this.treeAgent?.address) {
          run("terminal.peek", { terminal: this.treeAgent.address });
          return;
        }
        this.startTreeAgent(cx);
      })
      .child(svg("mods/git-graph/icons/sparkles.svg").size(12).text_color(color(disabled ? t.dim : t.accent)))
      .when(showLabel, (e) =>
        e.child(
          div()
            .text_size(11)
            .font_medium()
            .text_color(color(disabled ? t.dim : t.accent))
            .child(this.treeAgentStarting ? "Starting…" : busy ? "Working…" : "Clean tree")
        )
      );
  }

  renderContextMenu(t, cx) {
    const cMenu = this.contextMenu;
    if (!cMenu) return null;

    const menuItem = (id, label, icon, onClick, hint = null, disabled = false) =>
      h_flex()
        .id(id)
        .h(hint ? 30 : 26)
        .px(8)
        .gap(6)
        .items_center()
        .rounded(5)
        .when(disabled, (e) => e.opacity(0.45).cursor_not_allowed())
        .when(!disabled, (e) =>
          e
            .cursor_pointer()
            .hover((s) => s.bg(color(t.hover)))
            .on_click((_e, cx) => {
              this.closeContextMenu(cx);
              onClick(cx);
            })
        )
        .child(
          div()
            .w(14)
            .h(14)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .child(icon ? svg(icon).size(12).text_color(color(disabled ? t.muted : t.dim)) : div())
        )
        .child(
          hint
            ? v_flex()
                .flex_1()
                .min_w(0)
                .gap(1)
                .child(div().truncate().text_color(color(disabled ? t.muted : t.foreground)).child(label))
                .child(div().truncate().text_size(9).text_color(color(t.muted)).child(hint))
            : div().flex_1().truncate().child(label)
        );

    if (cMenu.type === "stash") {
      const stash = cMenu.stash;
      return div()
        .id("context-menu-backdrop")
        .absolute()
        .inset_0()
        .on_mouse_down("left", (_e, cx) => this.closeContextMenu(cx))
        .on_mouse_down("right", (_e, cx) => this.closeContextMenu(cx))
        .child(
          v_flex()
            .id("stash-context-menu")
            .absolute()
            .left(cMenu.x)
            .top(cMenu.y)
            .w(240)
            .p(4)
            .rounded(8)
            .bg(color(t.popover))
            .border_1()
            .border_color(color(t.border))
            .shadow_lg()
            .text_size(11)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
            .child(
              h_flex()
                .px(8)
                .py(4)
                .gap(6)
                .items_center()
                .child(svg("mods/git-graph/icons/stash.svg").size(12).text_color(color(t.ansi3 || t.accent)))
                .child(
                  div()
                    .flex_1()
                    .truncate()
                    .font_semibold()
                    .child(`${stash.stashRef} · ${stash.subject}`)
                )
            )
            .child(div().h(1).bg(color(t.border)).my(3))
            .child(
              menuItem("smenu-unstash", "Unstash (Pop)…", "mods/git-graph/icons/unstash.svg", (cx) =>
                this.openModal("unstash", stash, cx)
              )
            )
            .child(
              menuItem("smenu-apply", "Apply Stash (Keep)", "mods/git-graph/icons/stash.svg", (cx) =>
                this.applyStash(stash, cx)
              )
            )
            .child(
              menuItem("smenu-drop", "Drop Stash…", "mods/git-graph/icons/trash.svg", (cx) =>
                this.openModal("drop-stash", stash, cx)
              )
            )
            .child(div().h(1).bg(color(t.border)).my(3))
            .child(
              menuItem("smenu-copy-ref", "Copy Stash Ref", "mods/git-graph/icons/copy.svg", (cx) => {
                cx.write_to_clipboard(stash.stashRef);
                notify({ title: "Stash ref copied", body: stash.stashRef, level: "success", timeout: 1500 });
              })
            )
            .child(
              menuItem("smenu-copy-sha", "Copy Stash SHA", "mods/git-graph/icons/copy.svg", (cx) => {
                cx.write_to_clipboard(stash.hash);
                notify({ title: "Stash SHA copied", body: stash.shortHash, level: "success", timeout: 1500 });
              })
            )
        );
    }

    if (cMenu.type === "working-tree") {
      const count = this.workingTreeFiles.length;
      const latest = this.stashes[0] || null;
      return div()
        .id("context-menu-backdrop")
        .absolute()
        .inset_0()
        .on_mouse_down("left", (_e, cx) => this.closeContextMenu(cx))
        .on_mouse_down("right", (_e, cx) => this.closeContextMenu(cx))
        .child(
          v_flex()
            .id("working-tree-context-menu")
            .absolute()
            .left(cMenu.x)
            .top(cMenu.y)
            .w(260)
            .p(4)
            .rounded(8)
            .bg(color(t.popover))
            .border_1()
            .border_color(color(t.border))
            .shadow_lg()
            .text_size(11)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
            .child(
              h_flex()
                .px(8)
                .py(4)
                .gap(6)
                .items_center()
                .child(svg("mods/git-graph/icons/stash.svg").size(12).text_color(color(t.ansi3 || t.accent)))
                .child(
                  div()
                    .flex_1()
                    .truncate()
                    .font_semibold()
                    .child(`Working Tree · ${count} uncommitted file${count === 1 ? "" : "s"}`)
                )
            )
            .child(div().h(1).bg(color(t.border)).my(3))
            .child(
              menuItem(
                "wtmenu-stash-all",
                "Stash All Changes…",
                "mods/git-graph/icons/stash.svg",
                (cx) => this.openModal("stash", { staged: false }, cx),
                `${count} file${count === 1 ? "" : "s"} · optionally includes untracked`,
                count === 0
              )
            )
            .child(
              menuItem(
                "wtmenu-stash-staged",
                "Stash Staged Changes…",
                "mods/git-graph/icons/stash.svg",
                (cx) => this.openModal("stash", { staged: true }, cx),
                this.stagedCount > 0
                  ? `${this.stagedCount} staged file${this.stagedCount === 1 ? "" : "s"}`
                  : "Nothing staged",
                this.stagedCount === 0
              )
            )
            .child(div().h(1).bg(color(t.border)).my(3))
            .child(
              menuItem(
                "wtmenu-unstash",
                latest ? "Unstash Latest…" : "Unstash Latest",
                "mods/git-graph/icons/unstash.svg",
                (cx) => this.openModal("unstash", latest, cx),
                latest ? `${latest.ref} · ${latest.subject}` : "No stashes yet",
                !latest
              )
            )
        );
    }

    if (cMenu.type === "branch") {
      const ref = cMenu.ref;
      const isRemote = ref.kind === "remote";
      const bName = ref.text;
      const isCurrent = !isRemote && bName === this.currentBranch;

      return div()
        .id("context-menu-backdrop")
        .absolute()
        .inset_0()
        .on_mouse_down("left", (_e, cx) => this.closeContextMenu(cx))
        .on_mouse_down("right", (_e, cx) => this.closeContextMenu(cx))
        .child(
          v_flex()
            .id("branch-context-menu")
            .absolute()
            .left(cMenu.x)
            .top(cMenu.y)
            .w(260)
            .p(4)
            .rounded(8)
            .bg(color(t.popover))
            .border_1()
            .border_color(color(t.border))
            .shadow_lg()
            .text_size(11)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
            .child(
              h_flex()
                .px(8)
                .py(4)
                .gap(6)
                .items_center()
                .child(svg("mods/git-graph/icons/branch.svg").size(12).text_color(color(t.accent)))
                .child(div().flex_1().truncate().font_semibold().child(bName))
            )
            .child(div().h(1).bg(color(t.border)).my(3))
            // Checkout
            .child(
              h_flex()
                .id("bmenu-checkout")
                .h(26)
                .px(8)
                .gap(6)
                .items_center()
                .rounded(5)
                .cursor_pointer()
                .hover((s) => s.bg(color(t.hover)))
                .on_click((_e, cx) => {
                  this.closeContextMenu(cx);
                  this.busy = true;
                  cx.notify();
                  cx.spawn(async (cx) => {
                    try {
                      const args = isRemote
                        ? [...NON_INTERACTIVE, "checkout", "--track", "--end-of-options", bName]
                        : [...NON_INTERACTIVE, "checkout", "--end-of-options", bName];
                      const r = await exec("git", args, { cwd: this.root, on: this.on });
                      if (r.code === 0) {
                        notify({ title: "Checked out", body: `Switched to '${bName}'`, level: "success" });
                        this.refresh(cx);
                      } else {
                        notify({ title: "Git Error", body: (r.stderr || r.stdout).trim(), level: "error" });
                      }
                    } finally {
                      this.busy = false;
                      cx.notify();
                    }
                  });
                })
                .child(
                  div()
                    .w(14)
                    .h(14)
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(svg("mods/git-graph/icons/commit.svg").size(12).text_color(color(t.dim)))
                )
                .child(div().child(`Checkout ${isRemote ? "Tracking Branch" : "Branch"}`))
            )
            // Merge into current branch (the checked-out branch cannot merge itself)
            .child(
              h_flex()
                .id("bmenu-merge")
                .h(26)
                .px(8)
                .gap(6)
                .items_center()
                .rounded(5)
                .when(isCurrent, (e) => e.opacity(0.45).cursor_not_allowed())
                .when(!isCurrent, (e) =>
                  e
                    .cursor_pointer()
                    .hover((s) => s.bg(color(t.hover)))
                    .on_click((_e, cx) => this.openModal("confirm-merge-branch", { ref }, cx))
                )
                .child(
                  div()
                    .w(14)
                    .h(14)
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(svg("mods/git-graph/icons/merge.svg").size(12).text_color(color(isCurrent ? t.muted : t.dim)))
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_color(color(isCurrent ? t.muted : t.foreground))
                    .child(
                      isCurrent
                        ? "Merge into Current Branch (checked out)"
                        : `Merge '${bName}' into Current Branch…`
                    )
                )
            )
            // Delete branch (local only)
            .when(!isRemote, (e) =>
              e.child(
                h_flex()
                  .id("bmenu-delete")
                  .h(26)
                  .px(8)
                  .gap(6)
                  .items_center()
                  .rounded(5)
                  .cursor_pointer()
                  .hover((s) => s.bg(color(t.hover)))
                  .on_click((_e, cx) => this.openModal("confirm-delete-branch", { ref }, cx))
                  .child(
                    div()
                      .w(14)
                      .h(14)
                      .flex_none()
                      .flex()
                      .items_center()
                      .justify_center()
                      .child(svg("mods/git-graph/icons/trash.svg").size(12).text_color(color(t.ansi1)))
                  )
                  .child(div().text_color(color(t.ansi1)).child("Delete Branch…"))
              )
            )
            // Copy branch name
            .child(
              h_flex()
                .id("bmenu-copy")
                .h(26)
                .px(8)
                .gap(6)
                .items_center()
                .rounded(5)
                .cursor_pointer()
                .hover((s) => s.bg(color(t.hover)))
                .on_click((_e, cx) => {
                  cx.write_to_clipboard(bName);
                  this.closeContextMenu(cx);
                  notify({ title: "Branch copied", body: bName, level: "success", timeout: 1500 });
                })
                .child(
                  div()
                    .w(14)
                    .h(14)
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(svg("mods/git-graph/icons/copy.svg").size(12).text_color(color(t.dim)))
                )
                .child(div().child("Copy Branch Name"))
            )
        );
    }

    const commit = cMenu.commit;

    return div()
      .id("context-menu-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => this.closeContextMenu(cx))
      .on_mouse_down("right", (_e, cx) => this.closeContextMenu(cx))
      .child(
        v_flex()
          .id("commit-context-menu")
          .absolute()
          .left(cMenu.x)
          .top(cMenu.y)
          .w(240)
          .p(4)
          .rounded(8)
          .bg(color(t.popover))
          .border_1()
          .border_color(color(t.border))
          .shadow_lg()
          .text_size(11)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          // Commit summary header
          .child(
            h_flex()
              .px(8)
              .py(4)
              .gap(6)
              .items_center()
              .child(
                div()
                  .font_family(String(settings().font_family ?? "JetBrains Mono"))
                  .font_semibold()
                  .text_color(color(t.accent))
                  .child(commit.shortHash)
              )
              .child(div().flex_1().truncate().text_color(color(t.dim)).child(commit.subject))
          )
          .child(div().h(1).bg(color(t.border)).my(3))
          // 1. Checkout
          .child(menuItem("cmenu-checkout", "Checkout Commit…", "mods/git-graph/icons/commit.svg", (cx) => this.openModal("confirm-checkout", commit, cx)))
          // 2. Create Branch
          .child(menuItem("cmenu-create-branch", "Create Branch here…", "mods/git-graph/icons/branch.svg", (cx) => this.openModal("branch", commit, cx)))
          // 3. Add Tag
          .child(menuItem("cmenu-add-tag", "Add Tag here…", "mods/git-graph/icons/tag.svg", (cx) => this.openModal("tag", commit, cx)))
          // 4. Cherry Pick
          .child(menuItem("cmenu-cherry-pick", "Cherry Pick…", "mods/git-graph/icons/merge.svg", (cx) => this.openModal("confirm-cherry-pick", commit, cx)))
          // 5. Revert Commit
          .child(menuItem("cmenu-revert", "Revert Commit…", "mods/git-graph/icons/refresh.svg", (cx) => this.openModal("confirm-revert", commit, cx)))
          // 6. Reset Current Branch
          .child(menuItem("cmenu-reset", "Reset Current Branch to this Commit…", "mods/git-graph/icons/branch.svg", (cx) => this.openModal("reset", commit, cx)))
          // 7. Merge into Current Branch
          .child(menuItem("cmenu-merge", "Merge into Current Branch…", "mods/git-graph/icons/merge.svg", (cx) => this.openModal("confirm-merge", commit, cx)))
          // 8. Rebase Current Branch
          .child(menuItem("cmenu-rebase", "Rebase Current Branch on this Commit…", "mods/git-graph/icons/branch.svg", (cx) => this.openModal("confirm-rebase", commit, cx)))
          .child(div().h(1).bg(color(t.border)).my(3))
          // 9. Copy SHA
          .child(
            menuItem("cmenu-copy-sha", "Copy Commit SHA", "mods/git-graph/icons/copy.svg", (cx) => {
              cx.write_to_clipboard(commit.hash);
              notify({ title: "Commit SHA copied", body: commit.shortHash, level: "success", timeout: 1500 });
            })
          )
          // 10. Copy Subject
          .child(
            menuItem("cmenu-copy-subject", "Copy Commit Subject", "mods/git-graph/icons/copy.svg", (cx) => {
              cx.write_to_clipboard(commit.subject);
              notify({ title: "Commit subject copied", body: commit.subject, level: "success", timeout: 1500 });
            })
          )
      );
  }

  /** One private/public choice in the publish-to-GitHub modal. */
  publishVisibilityOption(value, label, hint, t, cx) {
    const selected = this.modalDialog?.visibility === value;
    return v_flex()
      .id(`publish-visibility-${value}`)
      .flex_1()
      .gap(2)
      .px(8)
      .py(6)
      .rounded(6)
      .border_1()
      .border_color(color(selected ? t.accent : t.border))
      .bg(color(selected ? t.selected : t.background))
      .cursor_pointer()
      .hover((s) => s.bg(color(selected ? t.selected : t.hover)))
      .on_click((_e, cx) => {
        if (this.modalDialog) this.modalDialog.visibility = value;
        cx.notify();
      })
      .child(
        div()
          .font_semibold()
          .text_size(11)
          .text_color(color(selected ? t.foreground : t.dim))
          .child(label)
      )
      .child(div().text_size(9.5).text_color(color(t.muted)).child(hint));
  }

  renderModalDialog(t, cx) {
    const dialog = this.modalDialog;
    if (!dialog) return null;

    const commit = dialog.commit;
    const isConfirm = dialog.type.startsWith("confirm-");
    // The panel is narrower than the tab; keep the dialog inside the card.
    const dialogWidth = this.width > 0 ? Math.min(400, Math.max(280, this.width - 24)) : 400;
    const providerPool = dialog.type === "clean-model" ? this.cleanProviderPool(dialog) : [];
    const freeModels = providerPool.filter((m) => m.free);
    const modelQuery = String(dialog.search || "").trim().toLowerCase();
    const shownModels = dialog.type === "clean-model" ? this.cleanVisibleModels(dialog) : [];
    const selectedBase = String(dialog.selected || "").split("#")[0];
    // A fixed frame keeps the header, hint and buttons on screen while the
    // model list scrolls inside it, even in a short docked panel.
    const modelDialog = dialog.type === "clean-model";
    const availableHeight = this.height > 0 ? this.height - 24 : 560;
    const modelDialogHeight = Math.max(220, Math.min(560, availableHeight));

    return div()
      .id("modal-backdrop")
      .absolute()
      .inset_0()
      .bg(color(t.background + "99"))
      .flex()
      .items_center()
      .justify_center()
      .on_mouse_down("left", (_e, cx) => this.closeModal(cx))
      .child(
        v_flex()
          .id("modal-dialog")
          .w(dialogWidth)
          .when(modelDialog, (e) => e.h(modelDialogHeight))
          .p(16)
          .rounded(10)
          .bg(color(t.raised))
          .border_1()
          .border_color(color(t.border))
          .shadow_lg()
          .gap(12)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          // Modal Header
          .child(
            v_flex()
              .flex_none()
              .gap(4)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .gap(8)
                  .child(
                    div()
                      .font_semibold()
                      .text_size(13)
                      .text_color(color(t.foreground))
                      .child(
                        dialog.type === "clean-model"
                          ? "AI commit model"
                          : dialog.type === "stash"
                          ? dialog.stashStaged
                            ? "Stash Staged Changes"
                            : "Stash All Changes"
                          : dialog.type === "unstash"
                          ? `Unstash ${dialog.stashRef || "Latest"}`
                          : dialog.type === "drop-stash"
                          ? `Drop ${dialog.stashRef || "Stash"}`
                          : dialog.type === "publish"
                          ? "Publish to GitHub"
                          : dialog.type === "branch"
                          ? `Create Branch at ${commit.shortHash}`
                          : dialog.type === "tag"
                          ? `Add Tag at ${commit.shortHash}`
                          : dialog.type === "reset"
                          ? `Reset '${this.currentBranch || "HEAD"}' to ${commit.shortHash}`
                          : dialog.type === "confirm-checkout"
                          ? `Checkout Commit ${commit.shortHash}`
                          : dialog.type === "confirm-cherry-pick"
                          ? `Cherry-pick Commit ${commit.shortHash}`
                          : dialog.type === "confirm-revert"
                          ? `Revert Commit ${commit.shortHash}`
                          : dialog.type === "confirm-merge"
                          ? `Merge into '${this.currentBranch || "HEAD"}'`
                          : dialog.type === "confirm-merge-branch"
                          ? `Merge '${dialog.ref?.text || "branch"}' into '${this.currentBranch || "HEAD"}'`
                          : dialog.type === "confirm-rebase"
                          ? `Rebase '${this.currentBranch || "HEAD"}' on ${commit.shortHash}`
                          : dialog.type === "confirm-delete-branch"
                          ? `Delete Branch '${dialog.ref?.text}'`
                          : "Confirm Action"
                      )
                  )
                  .when(
                    dialog.type === "clean-model" && Boolean(dialog.activeModel || this.cleanAgentModelLabel()),
                    (el) => {
                      const cur = dialog.activeModel || this.cleanAgentModelLabel();
                      return el.child(
                        h_flex()
                          .id("model-active-badge")
                          .px(6)
                          .py(1.5)
                          .gap(4)
                          .rounded(4)
                          .items_center()
                          .bg(color(t.accent + "18"))
                          .border_1()
                          .border_color(color(t.accent + "44"))
                          .tooltip(`Currently active model: ${cur}`)
                          .child(
                            div()
                              .text_size(9)
                              .text_color(color(t.muted))
                              .child("Active:")
                          )
                          .child(
                            div()
                              .text_size(9.5)
                              .font_medium()
                              .text_color(color(t.accent))
                              .child(cleanModelLabel(cur))
                          )
                      );
                    }
                  )
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(color(t.muted))
                  .child(
                    dialog.type === "clean-model"
                      ? `Currently configured to use ${cleanModelLabel(dialog.activeModel || this.cleanAgentModelLabel())}. Choose a model or click Start agent.`
                      : dialog.type === "stash"
                      ? dialog.stashStaged
                        ? "Save only the staged changes to a new stash, leaving unstaged edits in place"
                        : `Save ${this.workingTreeFiles.length} uncommitted file${this.workingTreeFiles.length === 1 ? "" : "s"} to a new stash`
                      : dialog.type === "unstash"
                      ? `Apply "${dialog.stashSubject || dialog.stashRef}" and remove it from the stash list`
                      : dialog.type === "drop-stash"
                      ? `Permanently remove "${dialog.stashSubject || dialog.stashRef}" from the stash list`
                      : dialog.type === "publish"
                      ? `Create a new GitHub repository${dialog.account ? ` as @${dialog.account}` : ""} and push '${this.currentBranch}'`
                      : dialog.type === "branch"
                      ? `Create a new branch pointing to commit ${commit.shortHash}`
                      : dialog.type === "tag"
                      ? `Create a tag at commit ${commit.shortHash} (annotated if message is provided)`
                      : dialog.type === "reset"
                      ? `Reset the current branch HEAD to commit ${commit.shortHash}`
                      : dialog.type === "confirm-checkout"
                      ? `Switch repository working directory to commit ${commit.shortHash} (${commit.subject})`
                      : dialog.type === "confirm-cherry-pick"
                      ? `Apply the changes introduced by ${commit.shortHash} onto '${this.currentBranch}'`
                      : dialog.type === "confirm-revert"
                      ? `Create a new commit reverting changes from ${commit.shortHash}`
                      : dialog.type === "confirm-merge"
                      ? `Merge commit ${commit.shortHash} ("${commit.subject}") into '${this.currentBranch}'`
                      : dialog.type === "confirm-merge-branch"
                      ? `Merge branch '${dialog.ref?.text}' into the current branch '${this.currentBranch}'`
                      : dialog.type === "confirm-rebase"
                      ? `Rebase current branch '${this.currentBranch}' onto ${commit.shortHash}`
                      : dialog.type === "confirm-delete-branch"
                      ? `Permanently delete branch '${dialog.ref?.text}'`
                      : ""
                  )
              )
          )
          // Warnings for mutations
          .when(dialog.type === "confirm-checkout", (e) =>
            e.child(
              v_flex()
                .gap(2)
                .p(8)
                .rounded(6)
                .bg(color(t.ansi3 + "18"))
                .border_1()
                .border_color(color(t.ansi3 + "44"))
                .text_size(10.5)
                .text_color(color(t.ansi3))
                .child("⚠️ Checking out a commit directly will detach HEAD.")
                .when(this.workingTreeFiles.length > 0, (el) =>
                  el.child("Notice: Uncommitted changes exist and may conflict or be carried over.")
                )
            )
          )
          .when(dialog.type === "confirm-rebase", (e) =>
            e.child(
              div()
                .p(8)
                .rounded(6)
                .bg(color(t.ansi3 + "18"))
                .border_1()
                .border_color(color(t.ansi3 + "44"))
                .text_size(10.5)
                .text_color(color(t.ansi3))
                .child("⚠️ Rebasing rewrites commit history on the current branch.")
            )
          )
          .when(dialog.type === "unstash", (e) =>
            e.child(
              v_flex()
                .gap(3)
                .p(8)
                .rounded(6)
                .bg(color(t.ansi3 + "18"))
                .border_1()
                .border_color(color(t.ansi3 + "44"))
                .text_size(10.5)
                .text_color(color(t.ansi3))
                .child(`Applies ${dialog.stashRef} with --index and removes it from the stash list.`)
                .when(this.workingTreeFiles.length > 0, (el) =>
                  el.child("The working tree has uncommitted changes; restoring may conflict.")
                )
            )
          )
          .when(dialog.type === "drop-stash", (e) =>
            e.child(
              div()
                .p(8)
                .rounded(6)
                .bg(color(t.ansi1 + "18"))
                .border_1()
                .border_color(color(t.ansi1 + "44"))
                .text_size(10.5)
                .text_color(color(t.ansi1))
                .child("⚠️ Dropping a stash permanently removes the saved changes. This cannot be undone.")
            )
          )
          // Inline error display
          .when(Boolean(dialog.error), (e) =>
            e.child(
              div()
                .flex_none()
                .p(6)
                .rounded(4)
                .bg(color(t.ansi1 + "20"))
                .border_1()
                .border_color(color(t.ansi1 + "60"))
                .text_size(11)
                .text_color(color(t.ansi1))
                .child(dialog.error || "")
            )
          )
          // AI model picker: free models first, with its own search.
          .when(dialog.type === "clean-model", (e) =>
            e.child(
              v_flex()
                .flex_1()
                .min_h(0)
                .gap(6)
                .when(!dialog.loading, (el) => el.child(this.cleanProviderTabs(dialog, t, cx)))
                .child(
                  h_flex()
                    .id("model-search")
                    .flex_none()
                    .h(30)
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(6)
                    .border_1()
                    .border_color(color(t.border))
                    .bg(color(t.background))
                    .child(svg("mods/git-graph/icons/search.svg").size(11).text_color(color(t.dim)))
                    .child(
                      Input.new(dialog.searchInput)
                        .flex_1()
                        .h_full()
                        .text_size(11)
                        .text_color(color(t.foreground))
                    )
                    .when(Boolean(dialog.search), (el) =>
                      el.child(
                        div()
                          .id("model-search-clear")
                          .px(4)
                          .cursor_pointer()
                          .text_size(11)
                          .text_color(color(t.muted))
                          .hover((s) => s.text_color(color(t.foreground)))
                          .on_click((_e, cx) => {
                            dialog.searchInput?.set_value("");
                            dialog.search = "";
                            const visible = this.cleanVisibleModels(dialog);
                            const selBase = String(dialog.selected || "").split("#")[0];
                            const activeBase = String(dialog.activeModel || "").split("#")[0];
                            if (activeBase && visible.some((m) => m.id === activeBase) && (!selBase || selBase === activeBase)) {
                              dialog.selected = dialog.activeModel;
                            } else if (!visible.some((m) => m.id === selBase)) {
                              dialog.selected = visible[0]?.id || null;
                            }
                            cx.notify();
                          })
                          .child("×")
                      )
                    )
                )
                .when(dialog.loading, (el) =>
                  el.child(
                    h_flex()
                      .flex_1()
                      .min_h(0)
                      .p(12)
                      .items_center()
                      .child(div().text_size(11).text_color(color(t.muted)).child("Loading models from opencode…"))
                  )
                )
                .when(!dialog.loading, (el) =>
                  el.child(
                    v_flex()
                      .flex_1()
                      .min_h(0)
                      .gap(4)
                      .child(
                        v_flex()
                          .id("modal-model-list")
                          .flex_1()
                          .min_h(0)
                          .gap(2)
                          .overflow_y_scrollbar()
                          .mode("always")
                          .when(shownModels.length === 0, (list) =>
                            list.child(
                              div()
                                .flex_none()
                                .p(8)
                                .text_size(11)
                                .text_color(color(t.muted))
                                .child(
                                  modelQuery
                                    ? `No models match “${dialog.search.trim()}”.`
                                    : "No models found. Check that the opencode CLI is available."
                                )
                            )
                          )
                          .children(
                            shownModels.map((m, i) => {
                              const active = selectedBase === m.id;
                              const isActiveModel = m.id === String(dialog.activeModel || "").split("#")[0];
                              return h_flex()
                                .id(`model-opt-${i}`)
                                .flex_none()
                                .px(8)
                                .py(5)
                                .gap(8)
                                .items_center()
                                .rounded(5)
                                .border_1()
                                .border_color(color(active ? t.accent : t.border))
                                .bg(color(active ? t.selected : t.background))
                                .cursor_pointer()
                                .hover((s) => s.bg(color(t.hover)))
                                .on_click((_e, cx) => {
                                  dialog.selected = m.id;
                                  dialog.error = null;
                                  cx.notify();
                                })
                                .child(
                                  v_flex()
                                    .flex_1()
                                    .min_w(0)
                                    .child(
                                      div()
                                        .truncate()
                                        .text_size(11)
                                        .font_medium()
                                        .text_color(color(active ? t.accent : t.foreground))
                                        .child(m.label)
                                    )
                                    .child(div().truncate().text_size(9).text_color(color(t.muted)).child(m.id))
                                )
                                .when(isActiveModel, (el) =>
                                  el.child(
                                    div()
                                      .px(4)
                                      .py(1)
                                      .rounded(3)
                                      .bg(color(t.accent + "22"))
                                      .text_size(8)
                                      .font_semibold()
                                      .text_color(color(t.accent))
                                      .tooltip("Currently active model")
                                      .child("ACTIVE")
                                  )
                                )
                                .when(m.free, (el) =>
                                  el.child(
                                    div()
                                      .px(4)
                                      .py(1)
                                      .rounded(3)
                                      .bg(color(t.ansi2 + "22"))
                                      .text_size(8)
                                      .font_medium()
                                      .text_color(color(t.ansi2))
                                      .child("FREE")
                                  )
                                )
                                .when(active, (el) =>
                                  el.child(svg("mods/git-graph/icons/check.svg").size(12).text_color(color(t.accent)))
                                );
                            })
                          )
                      )
                      .when(!modelQuery && freeModels.length > 0 && providerPool.length > freeModels.length, (body) =>
                        body.child(
                          h_flex()
                            .id("model-show-all")
                            .flex_none()
                            .h(24)
                            .px(8)
                            .items_center()
                            .rounded(5)
                            .cursor_pointer()
                            .hover((s) => s.bg(color(t.hover)))
                            .on_click((_e, cx) => {
                              dialog.showAll = !dialog.showAll;
                              const visible = this.cleanVisibleModels(dialog);
                              const selBase = String(dialog.selected || "").split("#")[0];
                              const activeBase = String(dialog.activeModel || "").split("#")[0];
                              if (activeBase && visible.some((m) => m.id === activeBase) && (!selBase || selBase === activeBase)) {
                                dialog.selected = dialog.activeModel;
                              } else if (!visible.some((m) => m.id === selBase)) {
                                dialog.selected = visible[0]?.id || null;
                              }
                              cx.notify();
                            })
                            .child(
                              div()
                                .text_size(10)
                                .text_color(color(t.accent))
                                .child(
                                  dialog.showAll
                                    ? "Show free models only"
                                    : `Show all ${providerPool.length} models`
                                )
                            )
                        )
                      )
                      .child(
                        div()
                          .flex_none()
                          .text_size(9)
                          .text_color(color(t.muted))
                          .child("Free models are used automatically. The worker commits on the current branch and never pushes.")
                      )
                  )
                )
            )
          )
          // Branch inputs: Name + Checkout toggle
          .when(dialog.type === "branch", (e) =>
            e
              .child(
                Input.new(this.modalInput)
                  .id("modal-branch-input")
                  .h(32)
                  .w_full()
                  .px(8)
                  .rounded(6)
                  .border_1()
                  .border_color(color(t.border))
                  .bg(color(t.background))
                  .text_size(12)
                  .text_color(color(t.foreground))
              )
              .child(
                h_flex()
                  .id("modal-branch-checkout-toggle")
                  .gap(6)
                  .items_center()
                  .cursor_pointer()
                  .on_click((_e, cx) => {
                    this.modalDialog.checkoutAfterCreate = !this.modalDialog.checkoutAfterCreate;
                    cx.notify();
                  })
                  .child(
                    div()
                      .size(14)
                      .rounded(3)
                      .border_1()
                      .border_color(color(this.modalDialog.checkoutAfterCreate ? t.accent : t.border))
                      .bg(color(this.modalDialog.checkoutAfterCreate ? t.accent : t.background))
                      .flex()
                      .items_center()
                      .justify_center()
                      .when(this.modalDialog.checkoutAfterCreate, (el) =>
                        el.child(div().size(6).rounded_full().bg(color(t.accent_foreground)))
                      )
                  )
                  .child(div().text_size(11).text_color(color(t.dim)).child("Checkout after creating"))
              )
          )
          // Tag inputs: Name + Optional message
          .when(dialog.type === "tag", (e) =>
            e
              .child(
                Input.new(this.modalInput)
                  .id("modal-tag-input")
                  .h(32)
                  .w_full()
                  .px(8)
                  .rounded(6)
                  .border_1()
                  .border_color(color(t.border))
                  .bg(color(t.background))
                  .text_size(12)
                  .text_color(color(t.foreground))
              )
              .child(
                Input.new(this.modalTagMessageInput)
                  .id("modal-tag-message-input")
                  .h(32)
                  .w_full()
                  .px(8)
                  .rounded(6)
                  .border_1()
                  .border_color(color(t.border))
                  .bg(color(t.background))
                  .text_size(12)
                  .text_color(color(t.foreground))
              )
          )
          // Publish inputs: repository name + visibility
          .when(dialog.type === "publish", (e) =>
            e.child(
              v_flex()
                .gap(8)
                .child(
                  v_flex()
                    .gap(4)
                    .child(div().text_size(10.5).text_color(color(t.muted)).child("Repository name"))
                    .child(
                      Input.new(this.modalInput)
                        .id("modal-publish-name-input")
                        .h(32)
                        .w_full()
                        .px(8)
                        .rounded(6)
                        .border_1()
                        .border_color(color(t.border))
                        .bg(color(t.background))
                        .text_size(12)
                        .text_color(color(t.foreground))
                    )
                    .child(
                      div()
                        .text_size(10)
                        .text_color(color(t.muted))
                        .child("Suggested from the folder name. Letters, digits, dots, dashes, underscores, and owner/name are allowed.")
                    )
                )
                .child(
                  v_flex()
                    .gap(4)
                    .child(div().text_size(10.5).text_color(color(t.muted)).child("Visibility"))
                    .child(
                      h_flex()
                        .gap(6)
                        .child(this.publishVisibilityOption("private", "Private", "Only you can see it", t, cx))
                        .child(this.publishVisibilityOption("public", "Public", "Anyone can see it", t, cx))
                    )
                )
                .child(
                  div()
                    .text_size(10)
                    .text_color(color(t.muted))
                    .child("Creates the repository with gh, then pushes this branch and sets its upstream.")
                )
            )
          )
          // Stash inputs: optional message and untracked-files choice.
          .when(dialog.type === "stash", (e) =>
            e
              .child(
                Input.new(this.modalInput)
                  .id("modal-stash-message-input")
                  .h(32)
                  .w_full()
                  .px(8)
                  .rounded(6)
                  .border_1()
                  .border_color(color(t.border))
                  .bg(color(t.background))
                  .text_size(12)
                  .text_color(color(t.foreground))
              )
              .when(!dialog.stashStaged, (el) =>
                el.child(
                  h_flex()
                    .id("modal-stash-untracked-toggle")
                    .gap(6)
                    .items_center()
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      this.modalDialog.includeUntracked = !this.modalDialog.includeUntracked;
                      cx.notify();
                    })
                    .child(
                      div()
                        .size(14)
                        .rounded(3)
                        .border_1()
                        .border_color(color(this.modalDialog.includeUntracked ? t.accent : t.border))
                        .bg(color(this.modalDialog.includeUntracked ? t.accent : t.background))
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(this.modalDialog.includeUntracked, (box) =>
                          box.child(div().size(6).rounded_full().bg(color(t.accent_foreground)))
                        )
                    )
                    .child(div().text_size(11).text_color(color(t.dim)).child("Include untracked files"))
                )
              )
              .child(
                div()
                  .text_size(10)
                  .text_color(color(t.muted))
                  .child(
                    dialog.stashStaged
                      ? "Only staged changes are saved; unstaged edits stay in the working tree."
                      : dialog.includeUntracked
                      ? "Untracked files are included in the stash."
                      : "Untracked files stay in the working tree."
                  )
              )
          )
          // Reset options
          .when(dialog.type === "reset", (e) =>
            e.child(
              v_flex()
                .gap(6)
                .child(
                  h_flex()
                    .id("reset-opt-mixed")
                    .px(8)
                    .py(6)
                    .rounded(6)
                    .border_1()
                    .border_color(color(dialog.resetMode === "mixed" ? t.accent : t.border))
                    .bg(color(dialog.resetMode === "mixed" ? t.selected : t.background))
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      this.modalDialog.resetMode = "mixed";
                      cx.notify();
                    })
                    .child(
                      v_flex()
                        .gap(2)
                        .child(div().font_semibold().text_size(11).child("Mixed (--mixed) · Default"))
                        .child(
                          div()
                            .text_size(10)
                            .text_color(color(t.muted))
                            .child("Keeps working directory changes, resets staging index")
                        )
                    )
                )
                .child(
                  h_flex()
                    .id("reset-opt-soft")
                    .px(8)
                    .py(6)
                    .rounded(6)
                    .border_1()
                    .border_color(color(dialog.resetMode === "soft" ? t.accent : t.border))
                    .bg(color(dialog.resetMode === "soft" ? t.selected : t.background))
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      this.modalDialog.resetMode = "soft";
                      cx.notify();
                    })
                    .child(
                      v_flex()
                        .gap(2)
                        .child(div().font_semibold().text_size(11).child("Soft (--soft)"))
                        .child(
                          div()
                            .text_size(10)
                            .text_color(color(t.muted))
                            .child("Keeps all working tree and staging index changes intact")
                        )
                    )
                )
                .child(
                  h_flex()
                    .id("reset-opt-hard")
                    .px(8)
                    .py(6)
                    .rounded(6)
                    .border_1()
                    .border_color(color(dialog.resetMode === "hard" ? t.ansi1 : t.border))
                    .bg(color(dialog.resetMode === "hard" ? t.ansi1 + "20" : t.background))
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      this.modalDialog.resetMode = "hard";
                      cx.notify();
                    })
                    .child(
                      v_flex()
                        .gap(2)
                        .child(
                          div()
                            .font_semibold()
                            .text_size(11)
                            .text_color(color(t.ansi1))
                            .child("Hard (--hard) · Destructive")
                        )
                        .child(
                          div()
                            .text_size(10)
                            .text_color(color(t.muted))
                            .child("⚠️ Discards all uncommitted and staged changes permanently")
                        )
                    )
                )
            )
          )
          // Modal Action Buttons
          .child(
            h_flex()
              .flex_none()
              .gap(8)
              .justify_end()
              .child(
                div()
                  .id("modal-cancel-btn")
                  .px(10)
                  .py(5)
                  .rounded(6)
                  .cursor_pointer()
                  .hover((s) => s.bg(color(t.hover)))
                  .text_size(11)
                  .text_color(color(t.dim))
                  .on_click((_e, cx) => this.closeModal(cx))
                  .child("Cancel")
              )
              .child(
                div()
                  .id("modal-submit-btn")
                  .px(12)
                  .py(5)
                  .rounded(6)
                  .cursor_pointer()
                  .bg(color(
                    dialog.type === "reset" && dialog.resetMode === "hard"
                      ? t.ansi1
                      : dialog.type === "confirm-delete-branch" || dialog.type === "drop-stash"
                      ? t.ansi1
                      : t.solid
                  ))
                  .text_color(color(t.solid_foreground))
                  .text_size(11)
                  .font_semibold()
                  .when(dialog.type === "clean-model", (el) => {
                    const chosen = dialog.selected || dialog.activeModel;
                    const clean = !this.workingTreeFiles.length && !this.inProgressOp;
                    return el.tooltip(
                      chosen
                        ? `${clean ? "Save" : "Start AI worker with"} ${cleanModelLabel(chosen)}`
                        : "Choose a model first"
                    );
                  })
                  .on_click((_e, cx) => this.submitModal(cx))
                  .child(
                    this.busy
                      ? dialog.type === "publish"
                        ? "Publishing…"
                        : dialog.type === "stash"
                        ? "Stashing…"
                        : dialog.type === "unstash"
                        ? "Unstashing…"
                        : dialog.type === "drop-stash"
                        ? "Dropping…"
                        : "Working…"
                      : dialog.type === "clean-model"
                      ? (!this.workingTreeFiles.length && !this.inProgressOp
                          ? "Save model"
                          : dialogWidth >= 340
                          ? `Start agent (${cleanModelLabel(dialog.selected || dialog.activeModel)})`
                          : "Start agent")
                      : dialog.type === "stash"
                      ? dialog.stashStaged
                        ? "Stash Staged"
                        : "Stash Changes"
                      : dialog.type === "unstash"
                      ? "Unstash"
                      : dialog.type === "drop-stash"
                      ? "Drop Stash"
                      : dialog.type === "publish"
                      ? "Create & Push"
                      : dialog.type === "branch"
                      ? "Create Branch"
                      : dialog.type === "tag"
                      ? "Add Tag"
                      : dialog.type === "reset"
                      ? "Reset Branch"
                      : dialog.type === "confirm-checkout"
                      ? "Checkout"
                      : dialog.type === "confirm-cherry-pick"
                      ? "Cherry Pick"
                      : dialog.type === "confirm-revert"
                      ? "Revert"
                      : dialog.type === "confirm-merge"
                      ? "Merge"
                      : dialog.type === "confirm-merge-branch"
                      ? "Merge"
                      : dialog.type === "confirm-rebase"
                      ? "Rebase"
                      : dialog.type === "confirm-delete-branch"
                      ? "Delete Branch"
                      : "Confirm"
                  )
              )
          )
      );
  }

  renderInProgressBanner(t, cx) {
    if (!this.inProgressOp) return null;
    const op = this.inProgressOp;
    const opName = op.type.charAt(0).toUpperCase() + op.type.slice(1);

    return h_flex()
      .id("in-progress-banner")
      .h(34)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .bg(color(t.ansi3 + "22"))
      .border_b(1)
      .border_color(color(t.ansi3 + "66"))
      .child(svg("mods/git-graph/icons/refresh.svg").size(14).text_color(color(t.ansi3)))
      .child(
        div()
          .text_size(11.5)
          .font_semibold()
          .text_color(color(t.foreground))
          .child(
            `${opName} in progress${op.conflicts > 0 ? ` — ${op.conflicts} conflicted file${op.conflicts === 1 ? "" : "s"}` : ""}`
          )
      )
      .child(div().flex_1())
      .child(
        div()
          .id("banner-continue-btn")
          .px(10)
          .py(3)
          .rounded(4)
          .cursor_pointer()
          .bg(color(t.solid))
          .text_color(color(t.solid_foreground))
          .text_size(11)
          .font_medium()
          .on_click((_e, cx) => this.continueOperation(cx))
          .child(this.busy ? "Working…" : "Continue")
      )
      .child(
        div()
          .id("banner-abort-btn")
          .px(10)
          .py(3)
          .rounded(4)
          .cursor_pointer()
          .bg(color(t.raised))
          .border_1()
          .border_color(color(t.border))
          .text_color(color(t.ansi1))
          .text_size(11)
          .font_medium()
          .on_click((_e, cx) => this.abortOperation(cx))
          .child(this.busy ? "Working…" : "Abort")
      );
  }

  render(cx) {
    if (this.diffMode) {
      const visible = this.isViewVisible();
      const justOpened = visible && !this.wasVisible;
      this.wasVisible = visible;
      // Never reload (and notify) during the render pass; defer to the loop.
      if (justOpened && this.diffKind === "worktree") cx.spawn(async (cx) => this.loadDiffTab(cx));
      return this.renderDiffTab(cx);
    }
    const visible = this.isViewVisible();
    const justOpened = visible && !this.wasVisible;
    this.wasVisible = visible;
    if (justOpened || this.getKey() !== this.context) this.refresh(cx);
    const t = theme();
    const p = props();
    // Docked in a layout panel (Herdr's Changes slot, for example): draw a card
    // like the Files panel and offer a way to open the full graph in a tab.
    const panelMode = Boolean(p?.panel);
    const isCompact = Boolean(p?.compact) || (this.width > 0 && this.width < 560);
    const showWorkingTree = this.shouldShowWorkingTree();
    const laneWidth = 16;
    const graphWidth = Math.max(64, (this.maxLane + 1) * laneWidth + 24);
    const count = this.commits.length;

    let branchLabel = "All branches";
    if (this.branchFilter === "current") {
      branchLabel = `Current (${this.currentBranch || "HEAD"})`;
    } else if (this.branchFilter !== "all") {
      branchLabel = this.branchFilter;
    }

    return v_flex()
      .id("git-graph")
      .size_full()
      .relative()
      .min_h(0)
      .bg(color(t.background))
      .text_color(color(t.foreground))
      .text_size(13)
      .when(panelMode, (e) =>
        e.rounded(10).overflow_hidden().border_1().border_color(color(t.border))
      )
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.handleKeyDown(e, cx))
      .on_mouse_move((e, _cx) => {
        if (e.bounds) this.rootBounds = e.bounds;
        if (e.position && e.local_position) {
          this.rootOrigin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
        }
      })
      .on_mouse_down("left", (e, _cx) => {
        if (e.bounds) this.rootBounds = e.bounds;
        if (e.position && e.local_position) {
          this.rootOrigin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
        }
      })
      .on_mouse_down("right", (e, _cx) => {
        if (e.bounds) this.rootBounds = e.bounds;
        if (e.position && e.local_position) {
          this.rootOrigin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
        }
      })
      .on_size_change((size, cx) => this.updateSize(size, cx))
      // In-progress Operation Banner
      .when(Boolean(this.inProgressOp), (e) => e.child(this.renderInProgressBanner(t, cx)))
      // Toolbar
      .child(
        h_flex()
          .id("graph-toolbar")
          .h(40)
          .flex_none()
          .px(isCompact ? 8 : 10)
          .gap(isCompact ? 5 : 8)
          .items_center()
          .border_b(1)
          .border_color(color(t.border))
          // Brand & Icon
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(svg("mods/git-graph/icons/branch.svg").size(15).text_color(color(t.accent)))
              .when(!isCompact, (e) =>
                e.child(div().font_semibold().text_size(13).child("Git Graph"))
              )
          )
          // Branch Selection Dropdown Trigger
          .child(
            h_flex()
              .id("branch-dropdown-btn")
              .px(8)
              .py(3)
              .gap(5)
              .items_center()
              .rounded(5)
              .cursor_pointer()
              .bg(color(t.raised))
              .border_1()
              .border_color(color(t.border))
              .text_size(11)
              .when(isCompact, (e) => e.flex_1().min_w(0))
              .hover((s) => s.bg(color(t.hover)))
              .tooltip(
                (this.upstream
                  ? `${branchLabel} · tracking ${this.upstream}${
                      this.ahead > 0 ? ` · ${this.ahead} ahead` : ""
                    }${this.behind > 0 ? ` · ${this.behind} behind` : ""}`
                  : `${branchLabel} · no upstream`) +
                  (this.stashes.length
                    ? ` · ${this.stashes.length} stash${this.stashes.length === 1 ? "" : "es"}`
                    : "")
              )
              .on_click((_e, cx) => {
                this.branchDropdownOpen = !this.branchDropdownOpen;
                cx.notify();
              })
              .child(svg("mods/git-graph/icons/branch.svg").size(11).text_color(color(t.accent)))
              .child(
                div()
                  .when(isCompact, (e) => e.flex_1().min_w(0))
                  .when(!isCompact, (e) => e.max_w(130))
                  .truncate()
                  .child(branchLabel)
              )
              .when(!isCompact && this.ahead > 0, (e) =>
                e.child(div().text_size(10).text_color(color(t.ansi2)).child(`↑${this.ahead}`))
              )
              .when(!isCompact && this.behind > 0, (e) =>
                e.child(div().text_size(10).text_color(color(t.ansi1)).child(`↓${this.behind}`))
              )
              .when(!isCompact && this.stashes.length > 0, (e) =>
                e.child(
                  h_flex()
                    .gap(2)
                    .items_center()
                    .child(svg("mods/git-graph/icons/stash.svg").size(10).text_color(color(t.ansi3 || t.dim)))
                    .child(div().text_size(9).text_color(color(t.muted)).child(`${this.stashes.length}`))
                )
              )
              .child(svg("mods/git-graph/icons/chevron-down.svg").size(10).text_color(color(t.dim)))
          )
          // Fetch / Pull / Push shortcuts
          .child(
            h_flex()
              .id("remote-actions")
              .gap(4)
              .items_center()
              .child(this.remoteActionButton("fetch", t, cx))
              .child(this.remoteActionButton("pull", t, cx))
              .child(this.remoteActionButton("push", t, cx))
          )
          .child(div().w(1).h(16).flex_none().bg(color(t.border)))
          // AI commit worker (best free model, closes its tab when done)
          .child(this.treeAgentButton(t, cx, isCompact))
          // Search Box (Expanded when not compact, or when searchOpen in compact mode)
          .when(!isCompact, (e) =>
            e.child(
              div()
                .id("graph-search")
                .w(180)
                .h(28)
                .px(8)
                .flex()
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(color(t.border))
                .cursor_text()
                .child(Input.new(this.searchInput).h_full().text_size(11).text_color(color(t.foreground)))
            )
          )
          .when(!isCompact, (e) => e.child(div().flex_1()))
          // Compact search toggle button
          .when(isCompact, (e) =>
            e.child(
              div()
                .id("search-toggle-btn")
                .px(7)
                .py(3)
                .rounded(5)
                .cursor_pointer()
                .bg(color(this.searchOpen || this.searchQuery ? t.accent + "26" : t.raised))
                .border_1()
                .border_color(color(this.searchOpen || this.searchQuery ? t.accent : t.border))
                .hover((s) => s.bg(color(t.hover)))
                .on_click((_e, cx) => {
                  this.searchOpen = !this.searchOpen;
                  if (this.searchOpen) {
                    this.searchInput?.focus();
                  } else {
                    this.clearSearch(cx);
                  }
                  cx.notify();
                })
                .child(
                  svg("mods/git-graph/icons/search.svg")
                    .size(12)
                    .text_color(color(this.searchOpen || this.searchQuery ? t.accent : t.dim))
                )
            )
          )
          // Commit counter
          .when(!isCompact, (e) =>
            e.child(
              div()
                .text_size(11)
                .text_color(color(t.muted))
                .child(this.loading ? "Loading…" : `${count} commit${count === 1 ? "" : "s"}`)
            )
          )
          // Refresh Button
          .child(
            div()
              .id("refresh-btn")
              .px(7)
              .py(3)
              .rounded(5)
              .cursor_pointer()
              .bg(color(t.raised))
              .border_1()
              .border_color(color(t.border))
              .hover((s) => s.bg(color(t.hover)))
              .on_click((_e, cx) => this.refresh(cx))
              .child(svg("mods/git-graph/icons/refresh.svg").size(12).text_color(color(t.dim)))
          )
          // From a docked panel, open this repository full size in a tab.
          .when(panelMode, (e) =>
            e.child(
              div()
                .id("open-graph-tab-btn")
                .px(7)
                .py(3)
                .rounded(5)
                .cursor_pointer()
                .bg(color(t.raised))
                .border_1()
                .border_color(color(t.border))
                .hover((s) => s.bg(color(t.hover)))
                .tooltip("Open the full Git Graph in a tab")
                .on_click((_e, cx) => this.openGraphTab(cx))
                .child(svg("mods/git-graph/icons/expand.svg").size(12).text_color(color(t.dim)))
            )
          )
      )
      // Compact search row when toggled open
      .when(isCompact && this.searchOpen, (e) =>
        e.child(
          h_flex()
            .id("graph-compact-search-bar")
            .h(32)
            .flex_none()
            .px(10)
            .gap(6)
            .items_center()
            .bg(color(t.raised))
            .border_b(1)
            .border_color(color(t.border))
            .child(
              Input.new(this.searchInput)
                .id("graph-compact-search-input")
                .flex_1()
                .h(24)
                .px(6)
                .rounded(4)
                .border_1()
                .border_color(color(t.border))
                .bg(color(t.background))
                .text_size(11)
                .text_color(color(t.foreground))
            )
            .child(
              div()
                .id("graph-compact-search-clear")
                .px(6)
                .py(2)
                .rounded(4)
                .cursor_pointer()
                .text_size(11)
                .text_color(color(t.dim))
                .hover((s) => s.bg(color(t.hover)))
                .on_click((_e, cx) => this.clearSearch(cx))
                .child("Clear")
            )
        )
      )
      // Table Header Row
      .child(
        h_flex()
          .id("table-header")
          .h(26)
          .flex_none()
          .pr(10)
          .items_center()
          .bg(color(t.raised))
          .border_b(1)
          .border_color(color(t.border))
          .text_size(10)
          .text_color(color(t.muted))
          .font_semibold()
          .child(div().w(graphWidth).flex_none().pl(10).child("Graph"))
          .child(div().w(1).h_full().flex_none().bg(color(t.border)))
          .child(div().flex_1().min_w(0).pl(10).truncate().child("Description"))
          .child(div().w(56).flex_none().pl(4).truncate().child("Date"))
          .when(!isCompact, (e) => e.child(div().w(130).flex_none().truncate().child("Author")))
          .when(!isCompact, (e) => e.child(div().w(70).flex_none().text_center().child("Commit")))
      )
      // Commit list + resizable details pane. The native group owns the drag
      // handle, so the bottom pane keeps its size across repaints.
      .when(Boolean(this.selectedCommit), (e) =>
        e.child(
          v_resizable("git-graph-split")
            .flex_1()
            .min_h(0)
            .child(resizable_panel().child(this.renderCommitArea(t, isCompact, cx)))
            .child(
              resizable_panel()
                .size(isCompact ? 340 : 300)
                .size_range(140, 700)
                .child(this.renderDetailsPanel(t, isCompact, cx))
            )
        )
      )
      .when(!this.selectedCommit, (e) => e.child(this.renderCommitArea(t, isCompact, cx)))
      // Overlays painted last in painter's algorithm order (no invalid z_index)
      .when(this.branchDropdownOpen, (e) => e.child(this.renderBranchDropdown(t, cx)))
      .when(Boolean(this.contextMenu), (e) => e.child(this.renderContextMenu(t, cx)))
      .when(Boolean(this.modalDialog), (e) => e.child(this.renderModalDialog(t, cx)));
  }
}
