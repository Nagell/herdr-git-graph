// Herdr mod: git-graph
// A visual Git graph viewer with topological branch lanes, commit history,
// working tree inspection, hierarchical file tree, and interactive diff viewer.

import { View, div, svg, uniform_list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
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
// watchable and steerable; the low variant keeps the run cheap.
const CLEAN_AGENT_MODEL = "opencode-go/deepseek-v4.1-flash#low";
const CLEAN_AGENT_LABEL = "OpenCode Mini";

/** @param {any} c @returns {`#${string}`} */
const color = (c) => /** @type {`#${string}`} */ (c);

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
  const on =
    f?.pane === null
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
  const focusedPane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const focusedCwd = focusedPane?.cwd || (f?.terminal ? f?.cwd : null);
  if (focusedCwd) {
    if (currentRoot && (focusedCwd === currentRoot || focusedCwd.startsWith(currentRoot + "/"))) {
      return { cwd: currentRoot, on };
    }
    return { cwd: focusedCwd, on };
  }

  // 2. The terminal in this mod's own tab: the pane it was split beside.
  const activeTabPane = panes().find((p) => p.tab === f?.tab && p.cwd && !p.mod);
  if (activeTabPane?.cwd) {
    if (currentRoot && (activeTabPane.cwd === currentRoot || activeTabPane.cwd.startsWith(currentRoot + "/"))) {
      return { cwd: currentRoot, on };
    }
    return { cwd: activeTabPane.cwd, on };
  }

  // 3. The space itself.
  if (space?.folder) return { cwd: space.folder, on };

  // 4. A root already resolved for this view.
  if (currentRoot) return { cwd: currentRoot, on };

  // 5. Last resort: any terminal in the space.
  const tabIds = new Set((space?.tabs ?? []).map((t) => t.id));
  const activeSpacePane = panes().find((p) => tabIds.has(p.tab) && p.cwd && !p.mod);
  if (activeSpacePane?.cwd) return { cwd: activeSpacePane.cwd, on };

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
    this.contextMenu = null; // { type: 'commit' | 'branch', commit?, ref?, x: number, y: number }
    this.modalDialog = null; // { type: string, commit?: any, ref?: any, resetMode?: string, ... }
    this.modalInput = null;
    this.modalTagMessageInput = null;
    this.inProgressOp = null; // { type: string, conflicts: number }

    // Remote tracking state for the fetch / pull / push toolbar buttons.
    this.upstream = null; // e.g. "origin/main"
    this.remotes = [];
    this.ahead = 0;
    this.behind = 0;
    this.detached = false;
    this.remoteAction = null; // "fetch" | "pull" | "push" while one is running

    // Background OpenCode session that cleans the working tree.
    this.treeAgent = null; // { address, name } once hc run returns
    this.treeAgentStarting = false;

    this.handle = cx.focus_handle();

    if (this.diffMode) {
      this.diffScroll = VirtualListScrollHandle.new();
      this.loadDiffTab(cx);
      // Only a working-tree diff can change under us; a commit's cannot.
      if (this.diffKind === "worktree") cx.timer.every(10000, (cx) => this.loadDiffTab(cx));
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

    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  async close(_cx) {
    this.watched = null;
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
    const rows = side === "old" ? this.diffLeft : this.diffRight;
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
              .overflow_x_scrollbar()
              .child(
                div()
                  .w_full()
                  .min_w(width)
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
          .overflow_x_scrollbar()
          .child(
            div()
              .w_full()
              .min_w(this.diffWidth)
              .h_full()
              .child(
                v_virtual_list(
                  "diff-rows",
                  this.diffRows.length,
                  22,
                  (i) => String(i),
                  (range) => this.diffRows.slice(range.start, range.end).map((row) => this.diffRow(row, t))
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
    let effectiveRoot = this.root || loc.cwd;
    if (this.root && loc.cwd && (loc.cwd === this.root || loc.cwd.startsWith(this.root + "/"))) {
      effectiveRoot = this.root;
    }
    return JSON.stringify({ root: effectiveRoot, on: loc.on });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        this.watched = null;
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

    // Q4: If working tree is active, prepend virtual WT node with HEAD commit as parent
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
      this.maxLane = computeLanes([this.workingTreeNode, ...matched]);
    } else {
      this.workingTreeNode = null;
      this.maxLane = computeLanes(matched);
    }
  }

  getVisibleItems() {
    /** @type {Array<any>} */
    const items = [];
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
          return;
        }
        const root = top.stdout.trim();
        if (this.root && root !== this.root) {
          // Switched to a DIFFERENT repository!
          this.commits = [];
          this.filteredCommits = [];
          this.workingTreeFiles = [];
          this.selectedCommit = null;
          this.commitDetails = null;
          this.commitFiles = [];
          this.selectedFile = null;
          this.watched = null;
          this.contextMenu = null;
          this.modalDialog = null;
          this.upstream = null;
          this.remotes = [];
          this.ahead = 0;
          this.behind = 0;
          this.detached = false;
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

        // Working tree status & numstat
        const wtFiles = [];
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
            const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
            const stat = stats[filePath] ?? { add: 0, del: 0, binary: false };
            wtFiles.push({ path: filePath, status: s, fresh, ...stat });
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
            const stillThere = this.commits.find((c) => c.hash === this.selectedCommit.hash);
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
          const branchName = this.currentBranch || this.availableBranches[0] || "my-test-branch";
          this.contextMenu = { type: "branch", ref: { kind: "branch", text: branchName }, x: 180, y: 70 };
        } else if (preview === "modal-branch" && this.commits.length > 0) {
          this.openModal("branch", this.commits[0], cx);
        } else if (preview === "modal-tag" && this.commits.length > 0) {
          this.openModal("tag", this.commits[0], cx);
        } else if (preview === "modal-reset" && this.commits.length > 0) {
          this.openModal("reset", this.commits[0], cx);
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
        if (this.getKey() === context) {
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
    if ((kind === "fetch" || kind === "push") && !this.remotes.length) {
      notify({ title: "No remote", body: "Add a git remote before fetching or pushing.", level: "error" });
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

  openBranchContextMenu(ref, e, cx, overrideX, overrideY) {
    const normRef = typeof ref === "string" ? { kind: ref.startsWith("origin/") ? "remote" : "branch", text: ref } : ref;
    const menuWidth = 220;
    const menuHeight = 150;
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

  closeContextMenu(cx) {
    if (this.contextMenu) {
      this.contextMenu = null;
      if (cx) cx.notify();
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
      this.modalInput.focus();
      if (cx?.timer?.after) {
        cx.timer.after(60, () => this.modalInput?.focus());
        cx.timer.after(180, () => this.modalInput?.focus());
        cx.timer.after(500, () => this.modalInput?.focus());
      }
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
      this.modalInput.focus();
      if (cx?.timer?.after) {
        cx.timer.after(60, () => this.modalInput?.focus());
        cx.timer.after(180, () => this.modalInput?.focus());
        cx.timer.after(500, () => this.modalInput?.focus());
      }
    } else if (type === "reset") {
      this.modalDialog = { type, commit: target, resetMode: "mixed", error: null };
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

    // The handler's Context is valid only until it returns, so the name is
    // read and checked synchronously; everything after the first await runs
    // in a spawned task with an AsyncContext.
    let name = null;
    if (type === "branch" || type === "tag") {
      name = this.modalInput?.value().trim();
      if (!name) {
        dialog.error = `${type === "branch" ? "Branch" : "Tag"} name cannot be empty`;
        cx.notify();
        return;
      }
      if (name.startsWith("-") || name.startsWith("/")) {
        dialog.error = `${type === "branch" ? "Branch" : "Tag"} name cannot start with '-' or '/'`;
        cx.notify();
        return;
      }
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
    const elements = [];

    // 1. Pass-through vertical rails
    for (const p of commit.passThroughLanes) {
      const railColor = color(getLaneColor(p.colorIdx ?? p.lane, t));
      elements.push(
        div()
          .id(`rail-${commit.hash}-${p.lane}`)
          .absolute()
          .left(startX + p.lane * laneWidth - 1)
          .top(0)
          .w(2)
          .h(height)
          .bg(railColor)
      );
    }

    const myColor = commit.isWorkingTree
      ? color(t.working || t.ansi3 || t.accent)
      : color(getLaneColor(commit.colorIdx ?? commit.lane, t));

    // 2. Converging lanes (from child branches merging into this commit)
    if (commit.convergingLanes && commit.convergingLanes.length > 0) {
      for (const c of commit.convergingLanes) {
        const cLane = c.lane;
        const cColor = color(getLaneColor(c.colorIdx ?? cLane, t));
        const x1 = startX + cLane * laneWidth;
        const x2 = startX + commit.lane * laneWidth;
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);

        elements.push(div().id(`conv-top-${commit.hash}-${cLane}`).absolute().left(x1 - 1).top(0).w(2).h(8).bg(cColor));
        elements.push(
          div()
            .id(`conv-bus-${commit.hash}-${cLane}`)
            .absolute()
            .left(minX - 1)
            .top(8)
            .w(maxX - minX + 2)
            .h(2)
            .bg(cColor)
        );
        elements.push(div().id(`conv-step-${commit.hash}-${cLane}`).absolute().left(x2 - 1).top(8).w(2).h(centerY - 8).bg(cColor));
      }
    }

    // 3. Incoming line from child above
    if (commit.fromChild) {
      elements.push(
        div()
          .id(`in-${commit.hash}`)
          .absolute()
          .left(startX + commit.lane * laneWidth - 1)
          .top(0)
          .w(2)
          .h(centerY)
          .bg(myColor)
      );
    }

    // 4. Outgoing lines to parents below
    for (let idx = 0; idx < commit.parentConnections.length; idx++) {
      const conn = commit.parentConnections[idx];
      const connColor = color(getLaneColor(conn.colorIdx ?? conn.toLane, t));

      if (conn.terminated) {
        // Parent is outside view: render a stub line terminating at row bottom
        elements.push(
          div()
            .id(`term-${commit.hash}-${idx}`)
            .absolute()
            .left(startX + commit.lane * laneWidth - 1)
            .top(centerY)
            .w(2)
            .h(height - centerY)
            .bg(myColor)
            .opacity(0.6)
        );
      } else if (conn.toLane === commit.lane) {
        elements.push(
          div()
            .id(`parent-${commit.hash}-${idx}`)
            .absolute()
            .left(startX + commit.lane * laneWidth - 1)
            .top(centerY)
            .w(2)
            .h(height - centerY)
            .bg(connColor)
        );
      } else {
        const x1 = startX + commit.lane * laneWidth;
        const x2 = startX + conn.toLane * laneWidth;
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);

        elements.push(div().id(`p-down-${commit.hash}-${idx}`).absolute().left(x1 - 1).top(centerY).w(2).h(7).bg(connColor));
        elements.push(
          div()
            .id(`p-bus-${commit.hash}-${idx}`)
            .absolute()
            .left(minX - 1)
            .top(22)
            .w(maxX - minX + 2)
            .h(2)
            .bg(connColor)
        );
        elements.push(div().id(`p-step-${commit.hash}-${idx}`).absolute().left(x2 - 1).top(22).w(2).h(height - 22).bg(connColor));
      }
    }

    // 5. Commit node outer ring if HEAD
    if (commit.isHead) {
      elements.push(
        div()
          .id(`head-ring-${commit.hash}`)
          .absolute()
          .left(startX + commit.lane * laneWidth - 7)
          .top(centerY - 7)
          .size(14)
          .rounded_full()
          .border_2()
          .border_color(color(t.accent))
      );
    }

    // 6. Commit node circle / merge commit indicator / WT indicator
    const isMerge = commit.parents && commit.parents.length > 1;
    if (commit.isWorkingTree) {
      elements.push(
        div()
          .id("wt-node")
          .absolute()
          .left(startX + commit.lane * laneWidth - 4)
          .top(centerY - 4)
          .size(8)
          .rounded_full()
          .bg(myColor)
          .border_1()
          .border_color(color(t.background))
      );
    } else if (isMerge) {
      elements.push(
        div()
          .id(`node-${commit.hash}`)
          .absolute()
          .left(startX + commit.lane * laneWidth - 5)
          .top(centerY - 5)
          .size(10)
          .rounded_full()
          .bg(color(t.background))
          .border_2()
          .border_color(myColor)
          .flex()
          .items_center()
          .justify_center()
          .child(div().id(`node-dot-${commit.hash}`).size(4).rounded_full().bg(myColor))
      );
    } else {
      elements.push(
        div()
          .id(`node-${commit.hash}`)
          .absolute()
          .left(startX + commit.lane * laneWidth - 4)
          .top(centerY - 4)
          .size(8)
          .rounded_full()
          .bg(myColor)
          .border_1()
          .border_color(color(t.background))
      );
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
              .child("DIRTY")
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

  renderCommitRow(commit, t, isCompact, cx) {
    const isSelected = this.selectedCommit?.hash === commit.hash && !this.selectedCommit.isWorkingTree;

    // HEAD is folded into the checked-out branch pill (like Git Graph's ✓ main)
    // instead of being painted as a separate badge.
    const refs = [];
    let headPending = false;
    for (const ref of commit.refs) {
      if (ref.kind === "head") {
        headPending = true;
        continue;
      }
      refs.push(headPending && ref.kind === "local" ? { ...ref, isHead: true } : ref);
      headPending = false;
    }
    if (headPending) refs.push({ kind: "head", text: "HEAD" });

    // Q5 & Q1: Cap badges to max 2 + "+N" chip if > 3 (or > 2 in compact)
    const maxVisibleRefs = isCompact ? 2 : 3;
    let visibleRefs = refs;
    let extraRefCount = 0;
    if (refs.length > maxVisibleRefs) {
      visibleRefs = refs.slice(0, 2);
      extraRefCount = refs.length - 2;
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
      return Math.min(maxBadgeW, 28 + textWidth + (ref.kind === "remote" ? 6 : 0));
    };

    const renderedBadges = visibleRefs.map((ref, idx) => {
      const badgeW = badgeWidth(ref);

      commit._badgeBoxes.push({
        ref,
        xStart: curX,
        xEnd: curX + badgeW,
      });
      curX += badgeW + 4;

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
      // Remote refs read as `origin` chip + `/branch`, matching Git Graph.
      const parts = isRemote ? ref.text.split("/") : [];
      const remoteName = parts.shift() || "";
      const remoteBranch = parts.join("/");

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
        .when(isRemote && remoteBranch, (e) =>
          e
            .child(
              div()
                .flex_none()
                .px(3)
                .rounded(3)
                .text_size(9)
                .bg(color(isFilteredThis ? t.background + "2e" : bColor + "3d"))
                .child(remoteName)
            )
            .child(div().min_w(0).truncate().child(`/${remoteBranch}`))
        )
        .when(!isRemote || !remoteBranch, (e) => e.child(div().min_w(0).truncate().child(ref.text)));
    });

    if (extraRefCount > 0) {
      const extraW = Math.min(60, 20 + String(extraRefCount).length * 7);
      commit._badgeBoxes.push({
        ref: { kind: "extra", text: `+${extraRefCount}` },
        xStart: curX,
        xEnd: curX + extraW,
      });
      curX += extraW + 4;

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
              .child(formatRelativeTime(commit.timestamp))
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

  renderTreeList(t, cx) {
    if (!this.commitFiles.length) {
      return div().p(12).text_size(11).text_color(color(t.dim)).child("No changed files in this commit");
    }

    const tree = buildFileTree(this.commitFiles);
    const rows = flattenFileTree(tree, 0, this.collapsedFolders, []);

    return v_flex()
      .id("tree-file-list")
      .size_full()
      .min_h(0)
      .overflow_y_scrollbar()
      .p(4)
      .gap(1)
      .children(
        rows.map((row) => {
          if (row.isDir) {
            return h_flex()
              .id(`dir-${row.path}`)
              .h(24)
              .flex_none()
              .pl(6 + row.depth * 14)
              .pr(6)
              .gap(5)
              .items_center()
              .rounded(4)
              .cursor_pointer()
              .hover((s) => s.bg(color(t.hover)))
              .on_click((_e, cx) => this.toggleFolder(row.path, cx))
              .child(
                svg(
                  row.isExpanded
                    ? "mods/git-graph/icons/chevron-down.svg"
                    : "mods/git-graph/icons/chevron-right.svg"
                )
                  .size(11)
                  .flex_none()
                  .text_color(color(t.dim))
              )
              .child(svg("mods/git-graph/icons/folder.svg").size(13).flex_none().text_color(color(t.muted)))
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(11)
                  .font_medium()
                  .text_color(color(t.foreground))
                  .child(row.name)
              )
              .when(row.add > 0, (e) =>
                e.child(div().text_size(10).text_color(color(t.ansi2)).child(`+${row.add}`))
              )
              .when(row.del > 0, (e) =>
                e.child(div().text_size(10).text_color(color(t.ansi1)).child(`−${row.del}`))
              );
          }

          const isFileSelected = this.selectedFile === row.path;
          const sColor = color(getStatusColor(row.status, t));

          return h_flex()
            .id(`file-${row.path}`)
            .h(24)
            .flex_none()
            .pl(6 + row.depth * 14 + 14)
            .pr(6)
            .gap(6)
            .items_center()
            .rounded(4)
            .cursor_pointer()
            .when(isFileSelected, (e) => e.bg(color(t.selected)))
            .hover((s) => s.bg(color(isFileSelected ? t.selected : t.hover)))
            .tooltip("Open this diff in a new tab")
            .on_click((_e, cx) => this.openDiffTab(row.path, cx))
            .child(
              div()
                .w(14)
                .flex_none()
                .text_center()
                .font_semibold()
                .text_size(10)
                .text_color(sColor)
                .child(row.status || "M")
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(color(isFileSelected ? t.foreground : t.dim))
                .child(row.name)
            )
            .when(row.add > 0, (e) =>
              e.child(div().text_size(10).text_color(color(t.ansi2)).child(`+${row.add}`))
            )
            .when(row.del > 0, (e) =>
              e.child(div().text_size(10).text_color(color(t.ansi1)).child(`−${row.del}`))
            );
        })
      );
  }

  renderDetailsPanel(t, isCompact, cx) {
    const c = this.selectedCommit;
    if (!c) return null;

    const fullMsg = this.commitDetails?.fullMessage || c.subject;

    return v_flex()
      .id("commit-details-panel")
      .flex_none()
      .h(isCompact ? 340 : 300)
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
              .max_h(52)
              .p(8)
              .overflow_y_scrollbar()
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
              .child(div().h(1).bg(color(t.border)).my(3))
              .child(div().px(8).py(2).text_size(10).text_color(color(t.muted)).child("BRANCHES"))
              .children(
                this.availableBranches.map((bName) => {
                  const isActive = this.branchFilter === bName;
                  return h_flex()
                    .id(`branch-item-${bName}`)
                    .h(24)
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .when(isActive, (el) => el.bg(color(t.selected)).font_semibold())
                    .hover((s) => s.bg(color(isActive ? t.selected : t.hover)))
                    .on_click((_e, cx) => this.setBranchFilter(bName, cx))
                    .child(svg("mods/git-graph/icons/branch.svg").size(11).text_color(color(t.dim)))
                    .child(div().flex_1().truncate().child(bName));
                })
              )
          )
          // Background cleanup agent action
          .when(Boolean(this.workingTreeFiles.length || this.inProgressOp || this.treeAgentBusy()), (e) =>
            e
              .child(div().h(1).bg(color(t.border)).my(3))
              .child(
                h_flex()
                  .id("branch-clean-agent")
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
                  .child(svg("icons/opencode.svg").size(12).text_color(color(t.accent)))
                  .child(div().flex_1().truncate().child(`Clean tree with ${CLEAN_AGENT_LABEL}`))
                  .child(
                    div()
                      .text_size(10)
                      .text_color(color(t.muted))
                      .child(this.treeAgentBusy() ? "working · peek" : "low · no push")
                  )
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
    const needsRemote = (kind === "fetch" || kind === "push") && !this.remotes.length;
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

  /** Live status of the background cleanup agent, or null when it is idle/gone. */
  treeAgentStatus() {
    if (!this.treeAgent?.address) return null;
    const term = terminals().find((t) => t.address === this.treeAgent.address);
    if (!term || term.state !== "live") return null;
    return term.status || null;
  }

  /** True while the launched cleanup agent still owns the working tree. */
  treeAgentBusy() {
    if (this.treeAgentStarting) return true;
    const agent = this.treeAgent;
    if (!agent?.address) return false;
    if (agent.busy === false) return false;
    if (agent.busy === true) {
      const term = terminals().find((t) => t.address === agent.address);
      if (!term || term.state !== "live") {
        if (Date.now() - (agent.startedAt || 0) > 15000) return false;
      }
      return true;
    }
    const status = this.treeAgentStatus();
    if (status === "working" || status === "blocked") return true;
    // `hc run` returns before the session shows up. Keep the button locked
    // briefly so a second click cannot start a duplicate agent.
    return Date.now() - (agent.startedAt || 0) < 30000;
  }

  /** A session id the mini UI creates, so we can follow its busy state. */
  treeAgentSessionId() {
    return `ses_gitgraph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * OpenCode Mini never reports OSC 7501 status, so poll its session. The
   * session is idle once `time.idle` is at or after `time.busy`.
   */
  pollTreeAgent(cx) {
    const agent = this.treeAgent;
    if (!agent?.sessionId || agent.busy === false || agent.polling) return;
    const term = terminals().find((t) => t.address === agent.address);
    if (Date.now() - (agent.startedAt || 0) > 15000 && (!term || term.state !== "live")) {
      agent.busy = false;
      cx.notify();
      return;
    }
    if (!agent.found && Date.now() - (agent.startedAt || 0) > 30000) {
      agent.busy = false;
      cx.notify();
      return;
    }
    agent.polling = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("opencode", ["api", "GET", `/api/session/${agent.sessionId}`], {
          cwd: agent.root,
          on: agent.on,
        });
        if (r.code !== 0) return;
        const payload = JSON.parse(r.stdout);
        const session = payload?.data ?? payload;
        const time = session?.time ?? {};
        const started = time.busy || time.created;
        const busy = Boolean(started) && (!time.idle || time.idle < started);
        if (this.treeAgent !== agent) return;
        agent.found = true;
        agent.busy = busy;
        cx.notify();
      } catch {
        // The API may not be available; the terminal-status fallback applies.
      } finally {
        agent.polling = false;
      }
    });
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
   * Starts OpenCode's mini interface in a background Herdr terminal. It gets
   * the current branch, dirty paths and in-progress operation in its first
   * message, plus explicit no-push/no-branch-switch rules.
   */
  startTreeAgent(cx) {
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
          CLEAN_AGENT_MODEL,
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
          startedAt: Date.now(),
          found: false,
          busy: null,
        };
        notify({
          title: `${CLEAN_AGENT_LABEL} is cleaning the tree`,
          body: `Started ${name} in the background${address ? ` (${address})` : ""}. Click to peek.`,
          level: "success",
          ...(address ? { action: { name: "terminal.peek", args: { terminal: address } } } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify({
          title: "Could not start the cleanup agent",
          body: msg.length > 600 ? `${msg.slice(0, 600)}…` : msg,
          level: "error",
        });
      } finally {
        this.treeAgentStarting = false;
        cx.notify();
      }
    });
  }

  /** One background-cleanup button for the toolbar, beside the branch controls. */
  treeAgentButton(t, cx, isCompact) {
    const status = this.treeAgentStatus();
    const busy = this.treeAgentBusy();
    const clean = !this.workingTreeFiles.length && !this.inProgressOp;
    const hardDisabled = !this.root || clean || this.detached || this.busy;
    const disabled = this.treeAgentStarting || (!busy && hardDisabled);
    const showLabel = !isCompact && this.width >= 900;

    let tip;
    if (this.treeAgentStarting) {
      tip = `Starting ${CLEAN_AGENT_LABEL}…`;
    } else if (busy && status === "blocked") {
      tip = `${CLEAN_AGENT_LABEL} is waiting for you · click to peek`;
    } else if (busy) {
      tip = `${CLEAN_AGENT_LABEL} is cleaning the tree · click to peek`;
    } else if (!this.root) {
      tip = "Open a Git repository first";
    } else if (this.detached) {
      tip = "Check out a branch before cleaning the tree";
    } else if (clean) {
      tip = "Working tree is clean";
    } else if (this.inProgressOp) {
      tip = `Resolve the ${this.inProgressOp.type} and commit with ${CLEAN_AGENT_LABEL} (low reasoning, no push)`;
    } else {
      tip = `Clean the tree with ${CLEAN_AGENT_LABEL}: resolve conflicts, make atomic commits (low reasoning, no push)`;
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
      .on_click((_e, cx) => {
        if (busy && this.treeAgent?.address) {
          run("terminal.peek", { terminal: this.treeAgent.address });
          return;
        }
        this.startTreeAgent(cx);
      })
      .child(svg("icons/opencode.svg").size(12).text_color(color(disabled ? t.dim : t.accent)))
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

    if (cMenu.type === "branch") {
      const ref = cMenu.ref;
      const isRemote = ref.kind === "remote";
      const bName = ref.text;

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
            .w(220)
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

    const menuItem = (id, label, icon, onClick) =>
      h_flex()
        .id(id)
        .h(26)
        .px(8)
        .gap(6)
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .hover((s) => s.bg(color(t.hover)))
        .on_click((_e, cx) => {
          this.closeContextMenu(cx);
          onClick(cx);
        })
        .child(
          div()
            .w(14)
            .h(14)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .child(icon ? svg(icon).size(12).text_color(color(t.dim)) : div())
        )
        .child(div().flex_1().truncate().child(label));

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

  renderModalDialog(t, cx) {
    const dialog = this.modalDialog;
    if (!dialog) return null;

    const commit = dialog.commit;
    const isConfirm = dialog.type.startsWith("confirm-");
    // The panel is narrower than the tab; keep the dialog inside the card.
    const dialogWidth = this.width > 0 ? Math.min(400, Math.max(280, this.width - 24)) : 400;

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
              .gap(3)
              .child(
                div()
                  .font_semibold()
                  .text_size(13)
                  .text_color(color(t.foreground))
                  .child(
                    dialog.type === "branch"
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
                      : dialog.type === "confirm-rebase"
                      ? `Rebase '${this.currentBranch || "HEAD"}' on ${commit.shortHash}`
                      : dialog.type === "confirm-delete-branch"
                      ? `Delete Branch '${dialog.ref?.text}'`
                      : "Confirm Action"
                  )
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(color(t.muted))
                  .child(
                    dialog.type === "branch"
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
          // Inline error display
          .when(Boolean(dialog.error), (e) =>
            e.child(
              div()
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
                      : dialog.type === "confirm-delete-branch"
                      ? t.ansi1
                      : t.solid
                  ))
                  .text_color(color(t.solid_foreground))
                  .text_size(11)
                  .font_semibold()
                  .on_click((_e, cx) => this.submitModal(cx))
                  .child(
                    this.busy
                      ? "Working…"
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
    if (this.diffMode) return this.renderDiffTab(cx);
    if (this.getKey() !== this.context) this.refresh(cx);
    const t = theme();
    const p = props();
    // Docked in a layout panel (Herdr's Changes slot, for example): draw a card
    // like the Files panel and offer a way to open the full graph in a tab.
    const panelMode = Boolean(p?.panel);
    const isCompact = Boolean(p?.compact) || (this.width > 0 && this.width < 560);
    const showWorkingTree = this.shouldShowWorkingTree();
    const laneWidth = 16;
    const graphWidth = Math.max(64, (this.maxLane + 1) * laneWidth + 24);
    const visibleItems = this.getVisibleItems();
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
      .on_size_change((size, cx) => {
        const w = size && typeof size.width === "number" ? Math.round(size.width) : 0;
        const h = size && typeof size.height === "number" ? Math.round(size.height) : 0;
        if (w !== this.width || h !== this.height) {
          this.width = w;
          this.height = h;
          cx.notify();
        }
      })
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
                this.upstream
                  ? `${branchLabel} · tracking ${this.upstream}${
                      this.ahead > 0 ? ` · ${this.ahead} ahead` : ""
                    }${this.behind > 0 ? ` · ${this.behind} behind` : ""}`
                  : `${branchLabel} · no upstream`
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
          // Background cleanup agent (OpenCode Mini, low reasoning)
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
      // Virtualized Commit List with uniform_list
      .child(
        v_flex()
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
                      const item = this.commits.find((c) => c.hash === key);
                      if (item) {
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
                    if (key !== "__WORKING_TREE__") {
                      const item = this.commits.find((c) => c.hash === key);
                      if (item) {
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
          )
      )
      // Bottom Details Panel (Tree View & Diff View)
      .when(Boolean(this.selectedCommit), (e) => e.child(this.renderDetailsPanel(t, isCompact, cx)))
      // Overlays painted last in painter's algorithm order (no invalid z_index)
      .when(this.branchDropdownOpen, (e) => e.child(this.renderBranchDropdown(t, cx)))
      .when(Boolean(this.contextMenu), (e) => e.child(this.renderContextMenu(t, cx)))
      .when(Boolean(this.modalDialog), (e) => e.child(this.renderModalDialog(t, cx)));
  }
}
