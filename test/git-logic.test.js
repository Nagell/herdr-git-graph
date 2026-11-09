import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeEffectiveRoot,
  isLayoutNodeVisible,
  parseRefs,
  resolveDisplayRefs,
  badgeTooltip,
  extraRefsTooltip,
  parseCommitLog,
  logArgs,
  tagArgs,
  deleteTagArgs,
  pushTagArgs,
  deleteRemoteTagArgs,
  lsRemoteTagArgs,
  remoteTagExists,
  parseRemoteTags,
  computeLanes,
  buildFileTree,
  flattenFileTree,
  buildDiffView,
  intraLineDiff,
  diffRows,
  isDiffable,
  isBinaryDiff,
  NON_DIFFABLE_EXTENSIONS,
  lineSegments,
  wrapInlineRows,
  wrapSplitRows,
  isFreeModel,
  isLightColor,
  fileIconPath,
  FILE_ICON_BY_NAME,
  FILE_ICON_BY_EXT,
  FILE_ICON_DEFAULT,
  FOLDER_ICON_PATH,
  FILE_EDITOR_MOD,
  FILE_EDITOR_INSTALL_HINT,
  fileEditorTabTarget,
  resolveRepoPath,
  cleanModelLabel,
  resolveCleanAgentModelLogic,
  filterVisibleCleanModels,
  parseCommitStats,
  findLargeCommit,
  splitRemoteBranch,
  pushArgs,
  isPushRejection,
  deleteRemoteBranchArgs,
  fetchRemoteBranchArgs,
  renameRemoteBranchPushArgs,
  OPENCODE_INSTALL_CMD,
  OPENCODE_DOCS_URL,
  parseWorktreeList,
  worktreeBranchMap,
  findBranchCheckout,
  markWorktreeRefs,
  findCheckoutSpace,
  mergedCheckArgs,
  removeWorktreeArgs,
  normalizeCheckoutPath,
  SPACE_ACTIONS_MOD,
  parseTreeAgentSession,
  contextMenuPosition,
} from "../mods/git-graph/git-logic.js";

test("isLayoutNodeVisible: checks panel hidden state and stack active selections", () => {
  const layout = {
    id: "root",
    children: [
      {
        id: "panel",
        hidden: false,
        children: [
          {
            id: "panel-body",
            type: "stack",
            active: "changes",
            children: [
              { id: "files", content: { mod: "files" } },
              { id: "changes", content: { mod: "git-graph" } },
            ],
          },
        ],
      },
    ],
  };

  // Visible when panel is not hidden and active child matches
  assert.equal(isLayoutNodeVisible(layout, "changes"), true);
  assert.equal(
    isLayoutNodeVisible(layout, (n) => n?.content?.mod === "git-graph"),
    true
  );

  // Hidden when another stack child is active
  layout.children[0].children[0].active = "files";
  assert.equal(isLayoutNodeVisible(layout, "changes"), false);
  assert.equal(
    isLayoutNodeVisible(layout, (n) => n?.content?.mod === "git-graph"),
    false
  );

  // Hidden when ancestor is hidden
  layout.children[0].children[0].active = "changes";
  layout.children[0].hidden = true;
  assert.equal(isLayoutNodeVisible(layout, "changes"), false);

  // Defaults to visible if layout root is missing or target not in tree
  assert.equal(isLayoutNodeVisible(null, "changes"), true);
  assert.equal(isLayoutNodeVisible(layout, "other-node"), true);
});

test("computeEffectiveRoot: handles repo switching, subdirectories, and empty locations", () => {
  // Same repo root
  assert.equal(
    computeEffectiveRoot("/path/to/repoA", "/path/to/repoA"),
    "/path/to/repoA"
  );

  // Subdirectory inside current repo preserves current root
  assert.equal(
    computeEffectiveRoot("/path/to/repoA", "/path/to/repoA/mods/git-graph"),
    "/path/to/repoA"
  );

  // Different repository/folder returns candidate cwd so key changes immediately
  assert.equal(
    computeEffectiveRoot("/path/to/repoA", "/path/to/repoB"),
    "/path/to/repoB"
  );
  assert.equal(
    computeEffectiveRoot("/path/to/repoA", "/path/to/repoA-other"),
    "/path/to/repoA-other"
  );

  // Initial load without current root
  assert.equal(
    computeEffectiveRoot(null, "/path/to/repoA"),
    "/path/to/repoA"
  );
  assert.equal(
    computeEffectiveRoot(undefined, "/path/to/repoA"),
    "/path/to/repoA"
  );

  // Missing or empty cwd returns null
  assert.equal(computeEffectiveRoot("/path/to/repoA", null), null);
  assert.equal(computeEffectiveRoot("/path/to/repoA", ""), null);
  assert.equal(computeEffectiveRoot(null, null), null);
});

test("parseRefs: parses decorated refs correctly", () => {
  // HEAD -> refs/heads/feat/x
  const headBadges = parseRefs("HEAD -> refs/heads/feat/x");
  assert.deepEqual(headBadges, [
    { kind: "head", text: "HEAD" },
    { kind: "local", text: "feat/x" },
  ]);

  // refs/remotes/origin/HEAD is hidden
  const hiddenHead = parseRefs("refs/remotes/origin/HEAD");
  assert.deepEqual(hiddenHead, []);

  // tag: refs/tags/v1
  const tagBadges = parseRefs("tag: refs/tags/v1");
  assert.deepEqual(tagBadges, [{ kind: "tag", text: "v1" }]);

  // local branch name containing slashes
  const slashBranch = parseRefs("refs/heads/feature/nested/slash-branch");
  assert.deepEqual(slashBranch, [
    { kind: "local", text: "feature/nested/slash-branch" },
  ]);

  // empty input
  assert.deepEqual(parseRefs(""), []);
  assert.deepEqual(parseRefs("   "), []);
  assert.deepEqual(parseRefs(null), []);
  assert.deepEqual(parseRefs(undefined), []);

  // combined list with multiple ref types
  const combined = parseRefs(
    "HEAD -> refs/heads/feat/x, refs/remotes/origin/HEAD, tag: refs/tags/v1, refs/heads/release/2.0"
  );
  assert.deepEqual(combined, [
    { kind: "head", text: "HEAD" },
    { kind: "local", text: "feat/x" },
    { kind: "tag", text: "v1" },
    { kind: "local", text: "release/2.0" },
  ]);
});

test("logArgs: builds safe arguments for git log", () => {
  // 'all' includes --exclude=refs/stash before --all and ends with --
  const allArgs = logArgs("all");
  const excludeIdx = allArgs.indexOf("--exclude=refs/stash");
  const allIdx = allArgs.indexOf("--all");
  assert.ok(excludeIdx !== -1, "should contain --exclude=refs/stash");
  assert.ok(allIdx !== -1, "should contain --all");
  assert.ok(
    excludeIdx < allIdx,
    "--exclude=refs/stash must come before --all"
  );
  assert.equal(allArgs[allArgs.length - 1], "--", "must end with --");
  assert.equal(allArgs[allArgs.indexOf("-n") + 1], "500", "defaults to 500 commits");

  // Custom commitLimit
  const customLimitArgs = logArgs("all", 250);
  assert.equal(customLimitArgs[customLimitArgs.indexOf("-n") + 1], "250");

  // A branch filter starting with '-' is placed after --end-of-options
  const dashArgs = logArgs("-dash-branch");
  const optIdx = dashArgs.indexOf("--end-of-options");
  assert.ok(optIdx !== -1, "should contain --end-of-options");
  assert.equal(dashArgs[optIdx + 1], "-dash-branch");
  assert.equal(dashArgs[dashArgs.length - 1], "--", "must end with --");

  // 'current' uses HEAD after --end-of-options
  const currentArgs = logArgs("current");
  const curOptIdx = currentArgs.indexOf("--end-of-options");
  assert.ok(curOptIdx !== -1);
  assert.equal(currentArgs[curOptIdx + 1], "HEAD");
  assert.equal(currentArgs[currentArgs.length - 1], "--");
});

test("tagArgs: protects tag name after --end-of-options with and without message", () => {
  // without message
  const noMsgArgs = tagArgs("-v1.0", "", "abc1234");
  assert.deepEqual(noMsgArgs, [
    "tag",
    "--end-of-options",
    "-v1.0",
    "abc1234",
  ]);

  // with message
  const withMsgArgs = tagArgs("-v1.0", "Release v1.0", "abc1234");
  assert.deepEqual(withMsgArgs, [
    "tag",
    "-a",
    "-m",
    "Release v1.0",
    "--end-of-options",
    "-v1.0",
    "abc1234",
  ]);

  // Renaming an annotated tag with an empty message must keep it annotated.
  assert.deepEqual(tagArgs("v2", "", "abc1234", { annotated: true }), [
    "tag",
    "-a",
    "-m",
    "",
    "--end-of-options",
    "v2",
    "abc1234",
  ]);
});

test("deleteTagArgs: removes one local tag after --end-of-options", () => {
  assert.deepEqual(deleteTagArgs("-v1.0"), ["tag", "-d", "--end-of-options", "-v1.0"]);
  assert.deepEqual(deleteTagArgs("release/2.0"), ["tag", "-d", "--end-of-options", "release/2.0"]);
});

test("tag remote helpers: publish, delete, and inspect exact refs only", () => {
  assert.deepEqual(pushTagArgs("origin", "v1.0"), [
    "push",
    "origin",
    "--end-of-options",
    "refs/tags/v1.0:refs/tags/v1.0",
  ]);

  assert.deepEqual(deleteRemoteTagArgs("upstream", "release/2.0"), [
    "push",
    "upstream",
    "--delete",
    "--end-of-options",
    "refs/tags/release/2.0",
  ]);

  assert.deepEqual(lsRemoteTagArgs("origin", "v1.0"), [
    "ls-remote",
    "--tags",
    "--refs",
    "origin",
    "refs/tags/v1.0",
  ]);
});

test("remoteTagExists: matches the full tag ref and never a prefix or peeled companion", () => {
  const stdout = [
    "abc123\trefs/tags/v1",
    "def456\trefs/tags/v1.0",
    "987fed\trefs/tags/feature/v1",
  ].join("\n");

  assert.equal(remoteTagExists(stdout, "v1"), true);
  assert.equal(remoteTagExists(stdout, "v1.0"), true);
  assert.equal(remoteTagExists(stdout, "feature/v1"), true);
  assert.equal(remoteTagExists(stdout, "v"), false);
  assert.equal(remoteTagExists("abc123\trefs/tags/v1^{}\n", "v1"), false);
  assert.equal(remoteTagExists("", "v1"), false);
  assert.equal(remoteTagExists(null, "v1"), false);
});

test("parseRemoteTags: lists unique tag names and ignores peeled refs", () => {
  const stdout = [
    "abc123\trefs/tags/v1",
    "def456\trefs/tags/v1.0",
    "987fed\trefs/tags/feature/v1",
    "aaa111\trefs/tags/v1^{}",
    "bbb222\trefs/heads/main",
    "",
  ].join("\n");

  assert.deepEqual(parseRemoteTags(stdout), ["v1", "v1.0", "feature/v1"]);
  assert.deepEqual(parseRemoteTags(""), []);
  assert.deepEqual(parseRemoteTags(null), []);
});

test("computeLanes: linear history uses one lane", () => {
  const linear = [
    { hash: "c3", parents: ["c2"] },
    { hash: "c2", parents: ["c1"] },
    { hash: "c1", parents: [] },
  ];
  const maxLane = computeLanes(linear);

  assert.equal(maxLane, 0);
  for (const c of linear) {
    assert.equal(c.lane, 0);
    assert.equal(c.colorIdx, 0);
  }
  assert.equal(linear[0].edgesUp.length, 0);
  assert.equal(linear[0].edgesDown.length, 1);
  assert.equal(linear[1].edgesUp.length, 1);
  assert.equal(linear[1].edgesDown.length, 1);
  assert.equal(linear[2].edgesUp.length, 1);
  assert.equal(linear[2].edgesDown.length, 0);
});

test("computeLanes: branch and merge use two lanes, side branch rejoins, and merge row has two edgesUp", () => {
  const branchMerge = [
    { hash: "m", parents: ["c2", "c1"] },
    { hash: "c2", parents: ["base"] },
    { hash: "c1", parents: ["base"] },
    { hash: "base", parents: [] },
  ];
  const maxLane = computeLanes(branchMerge);

  // Uses two lanes (0 and 1)
  assert.equal(maxLane, 1);
  assert.equal(branchMerge[0].lane, 0);
  assert.equal(branchMerge[1].lane, 0);
  assert.equal(branchMerge[2].lane, 1);
  assert.equal(branchMerge[3].lane, 0);

  // Side branch rejoins: c1 (lane 1) edgesDown has an edge into lane 0
  assert.ok(
    branchMerge[2].edgesDown.some((e) => e.from === 1 && e.to === 0),
    "c1 edgesDown should connect from lane 1 to lane 0"
  );

  // The base row where side branch rejoins main has two edgesUp
  assert.equal(branchMerge[3].edgesUp.length, 2);
  assert.equal(branchMerge[3].edgesUp[0].to, 0);
  assert.equal(branchMerge[3].edgesUp[1].to, 0);
  assert.equal(branchMerge[3].edgesUp[1].from, 1);

  // Color index stays stable along the first-parent chain
  assert.equal(branchMerge[0].colorIdx, 0);
  assert.equal(branchMerge[1].colorIdx, 0);
  assert.equal(branchMerge[3].colorIdx, 0);
});

test("computeLanes: missing parent gives terminated: true without lane leaks", () => {
  const commits = [
    { hash: "c2", parents: ["c1", "external-hash"] },
    { hash: "c1", parents: [] },
  ];
  computeLanes(commits);

  const termConn = commits[0].parentConnections.find(
    (p) => p.parentHash === "external-hash"
  );
  assert.ok(termConn, "external parent connection should exist");
  assert.equal(termConn.terminated, true);

  // No lane leaks into later rows
  assert.equal(commits[1].passThroughLanes.length, 0);
  assert.equal(commits[1].edgesUp.length, 1);
  assert.equal(commits[1].edgesUp[0].to, 0);
});

test("computeLanes: color index stays stable along first-parent chain", () => {
  const chain = [
    { hash: "c4", parents: ["c3"] },
    { hash: "c3", parents: ["c2", "side1"] },
    { hash: "c2", parents: ["c1"] },
    { hash: "c1", parents: [] },
  ];
  computeLanes(chain);

  for (const c of chain) {
    assert.equal(c.colorIdx, 0);
  }
});

test("computeLanes: side branch parent does not reuse merge commit lane or flip rail colors", () => {
  // Scenario matching Image 4 / autojudge:
  // main merges dev (m_dev); dev merges fix (c_fix); both dev and fix branch from base.
  const commits = [
    { hash: "m_main", parents: ["base", "m_dev"] },
    { hash: "m_dev", parents: ["base", "c_fix"] },
    { hash: "c_fix", parents: ["base"] },
    { hash: "base", parents: [] },
  ];
  computeLanes(commits);

  assert.equal(commits[0].lane, 0, "m_main is at lane 0");
  assert.equal(commits[1].lane, 1, "m_dev is at lane 1");
  assert.equal(commits[2].lane, 2, "c_fix is placed in a separate lane (lane 2), not lane 1");
  assert.equal(commits[3].lane, 0, "base is at lane 0");

  // Verify that m_dev at lane 1 does not have a vertical straight edge (1->1) with a different color.
  const mDevDown = commits[1].edgesDown;
  const straightSameLane = mDevDown.find((e) => e.from === 1 && e.to === 1);
  assert.ok(!straightSameLane, "lane 1 should terminate or curve off, never switch colors in-place");

  // Verify that c_fix parent connection comes from lane 1 to lane 2
  const fixConn = commits[1].parentConnections.find((p) => p.parentHash === "c_fix");
  assert.ok(fixConn);
  assert.equal(fixConn.toLane, 2);
  assert.equal(commits[2].colorIdx, fixConn.colorIdx);
});

test("buildFileTree: a file replacing a directory keeps both the file and the nested files", () => {
  const files = [
    { path: "skills/computer-use", status: "A", add: 1, del: 0 },
    { path: "skills/computer-use/SKILL.md", status: "D", add: 0, del: 46 },
  ];
  const rows = flattenFileTree(buildFileTree(files), 0, new Set(), []);

  assert.deepEqual(
    rows.map((row) => [row.isDir, row.path]),
    [
      [true, "skills"],
      [true, "skills/computer-use"],
      [false, "skills/computer-use/SKILL.md"],
      [false, "skills/computer-use"],
    ]
  );
  assert.equal(rows[3].file.status, "A", "the symlink row keeps its own diff and status");
  assert.equal(rows[3].add, 1);
});

test("buildFileTree: a directory added after a file with the same name keeps both branches", () => {
  const files = [
    { path: "foo/bar.txt", status: "A", add: 3, del: 0 },
    { path: "foo", status: "D", add: 0, del: 2 },
  ];
  const rows = flattenFileTree(buildFileTree(files), 0, new Set(), []);

  assert.deepEqual(
    rows.map((row) => [row.isDir, row.path]),
    [
      [true, "foo"],
      [false, "foo/bar.txt"],
      [false, "foo"],
    ]
  );
  assert.equal(rows[2].file.status, "D");
});

test("buildDiffView: left and right columns have equal length for unbalanced hunk", () => {
  const diff = `@@ -1,5 +1,3 @@
 context 1
-del 1
-del 2
-del 3
+add 1
 context 2`;
  const rows = diffRows(diff);
  const view = buildDiffView(rows);

  assert.equal(view.left.length, view.right.length);
  assert.ok(view.left.length > 0);
  // Verify unbalanced deletions paired with additions + nulls
  const pairWithAdd = view.left.find((r) => r.kind === "pair" && r.right?.kind === "+");
  assert.ok(pairWithAdd);
  assert.equal(pairWithAdd.left?.kind, "-");
  const nullRightPairs = view.left.filter((r) => r.kind === "pair" && r.right === null);
  assert.equal(nullRightPairs.length, 2);
});

test("intraLineDiff: marks only changed digit, including with emojis before change", () => {
  // Simple case
  const diff1 = intraLineDiff("const a = 1", "const a = 2");
  assert.deepEqual(diff1.old, [[10, 11]]);
  assert.deepEqual(diff1.new, [[10, 11]]);
  assert.equal("const a = 1".slice(diff1.old[0][0], diff1.old[0][1]), "1");
  assert.equal("const a = 2".slice(diff1.new[0][0], diff1.new[0][1]), "2");

  // Code-point offsets with multi-byte surrogate pair emoji before the change
  const oldEmoji = "🚀 const a = 1";
  const newEmoji = "🚀 const a = 2";
  const diffEmoji = intraLineDiff(oldEmoji, newEmoji);
  assert.deepEqual(diffEmoji.old, [[13, 14]]);
  assert.deepEqual(diffEmoji.new, [[13, 14]]);
  assert.equal(oldEmoji.slice(diffEmoji.old[0][0], diffEmoji.old[0][1]), "1");
  assert.equal(newEmoji.slice(diffEmoji.new[0][0], diffEmoji.new[0][1]), "2");
});

test("diffRows: parses hunk header numbering and assigns old/new line numbers", () => {
  const diff = `diff --git a/foo.js b/foo.js
index 1234567..89abcdef 100644
--- a/foo.js
+++ b/foo.js
@@ -10,4 +20,5 @@ function test() {
 context 1
-deleted line
+added line 1
+added line 2
 context 2
`;
  const rows = diffRows(diff);

  assert.equal(rows[0].kind, "@");
  assert.equal(rows[0].text, "@@ -10,4 +20,5 @@ function test() {");

  assert.equal(rows[1].kind, " ");
  assert.equal(rows[1].oldNum, 10);
  assert.equal(rows[1].newNum, 20);
  assert.equal(rows[1].text, "context 1");

  assert.equal(rows[2].kind, "-");
  assert.equal(rows[2].oldNum, 11);
  assert.equal(rows[2].newNum, undefined);
  assert.equal(rows[2].text, "deleted line");

  assert.equal(rows[3].kind, "+");
  assert.equal(rows[3].oldNum, undefined);
  assert.equal(rows[3].newNum, 21);
  assert.equal(rows[3].text, "added line 1");

  assert.equal(rows[4].kind, "+");
  assert.equal(rows[4].oldNum, undefined);
  assert.equal(rows[4].newNum, 22);
  assert.equal(rows[4].text, "added line 2");

  assert.equal(rows[5].kind, " ");
  assert.equal(rows[5].oldNum, 12);
  assert.equal(rows[5].newNum, 23);
  assert.equal(rows[5].text, "context 2");
});

test("lineSegments: overlays intra-line change ranges onto syntax spans", () => {
  const spans = [
    { text: "const ", kind: "keyword" },
    { text: "a = ", kind: "plain" },
    { text: "1", kind: "number" },
  ];
  const changes = [[10, 11]]; // offsets for "1"
  const segs = lineSegments(spans, changes);

  assert.deepEqual(segs, [
    { text: "const ", kind: "keyword", changed: false },
    { text: "a = ", kind: "plain", changed: false },
    { text: "1", kind: "number", changed: true },
  ]);
});

test("wrapInlineRows: splits long lines and keeps spans and change ranges", () => {
  const row = {
    kind: "+",
    oldNum: null,
    newNum: 7,
    text: "abcdefghijklmnopqrstuvwxy",
    spans: [
      { text: "abcdefghij", kind: "keyword" },
      { text: "klmnopqrstuvwxy", kind: "plain" },
    ],
    changes: [[8, 15]],
  };

  const rows = wrapInlineRows([row], 10);

  assert.deepEqual(
    rows.map((r) => r.text),
    ["abcdefghij", "klmnopqrst", "uvwxy"]
  );
  assert.equal(rows[0].newNum, 7);
  assert.equal(rows[1].newNum, null);
  assert.equal(rows[2].newNum, null);
  assert.equal(rows[0].kind, "+");
  assert.deepEqual(rows[0].spans, [{ text: "abcdefghij", kind: "keyword" }]);
  assert.deepEqual(rows[0].changes, [[8, 10]]);
  assert.deepEqual(rows[1].changes, [[0, 5]]);
  assert.deepEqual(rows[2].changes, []);
});

test("wrapInlineRows: prefers breaking at spaces", () => {
  const rows = wrapInlineRows([{ kind: " ", oldNum: 1, newNum: 1, text: "alpha beta gamma delta" }], 12);

  assert.deepEqual(
    rows.map((r) => r.text),
    ["alpha beta ", "gamma delta"]
  );
});

test("wrapInlineRows: counts code points so emoji are never split", () => {
  const rows = wrapInlineRows([{ kind: " ", oldNum: 1, newNum: 1, text: "a😀bcdef" }], 2);

  assert.deepEqual(
    rows.map((r) => r.text),
    ["a😀", "bc", "de", "f"]
  );
  assert.equal(rows.map((r) => r.text).join(""), "a😀bcdef");
});

test("wrapInlineRows: keeps spans and change ranges on non-ASCII lines", () => {
  const row = {
    kind: "+",
    newNum: 4,
    text: "áéíóú alpha",
    spans: [
      { text: "áéíóú ", kind: "string" },
      { text: "alpha", kind: "plain" },
    ],
    changes: [[0, 5]],
  };

  const rows = wrapInlineRows([row], 6);

  assert.deepEqual(
    rows.map((r) => r.text),
    ["áéíóú ", "alpha"]
  );
  assert.deepEqual(rows[0].spans, [{ text: "áéíóú ", kind: "string" }]);
  assert.deepEqual(rows[0].changes, [[0, 5]]);
  assert.deepEqual(rows[1].changes, []);
});

test("wrapInlineRows: wraps a long ASCII line into complete chunks", () => {
  const text = "a".repeat(5000);
  const rows = wrapInlineRows([{ kind: "+", newNum: 1, text }], 100);

  assert.equal(rows.length, 50);
  assert.equal(rows.map((r) => r.text).join(""), text);
  assert.equal(rows[0].newNum, 1);
  assert.equal(rows[49].newNum, null);
});

test("wrapInlineRows: leaves a short diff untouched", () => {
  const row = { kind: " ", oldNum: 1, newNum: 2, text: "short" };
  const rows = wrapInlineRows([row], 80);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "short");
  assert.equal(rows[0].oldNum, 1);
});

test("wrapSplitRows: keeps panes aligned and fills the shorter side", () => {
  const left = [
    {
      kind: "pair",
      left: { kind: "-", num: 10, text: "0123456789ABCDEF", spans: [], changes: [] },
      right: { kind: "+", num: 3, text: "short", spans: [], changes: [] },
    },
  ];

  const wrapped = wrapSplitRows(left, left, 10);

  assert.equal(wrapped.left.length, 2);
  assert.equal(wrapped.right.length, 2);
  assert.equal(wrapped.left[0].left.num, 10);
  assert.equal(wrapped.left[0].left.text, "0123456789");
  assert.equal(wrapped.left[0].right.text, "short");
  assert.equal(wrapped.left[1].left.num, null);
  assert.equal(wrapped.left[1].left.text, "ABCDEF");
  assert.equal(wrapped.left[1].right, null);
});

test("wrapSplitRows: wraps hunk headers once and keeps the empty side empty", () => {
  const left = [{ kind: "@", text: "@@ -1,2 +1,2 @@ a long hunk header" }];
  const right = [{ kind: "@", text: "" }];

  const wrapped = wrapSplitRows(left, right, 10);

  assert.equal(wrapped.left.length, wrapped.right.length);
  assert.equal(wrapped.left.map((row) => row.text).join(""), left[0].text);
  assert.ok(wrapped.right.every((row) => row.text === ""));
});

test("isFreeModel and cleanModelLabel: correctly detect free models and format names", () => {
  assert.equal(isFreeModel("opencode/deepseek-v4.1-flash-free#low"), true);
  assert.equal(isFreeModel("opencode/big-pickle"), true);
  assert.equal(isFreeModel("github-copilot/claude-haiku-5.5"), false);
  assert.equal(isFreeModel("anthropic/claude-3-7-sonnet"), false);

  assert.equal(cleanModelLabel("github-copilot/claude-haiku-5.5"), "Claude Haiku 5.5");
  assert.equal(cleanModelLabel("opencode/deepseek-v4.1-flash-free#low"), "DeepSeek V4.1 Flash Free");
  assert.equal(cleanModelLabel("google/gemini-2.5-flash"), "Gemini 2.5 Flash");
});

test("isLightColor: picks the contrasting toast spinner", () => {
  assert.equal(isLightColor("#ffffff"), true);
  assert.equal(isLightColor("#f5f5f5"), true);
  assert.equal(isLightColor("#000000"), false);
  assert.equal(isLightColor("#1e1e1e"), false);
  assert.equal(isLightColor("#777"), false);
  assert.equal(isLightColor("fff"), true);
  // Invalid or missing colors use the light-background spinner (a dark ring),
  // which stays visible when the theme cannot be read.
  assert.equal(isLightColor(null), true);
  assert.equal(isLightColor("not-a-color"), true);
});

test("resolveCleanAgentModelLogic: honors saved model even if paid over default free models", () => {
  const models = [
    { id: "opencode/deepseek-v4.1-flash-free", free: true },
    { id: "opencode/glm-5.3-flash-free", free: true },
    { id: "github-copilot/claude-haiku-5.5", free: false },
  ];
  const preferences = ["opencode/deepseek-v4.1-flash-free#low"];

  // When Haiku is saved, it should resolve to Haiku
  const resolved = resolveCleanAgentModelLogic(models, {
    saved: "github-copilot/claude-haiku-5.5",
    preferences,
  });
  assert.equal(resolved, "github-copilot/claude-haiku-5.5");

  // When an explicit override is passed, override wins
  const overridden = resolveCleanAgentModelLogic(models, {
    override: "opencode/glm-5.3-flash-free",
    saved: "github-copilot/claude-haiku-5.5",
    preferences,
  });
  assert.equal(overridden, "opencode/glm-5.3-flash-free");

  // When saved model is not in models catalog, fallback to preference
  const fallback = resolveCleanAgentModelLogic(models, {
    saved: "unknown-provider/gone-model",
    preferences,
  });
  assert.equal(fallback, "opencode/deepseek-v4.1-flash-free#low");
});

test("filterVisibleCleanModels: includes active paid model at index 0 even when showAll is false", () => {
  const models = [
    { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free", provider: "opencode", free: true },
    { id: "opencode/glm-5.3-flash-free", label: "GLM 5.3 Flash Free", provider: "opencode", free: true },
    { id: "github-copilot/claude-haiku-5.5", label: "Claude Haiku 5.5", provider: "github-copilot", free: false },
    { id: "github-copilot/gpt-4o", label: "GPT 4o", provider: "github-copilot", free: false },
  ];

  // showAll: false, but activeModel is Claude Haiku 5.5
  const visible = filterVisibleCleanModels(models, {
    showAll: false,
    activeModel: "github-copilot/claude-haiku-5.5",
  });

  // Haiku MUST be included and at index 0
  assert.equal(visible[0].id, "github-copilot/claude-haiku-5.5");
  assert.ok(visible.some((m) => m.id === "opencode/deepseek-v4.1-flash-free"));
  assert.ok(visible.some((m) => m.id === "opencode/glm-5.3-flash-free"));
  // Other non-active paid models are omitted when showAll is false
  assert.ok(!visible.some((m) => m.id === "github-copilot/gpt-4o"));

  // When provider is github-copilot
  const copilotVisible = filterVisibleCleanModels(models, {
    provider: "github-copilot",
    showAll: false,
    activeModel: "github-copilot/claude-haiku-5.5",
  });
  assert.equal(copilotVisible[0].id, "github-copilot/claude-haiku-5.5");

  // When search query is entered
  const searched = filterVisibleCleanModels(models, {
    query: "deepseek",
    activeModel: "github-copilot/claude-haiku-5.5",
  });
  assert.equal(searched.length, 1);
  assert.equal(searched[0].id, "opencode/deepseek-v4.1-flash-free");
});

test("OPENCODE_INSTALL_CMD and OPENCODE_DOCS_URL constants are properly defined", () => {
  assert.equal(OPENCODE_INSTALL_CMD, "curl -fsSL https://opencode.ai/install | bash");
  assert.equal(OPENCODE_DOCS_URL, "https://opencode.ai/docs/");
});

test("splitRemoteBranch: cleanly extracts remote and branch name across remotes and slashes", () => {
  // Simple branch on origin
  assert.deepEqual(splitRemoteBranch("origin/main", ["origin"]), {
    remote: "origin",
    branch: "main",
  });

  // Nested branch name on origin
  assert.deepEqual(splitRemoteBranch("origin/feat/nested-feature", ["origin"]), {
    remote: "origin",
    branch: "feat/nested-feature",
  });

  // Multiple remotes, matching non-default remote
  assert.deepEqual(splitRemoteBranch("upstream/feat/login", ["origin", "upstream"]), {
    remote: "upstream",
    branch: "feat/login",
  });

  // Prefix remote matching (e.g. origin vs origin-backup)
  assert.deepEqual(splitRemoteBranch("origin-backup/main", ["origin", "origin-backup"]), {
    remote: "origin-backup",
    branch: "main",
  });

  // Fallback when remotes list is empty or doesn't match
  assert.deepEqual(splitRemoteBranch("custom/patch-1", []), {
    remote: "custom",
    branch: "patch-1",
  });

  // No slash fallback
  assert.deepEqual(splitRemoteBranch("feature", ["origin"]), {
    remote: "origin",
    branch: "feature",
  });

  // Empty string
  assert.deepEqual(splitRemoteBranch("", ["origin"]), {
    remote: "origin",
    branch: "",
  });
});

test("deleteRemoteBranchArgs: safely constructs git push delete arguments", () => {
  assert.deepEqual(deleteRemoteBranchArgs("origin", "main"), [
    "push",
    "origin",
    "--delete",
    "--end-of-options",
    "main",
  ]);

  assert.deepEqual(deleteRemoteBranchArgs("upstream", "feat/nested-branch"), [
    "push",
    "upstream",
    "--delete",
    "--end-of-options",
    "feat/nested-branch",
  ]);
});

test("fetchRemoteBranchArgs: refreshes exactly one remote-tracking ref", () => {
  assert.deepEqual(fetchRemoteBranchArgs("origin", "main"), [
    "fetch",
    "origin",
    "--end-of-options",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);

  assert.deepEqual(fetchRemoteBranchArgs("upstream", "feat/nested"), [
    "fetch",
    "upstream",
    "--end-of-options",
    "+refs/heads/feat/nested:refs/remotes/upstream/feat/nested",
  ]);
});

test("renameRemoteBranchPushArgs: pushes the tracked ref under the new branch name", () => {
  assert.deepEqual(renameRemoteBranchPushArgs("origin", "main", "trunk"), [
    "push",
    "origin",
    "--end-of-options",
    "refs/remotes/origin/main:refs/heads/trunk",
  ]);

  assert.deepEqual(renameRemoteBranchPushArgs("upstream", "feat/old", "feat/nested/new"), [
    "push",
    "upstream",
    "--end-of-options",
    "refs/remotes/upstream/feat/old:refs/heads/feat/nested/new",
  ]);
});

test("pushArgs: builds upstream and force-with-lease variants", () => {
  assert.deepEqual(pushArgs({ hasUpstream: true, remote: "origin", branch: "main" }), ["push"]);

  assert.deepEqual(pushArgs({ hasUpstream: false, remote: "origin", branch: "feat/x" }), [
    "push",
    "--set-upstream",
    "--end-of-options",
    "origin",
    "feat/x",
  ]);

  assert.deepEqual(pushArgs({ hasUpstream: true, remote: "origin", branch: "main", force: true }), [
    "push",
    "--force-with-lease",
  ]);
  // Never plain --force: the lease must protect a remote that moved again.
  assert.equal(pushArgs({ hasUpstream: true, force: true }).includes("--force"), false);

  assert.deepEqual(
    pushArgs({ hasUpstream: false, remote: "upstream", branch: "feat/nested/new", force: true }),
    ["push", "--force-with-lease", "--set-upstream", "--end-of-options", "upstream", "feat/nested/new"]
  );
});

test("isPushRejection: offers force only for diverged remote branches", () => {
  assert.equal(
    isPushRejection("! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs to 'origin'"),
    true
  );
  assert.equal(isPushRejection("! [rejected] feat/x -> feat/x (fetch first)"), true);
  assert.equal(isPushRejection("! [rejected] main -> main (stale info)"), true);

  // A server-side hook rejection cannot be fixed by rewriting the ref.
  assert.equal(
    isPushRejection("! [remote rejected] main -> main (pre-receive hook declined)"),
    false
  );
  assert.equal(isPushRejection("fatal: unable to access 'https://example.com/repo.git'"), false);
  assert.equal(isPushRejection(""), false);
});

test("resolveDisplayRefs: folds HEAD and pairs local with remote refs", () => {
  const rawRefs = [
    { kind: "head", text: "HEAD" },
    { kind: "local", text: "main" },
    { kind: "remote", text: "origin/main" },
    { kind: "remote", text: "origin/feature-z" },
    { kind: "tag", text: "v1.0.0" },
  ];
  const displayRefs = resolveDisplayRefs(rawRefs);

  // HEAD is folded into main with isHead: true, and origin/main paired into main
  assert.equal(displayRefs.length, 3);
  assert.equal(displayRefs[0].kind, "local");
  assert.equal(displayRefs[0].text, "main");
  assert.equal(displayRefs[0].isHead, true);
  assert.deepEqual(displayRefs[0].pairedRemote, { kind: "remote", text: "origin/main" });

  // Unpaired remote
  assert.equal(displayRefs[1].kind, "remote");
  assert.equal(displayRefs[1].text, "origin/feature-z");

  // Tag
  assert.equal(displayRefs[2].kind, "tag");
  assert.equal(displayRefs[2].text, "v1.0.0");
});

test("parseCommitLog: parses unit-separated git log lines into rich commit objects", () => {
  const line1 = [
    "c0ffee0123456789abcdef0123456789abcdef01",
    "parent1 parent2",
    "Alice",
    "alice@example.com",
    "1700000000",
    "HEAD -> refs/heads/main, refs/remotes/origin/main",
    "feat: add parallel loading",
  ].join("\x1f");

  const line2 = [
    "deadbeef23456789abcdef0123456789abcdef01",
    "",
    "Bob",
    "bob@example.com",
    "1699999000",
    "tag: refs/tags/v0.1.0",
    "chore: initial commit",
  ].join("\x1f");

  const commits = parseCommitLog(`${line1}\n${line2}\n`);
  assert.equal(commits.length, 2);

  assert.equal(commits[0].hash, "c0ffee0123456789abcdef0123456789abcdef01");
  assert.equal(commits[0].shortHash, "c0ffee0");
  assert.deepEqual(commits[0].parents, ["parent1", "parent2"]);
  assert.equal(commits[0].author, "Alice");
  assert.equal(commits[0].email, "alice@example.com");
  assert.equal(commits[0].timestamp, 1700000000);
  assert.equal(commits[0].subject, "feat: add parallel loading");
  assert.equal(commits[0].isHead, true);
  assert.equal(commits[0].displayRefs.length, 1);
  assert.equal(commits[0].displayRefs[0].text, "main");
  assert.equal(commits[0].displayRefs[0].isHead, true);
  assert.deepEqual(commits[0].displayRefs[0].pairedRemote, { kind: "remote", text: "origin/main" });

  assert.equal(commits[1].hash, "deadbeef23456789abcdef0123456789abcdef01");
  assert.deepEqual(commits[1].parents, []);
  assert.equal(commits[1].author, "Bob");
  assert.equal(commits[1].isHead, false);
  assert.equal(commits[1].displayRefs.length, 1);
  assert.equal(commits[1].displayRefs[0].kind, "tag");
  assert.equal(commits[1].displayRefs[0].text, "v0.1.0");

  // Empty input returns empty array
  assert.deepEqual(parseCommitLog(""), []);
  assert.deepEqual(parseCommitLog(null), []);
});

test("fileIconPath: matches the file editor's Material Icon Theme pattern", () => {
  // Exact names win over the extension, case-insensitively.
  assert.equal(fileIconPath("Dockerfile"), "mods/git-graph/icons/docker.svg");
  assert.equal(fileIconPath(".gitignore"), "mods/git-graph/icons/git.svg");
  assert.equal(fileIconPath("package-lock.json"), "mods/git-graph/icons/nodejs.svg");
  assert.equal(fileIconPath("yarn.lock"), "mods/git-graph/icons/yarn.svg");

  // Extensions, including paths and uppercase names.
  assert.equal(fileIconPath("src/app.ts"), "mods/git-graph/icons/typescript.svg");
  assert.equal(fileIconPath("App.TSX"), "mods/git-graph/icons/react_ts.svg");
  assert.equal(fileIconPath("styles.scss"), "mods/git-graph/icons/sass.svg");
  assert.equal(fileIconPath("README.md"), "mods/git-graph/icons/markdown.svg");

  // `.env` variants use the tune icon, and unknown files fall back to the document icon.
  assert.equal(fileIconPath(".env"), "mods/git-graph/icons/tune.svg");
  assert.equal(fileIconPath(".env.local"), "mods/git-graph/icons/tune.svg");
  assert.equal(fileIconPath("mystery.qqq"), `mods/git-graph/icons/${FILE_ICON_DEFAULT}.svg`);
  assert.equal(fileIconPath("LICENSE"), `mods/git-graph/icons/${FILE_ICON_DEFAULT}.svg`);
  assert.equal(fileIconPath(""), `mods/git-graph/icons/${FILE_ICON_DEFAULT}.svg`);

  // Light backgrounds pick the `_light` variant only when the icon provides one.
  assert.equal(fileIconPath("Cargo.toml", true), "mods/git-graph/icons/toml_light.svg");
  assert.equal(fileIconPath("pnpm-lock.yaml", true), "mods/git-graph/icons/pnpm_light.svg");
  assert.equal(fileIconPath("bun.lockb", true), "mods/git-graph/icons/bun_light.svg");
  assert.equal(fileIconPath("src/app.ts", true), "mods/git-graph/icons/typescript.svg");

  // Folders use the shared folder icon.
  assert.equal(FOLDER_ICON_PATH, "mods/git-graph/icons/folder-base.svg");
});

test("fileEditorTabTarget: reuses recorded editor tabs and derives unique names", () => {
  assert.equal(FILE_EDITOR_MOD, "file-editor");
  assert.match(FILE_EDITOR_INSTALL_HINT, /file-editor mod/);

  // Reuses a live tab by its recorded id, refreshing the shared entry.
  const byId = fileEditorTabTarget(
    "/repo",
    "src/app.js",
    [
      { id: "tab-1", name: "app.js" },
      { id: "tab-2", name: "app.js (2)" },
    ],
    { "/repo/src/app.js": { root: "/repo", file: "src/app.js", tabId: "tab-2", tabName: "app.js (2)" } },
    new Set(["tab-2"])
  );
  assert.equal(byId.existingTabId, "tab-2");
  assert.equal(byId.tabName, "app.js (2)");
  assert.deepEqual(byId.entry, {
    root: "/repo",
    file: "src/app.js",
    tabId: "tab-2",
    tabName: "app.js (2)",
  });

  // Falls back to the recorded name when the entry has no tab id yet.
  const byName = fileEditorTabTarget(
    "/repo",
    "README.md",
    [{ id: "tab-3", name: "README.md" }],
    { "/repo/README.md": { root: "/repo", file: "README.md", tabName: "README.md" } },
    ["tab-3"]
  );
  assert.equal(byName.existingTabId, "tab-3");
  assert.equal(byName.entry.tabId, "tab-3");

  // A same-named tab that is not the file editor must not be reused.
  const wrongTab = fileEditorTabTarget(
    "/repo",
    "README.md",
    [{ id: "terminal-1", name: "README.md" }],
    { "/repo/README.md": { root: "/repo", file: "README.md", tabName: "README.md" } },
    new Set(["editor-1"])
  );
  assert.equal(wrongTab.existingTabId, null);
  assert.equal(wrongTab.tabName, "repo/README.md");
  assert.equal(wrongTab.fileKey, "/repo/README.md");

  // No collision keeps the basename.
  const fresh = fileEditorTabTarget("/repo", "mods/git-graph/main.js", [], {}, new Set());
  assert.equal(fresh.existingTabId, null);
  assert.equal(fresh.tabName, "main.js");
  assert.deepEqual(fresh.entry, { root: "/repo", file: "mods/git-graph/main.js", tabName: "main.js" });

  // A basename collision prefers the containing directory, then the
  // repository name, then a numeric suffix. Settled tabs do not reserve a name.
  const relative = fileEditorTabTarget(
    "/repo",
    "src/lib/index.js",
    [{ id: "tab-1", name: "index.js" }]
  );
  assert.equal(relative.tabName, "src/lib");

  const rootName = fileEditorTabTarget(
    "/repo",
    "index.js",
    [{ id: "tab-1", name: "index.js" }]
  );
  assert.equal(rootName.tabName, "repo/index.js");

  const numbered = fileEditorTabTarget(
    "/repo",
    "index.js",
    [
      { id: "tab-1", name: "index.js" },
      { id: "tab-2", name: "repo/index.js" },
      { id: "tab-3", name: "repo/index.js (2)" },
      { id: "tab-4", name: "repo/index.js (3)", settled: true },
    ]
  );
  assert.equal(numbered.tabName, "repo/index.js (3)");

  // Windows separators and trailing root slashes normalize to one shared key.
  const windows = fileEditorTabTarget("C:\\repo\\", "src\\app.js", []);
  assert.equal(windows.fileKey, "C:/repo/src/app.js");
  assert.equal(windows.entry.file, "src/app.js");

  // Missing targets are never opened.
  assert.deepEqual(fileEditorTabTarget("/repo", "", []), {
    existingTabId: null,
    tabName: "File",
    fileKey: "/repo/",
    entry: null,
  });
});

test("resolveRepoPath: joins repository-relative files without doubling separators", () => {
  assert.equal(resolveRepoPath("/repo", "src/app.js"), "/repo/src/app.js");
  assert.equal(resolveRepoPath("/repo/", "/src/app.js"), "/repo/src/app.js");
  assert.equal(resolveRepoPath("C:\\repo\\", "src\\app.js"), "C:/repo/src/app.js");
  assert.equal(resolveRepoPath("/repo", ""), "/repo");
  assert.equal(resolveRepoPath("", "src/app.js"), "src/app.js");
  assert.equal(resolveRepoPath(null, "src/app.js"), "src/app.js");
});

test("file icons: every mapped icon ships with the mod", () => {
  const iconsDir = new URL("../mods/git-graph/icons/", import.meta.url);
  const has = (name) => existsSync(fileURLToPath(new URL(`${name}.svg`, iconsDir)));

  for (const [name, icon] of Object.entries(FILE_ICON_BY_NAME)) {
    assert.ok(has(icon), `missing icon for ${name}: ${icon}.svg`);
  }
  for (const [ext, icon] of Object.entries(FILE_ICON_BY_EXT)) {
    assert.ok(has(icon), `missing icon for .${ext}: ${icon}.svg`);
  }
  for (const icon of ["bun", "pnpm", "toml"]) {
    assert.ok(has(icon), `missing icon: ${icon}.svg`);
    assert.ok(has(`${icon}_light`), `missing light icon: ${icon}_light.svg`);
  }
  for (const icon of [FILE_ICON_DEFAULT, "tune", "open-file"]) {
    assert.ok(has(icon), `missing icon: ${icon}.svg`);
  }
  assert.ok(has("folder-base"), "missing folder-base.svg");
});

test("badgeTooltip: returns full text for local, remote, paired, tag, head, and handles empty", () => {
  assert.equal(badgeTooltip(null), "");
  assert.equal(badgeTooltip({ kind: "head", text: "HEAD" }), "HEAD");
  assert.equal(
    badgeTooltip({ kind: "local", text: "feature/user-authentication-login-flow-long-branch" }),
    "feature/user-authentication-login-flow-long-branch"
  );
  assert.equal(
    badgeTooltip({
      kind: "local",
      text: "feature/user-auth",
      pairedRemote: { text: "origin/feature/user-auth" },
    }),
    "feature/user-auth | origin/feature/user-auth"
  );
  assert.equal(badgeTooltip({ kind: "tag", text: "v2.5.0-rc.1-preview" }), "v2.5.0-rc.1-preview");
  assert.equal(
    badgeTooltip({ kind: "remote", text: "upstream/feature/something" }),
    "upstream/feature/something"
  );
});

test("extraRefsTooltip: joins extra refs formatted with badgeTooltip", () => {
  assert.equal(extraRefsTooltip([]), "");
  assert.equal(extraRefsTooltip(null), "");
  const extra = [
    { kind: "tag", text: "v1.0.0" },
    {
      kind: "local",
      text: "feature/billing",
      pairedRemote: { text: "origin/feature/billing" },
    },
    { kind: "remote", text: "origin/legacy" },
  ];
  assert.equal(
    extraRefsTooltip(extra),
    "v1.0.0, feature/billing | origin/feature/billing, origin/legacy"
  );
});

// Porcelain text in the shape `git worktree list --porcelain` prints, including
// the detached, prunable, and bare records that the parser must handle.
const WORKTREE_PORCELAIN = [
  "worktree /Users/me/code/app",
  "HEAD 2025dfd40e31010df85ab02bb51a19b8c1afa5c9",
  "branch refs/heads/main",
  "",
  "worktree /Users/me/.herdr/worktrees/app/feat-alpha",
  "HEAD 2025dfd40e31010df85ab02bb51a19b8c1afa5c9",
  "branch refs/heads/feat/alpha",
  "",
  "worktree /Users/me/.herdr/worktrees/app/review",
  "HEAD 2025dfd40e31010df85ab02bb51a19b8c1afa5c9",
  "detached",
  "",
  "worktree /Users/me/.herdr/worktrees/app/gone",
  "HEAD 2025dfd40e31010df85ab02bb51a19b8c1afa5c9",
  "branch refs/heads/feat/gone",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

test("parseWorktreeList: main first, linked branches, detached, and prunable records", () => {
  assert.deepEqual(parseWorktreeList(WORKTREE_PORCELAIN), [
    { path: "/Users/me/code/app", branch: "main", main: true },
    { path: "/Users/me/.herdr/worktrees/app/feat-alpha", branch: "feat/alpha", main: false },
    { path: "/Users/me/.herdr/worktrees/app/review", branch: null, main: false },
  ]);
});

test("parseWorktreeList: bare records are skipped and never count as the main checkout", () => {
  const bare = [
    "worktree /srv/git/app.git",
    "bare",
    "",
    "worktree /srv/wt/main",
    "HEAD 2025dfd40e31010df85ab02bb51a19b8c1afa5c9",
    "branch refs/heads/main",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(bare), [
    { path: "/srv/wt/main", branch: "main", main: false },
  ]);
});

test("parseWorktreeList: CRLF output, paths with spaces, locked records, and empty input", () => {
  const crlf = [
    "worktree /Users/me/My Projects/app",
    "HEAD 2025dfd40e31010df85ab02bb51a19b8c1afa5c9",
    "branch refs/heads/main",
    "",
    "worktree /Users/me/My Projects/wt",
    "HEAD 2025dfd40e31010df85ab02bb51a19b8c1afa5c9",
    "branch refs/heads/feat/x",
    "locked",
    "",
  ].join("\r\n");
  assert.deepEqual(parseWorktreeList(crlf), [
    { path: "/Users/me/My Projects/app", branch: "main", main: true },
    { path: "/Users/me/My Projects/wt", branch: "feat/x", main: false },
  ]);
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList(undefined), []);
});

test("worktreeBranchMap and findBranchCheckout: only linked branches count as worktree branches", () => {
  const checkouts = parseWorktreeList(WORKTREE_PORCELAIN);
  const map = worktreeBranchMap(checkouts);
  assert.equal(map.get("feat/alpha"), "/Users/me/.herdr/worktrees/app/feat-alpha");
  assert.equal(map.has("main"), false, "the main checkout's branch is not a worktree branch");
  assert.equal(map.size, 1);

  // From the main checkout, a branch held by a linked worktree resolves to it.
  assert.equal(
    findBranchCheckout(checkouts, "feat/alpha", "/Users/me/code/app")?.path,
    "/Users/me/.herdr/worktrees/app/feat-alpha"
  );
  // From a linked worktree, the main checkout's branch resolves to the main checkout.
  assert.equal(
    findBranchCheckout(checkouts, "main", "/Users/me/.herdr/worktrees/app/feat-alpha")?.main,
    true
  );
  // The current root's own branch is not "held elsewhere", and unknown branches are not held.
  assert.equal(findBranchCheckout(checkouts, "feat/alpha", "/Users/me/.herdr/worktrees/app/feat-alpha"), null);
  assert.equal(findBranchCheckout(checkouts, "nope", "/Users/me/code/app"), null);
  assert.equal(findBranchCheckout(checkouts, "", "/Users/me/code/app"), null);
});

test("markWorktreeRefs: flags only local display refs whose branch lives in a linked worktree", () => {
  const checkouts = parseWorktreeList(WORKTREE_PORCELAIN);
  const commits = markWorktreeRefs(
    [
      {
        displayRefs: resolveDisplayRefs(
          parseRefs("HEAD -> refs/heads/main, refs/heads/feat/alpha, refs/remotes/origin/feat/alpha, tag: refs/tags/v1")
        ),
      },
    ],
    checkouts
  );
  const byText = Object.fromEntries(commits[0].displayRefs.map((ref) => [ref.text, ref]));
  assert.equal(byText["feat/alpha"].isWorktree, true);
  assert.equal(byText["feat/alpha"].worktreePath, "/Users/me/.herdr/worktrees/app/feat-alpha");
  assert.equal(byText["feat/alpha"].pairedRemote.text, "origin/feat/alpha");
  assert.equal(byText.main.isWorktree, false);
  assert.equal(byText.main.worktreePath, null);
  assert.equal(byText["v1"].isWorktree, undefined, "tags are never marked");
});

test("badgeTooltip: a worktree branch says so and names its path", () => {
  const path = "/Users/me/.herdr/worktrees/app/feat-alpha";
  assert.equal(
    badgeTooltip({ kind: "local", text: "feat/alpha", isWorktree: true, worktreePath: path }),
    `feat/alpha · worktree branch at ${path}`
  );
  assert.equal(
    badgeTooltip({
      kind: "local",
      text: "feat/alpha",
      isWorktree: true,
      worktreePath: path,
      pairedRemote: { text: "origin/feat/alpha" },
    }),
    `feat/alpha | origin/feat/alpha · worktree branch at ${path}`
  );
  assert.equal(
    badgeTooltip({ kind: "local", text: "feat/alpha", isWorktree: true, worktreePath: null }),
    "feat/alpha · worktree branch"
  );
  // Plain branches keep their exact tooltip.
  assert.equal(badgeTooltip({ kind: "local", text: "feat/alpha", isWorktree: false }), "feat/alpha");
});

test("findCheckoutSpace: matches the space whose terminal sits inside the checkout", () => {
  const spaces = [
    { id: "s-main", machine: null, tabs: [{ id: "t1" }], folder: "/code/app" },
    { id: "s-alpha", machine: null, tabs: [{ id: "t2" }], folder: "/wt/app/alpha" },
  ];
  const panes = [
    { tab: "t1", cwd: "/code/app" },
    { tab: "t2", cwd: "/wt/app/alpha/src/deep" },
  ];
  assert.equal(findCheckoutSpace("/wt/app/alpha", spaces, panes, null)?.id, "s-alpha");
  assert.equal(findCheckoutSpace("/code/app", spaces, panes, null)?.id, "s-main");
  assert.equal(findCheckoutSpace("/wt/app/alpha/", spaces, panes, null)?.id, "s-alpha", "trailing slash");
});

test("findCheckoutSpace: a sibling that only shares a name prefix never matches", () => {
  const spaces = [{ id: "s-wt2", machine: null, tabs: [{ id: "t1" }], folder: "/a/wt2" }];
  const panes = [{ tab: "t1", cwd: "/a/wt2/src" }];
  assert.equal(findCheckoutSpace("/a/wt", spaces, panes, null), null);
  assert.equal(findCheckoutSpace("/a/wt2", spaces, panes, null)?.id, "s-wt2");
});

test("findCheckoutSpace: a nested checkout keeps the terminals inside it (deepest checkout wins)", () => {
  const spaces = [{ id: "s-inner", machine: null, tabs: [{ id: "t1" }], folder: "/a/wt/inner" }];
  const panes = [{ tab: "t1", cwd: "/a/wt/inner/x" }];
  const checkoutPaths = ["/a/wt", "/a/wt/inner"];
  assert.equal(findCheckoutSpace("/a/wt", spaces, panes, null, checkoutPaths), null);
  assert.equal(findCheckoutSpace("/a/wt/inner", spaces, panes, null, checkoutPaths)?.id, "s-inner");
});

test("findCheckoutSpace: no space, machine mismatch, folder fallback, and Windows separators", () => {
  const spaces = [{ id: "s-remote", machine: "box", tabs: [{ id: "t1" }], folder: "/srv/wt/app" }];
  const panes = [{ tab: "t1", cwd: "/srv/wt/app" }];
  assert.equal(findCheckoutSpace("/srv/wt/app", spaces, panes, null), null, "machine mismatch");
  assert.equal(findCheckoutSpace("/srv/wt/app", spaces, panes, "box")?.id, "s-remote");
  assert.equal(findCheckoutSpace("/elsewhere", spaces, panes, "box"), null, "no space holds it");
  assert.equal(findCheckoutSpace("", spaces, panes, "box"), null);

  // A space with no terminal yet falls back to the folder it was created in.
  const folderOnly = [{ id: "s-folder", machine: null, tabs: [], folder: "/wt/app/beta" }];
  assert.equal(findCheckoutSpace("/wt/app/beta", folderOnly, [], null)?.id, "s-folder");

  const windows = [{ id: "s-win", machine: null, tabs: [{ id: "t1" }], folder: "C:\\wt\\app" }];
  const winPanes = [{ tab: "t1", cwd: "C:\\wt\\app\\src" }];
  assert.equal(findCheckoutSpace("C:/wt/app", windows, winPanes, null)?.id, "s-win");
});

test("mergedCheckArgs and removeWorktreeArgs: fully qualified refs, end-of-options, never forced", () => {
  assert.deepEqual(mergedCheckArgs("feat/alpha"), [
    "merge-base",
    "--is-ancestor",
    "--end-of-options",
    "refs/heads/feat/alpha",
    "HEAD",
  ]);
  // A name that starts with a dash is still spelled as a full ref, so it cannot be read as an option.
  assert.equal(mergedCheckArgs("-rf")[3], "refs/heads/-rf");

  assert.deepEqual(removeWorktreeArgs("/wt/app/alpha"), [
    "worktree",
    "remove",
    "--end-of-options",
    "/wt/app/alpha",
  ]);
  assert.equal(removeWorktreeArgs("/wt/app/alpha").includes("--force"), false);
});

test("normalizeCheckoutPath and SPACE_ACTIONS_MOD", () => {
  assert.equal(normalizeCheckoutPath("C:\\wt\\app\\"), "C:/wt/app");
  assert.equal(normalizeCheckoutPath("/wt/app//"), "/wt/app");
  assert.equal(normalizeCheckoutPath(null), "");
  assert.equal(SPACE_ACTIONS_MOD, "worktree-plus");
});

test("parseCommitStats: sums numstat lines and treats binary files as zero lines", () => {
  const log = [
    "abc123\x1ffeat: add first slice",
    "10\t2\tmods/git-graph/main.js",
    "-\t-\ticons/logo.png",
    "",
    "def456\x1ffix: correct second slice",
    "3\t5\tmods/git-graph/git-logic.js",
    "",
  ].join("\n");

  assert.deepEqual(parseCommitStats(log), [
    {
      hash: "abc123",
      subject: "feat: add first slice",
      files: 2,
      added: 10,
      deleted: 2,
      changed: 12,
    },
    {
      hash: "def456",
      subject: "fix: correct second slice",
      files: 1,
      added: 3,
      deleted: 5,
      changed: 8,
    },
  ]);

  const crlf = parseCommitStats("abc123\x1ffeat: crlf\r\n4\t1\tfile.js\r\n");
  assert.equal(crlf[0].subject, "feat: crlf");
  assert.equal(crlf[0].changed, 5);
});

test("findLargeCommit: returns the largest commit only when it crosses the threshold", () => {
  const log = [
    "aaa111\x1ffeat: small slice",
    "500\t100\tmods/git-graph/main.js",
    "",
    "bbb222\x1ffeat: bundled slice",
    "1700\t400\tmods/git-graph/main.js",
    "",
  ].join("\n");

  const large = findLargeCommit(log, 1000);
  assert.equal(large?.hash, "bbb222");
  assert.equal(large?.changed, 2100);
  assert.equal(findLargeCommit(log, 2500), null);

  const smallOnly = "ccc333\x1ffeat: single file\n20\t5\tmods/git-graph/main.js\n";
  assert.equal(findLargeCommit(smallOnly, 1000), null);
  assert.equal(findLargeCommit("", 1000), null);
});

test("isDiffable: identifies binary non-diffable files by extension and git metadata", () => {
  // Common image formats (e.g. png, jpg, gif, webp) are not diffable
  assert.equal(isDiffable("preview.png"), false);
  assert.equal(isDiffable("assets/logo.PNG"), false);
  assert.equal(isDiffable("banner.jpg"), false);
  assert.equal(isDiffable("photo.jpeg"), false);
  assert.equal(isDiffable("animation.gif"), false);
  assert.equal(isDiffable("icon.ico"), false);
  assert.equal(isDiffable("graphic.webp"), false);

  // Other non-diffable binary formats
  assert.equal(isDiffable("bundle.zip"), false);
  assert.equal(isDiffable("archive.tar.gz"), false);
  assert.equal(isDiffable("document.pdf"), false);
  assert.equal(isDiffable("binary.wasm"), false);
  assert.equal(isDiffable("app.exe"), false);
  assert.equal(isDiffable("lib.so"), false);
  assert.equal(isDiffable("font.woff2"), false);
  assert.equal(isDiffable("data.sqlite"), false);

  // Text / code files are diffable
  assert.equal(isDiffable("mods/git-graph/main.js"), true);
  assert.equal(isDiffable("README.md"), true);
  assert.equal(isDiffable("package.json"), true);
  assert.equal(isDiffable("index.html"), true);
  assert.equal(isDiffable("style.css"), true);
  assert.equal(isDiffable("icon.svg"), true);
  assert.equal(isDiffable("Makefile"), true);
  assert.equal(isDiffable(".gitignore"), true);

  // Objects with binary flag
  assert.equal(isDiffable({ path: "custom.bin", binary: true }), false);
  assert.equal(isDiffable({ path: "file.txt", binary: true }), false);
  assert.equal(isDiffable({ path: "file.txt", binary: false }), true);
  assert.equal(isDiffable({ path: "image.png", binary: false }), false);
  assert.equal(isDiffable({ path: "file.txt", file: { binary: true } }), false);
  assert.equal(isDiffable({ path: "file.txt", file: { binary: false } }), true);

  // Extra metadata parameter
  assert.equal(isDiffable("unknown-file", { binary: true }), false);
  assert.equal(isDiffable("unknown-file", { binary: false }), true);
  assert.equal(isDiffable("unknown-file", { file: { binary: true } }), false);

  // Empty or invalid input
  assert.equal(isDiffable(""), false);
  assert.equal(isDiffable(null), false);
  assert.equal(isDiffable(undefined), false);

  // NON_DIFFABLE_EXTENSIONS contains png
  assert.ok(NON_DIFFABLE_EXTENSIONS.has("png"));
});

test("isBinaryDiff: identifies true binary diffs without false-positives on source files containing binary keywords", () => {
  // Genuine binary diff headers
  assert.equal(
    isBinaryDiff("diff --git a/preview.png b/preview.png\nindex 44d4a9a..0c7c546 100644\nBinary files a/preview.png and b/preview.png differ\n"),
    true
  );
  assert.equal(
    isBinaryDiff("diff --git a/icon.ico b/icon.ico\nnew file mode 100644\nBinary files /dev/null and b/icon.ico differ\n"),
    true
  );
  assert.equal(
    isBinaryDiff("diff --git a/old.bin b/old.bin\ndeleted file mode 100644\nBinary files a/old.bin and /dev/null differ\n"),
    true
  );
  assert.equal(
    isBinaryDiff("diff --git a/app.wasm b/app.wasm\nGIT binary patch\nliteral 1234\n"),
    true
  );
  assert.equal(
    isBinaryDiff("Binary files a/data.bin and b/data.bin differ"),
    true
  );
  assert.equal(
    isBinaryDiff("some text with null \0 byte"),
    true
  );

  // Crucial test: A source code file (like main.js) that modifies/adds lines
  // referencing 'Binary files ' or 'GIT binary patch' MUST NOT be classified as binary!
  const jsDiff = [
    "diff --git a/mods/git-graph/main.js b/mods/git-graph/main.js",
    "index 167c69a..d71c5dc 100644",
    "--- a/mods/git-graph/main.js",
    "+++ b/mods/git-graph/main.js",
    "@@ -664,6 +664,9 @@ export default class GitGraph extends View {",
    '+      if (r.stdout.includes("Binary files ") || r.stdout.includes("GIT binary patch") || r.stdout.includes("\\0")) {',
    '+        return "Binary file · cannot be diffed";',
    "+      }",
  ].join("\n");
  assert.equal(isBinaryDiff(jsDiff), false);

  // Normal text diffs
  const normalDiff = [
    "diff --git a/README.md b/README.md",
    "index 111..222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -10,3 +10,3 @@",
    "-old line",
    "+new line",
  ].join("\n");
  assert.equal(isBinaryDiff(normalDiff), false);

  // Edge cases: empty, null, undefined
  assert.equal(isBinaryDiff(""), false);
  assert.equal(isBinaryDiff(null), false);
  assert.equal(isBinaryDiff(undefined), false);
});

test("parseTreeAgentSession: parses session data for outcomes, errors, and justifications", () => {
  // Empty and malformed
  assert.deepEqual(parseTreeAgentSession(null), {
    error: null,
    outcome: null,
    lastText: "",
    intentionallySkipped: false,
    justification: "",
  });
  assert.deepEqual(parseTreeAgentSession({}), {
    error: null,
    outcome: null,
    lastText: "",
    intentionallySkipped: false,
    justification: "",
  });
  assert.deepEqual(parseTreeAgentSession([]), {
    error: null,
    outcome: null,
    lastText: "",
    intentionallySkipped: false,
    justification: "",
  });

  // Successful skip with justification
  const skipSession = {
    data: [
      { type: "user", content: [{ type: "text", text: "Clean the tree" }] },
      {
        type: "assistant",
        content: [
          {
            type: "text",
            text: "There is nothing to commit. The remaining files (docs/cloud-backup-plan.md and .env) are user-owned untracked files according to AGENTS.md.",
          },
        ],
      },
      { type: "idle", outcome: "succeeded" },
    ],
  };
  const skipResult = parseTreeAgentSession(skipSession);
  assert.equal(skipResult.outcome, "succeeded");
  assert.equal(skipResult.error, null);
  assert.equal(skipResult.intentionallySkipped, true);
  assert.equal(
    skipResult.justification,
    "There is nothing to commit. The remaining files (docs/cloud-backup-plan.md and .env) are user-owned untracked files according to AGENTS.md."
  );

  // Session with error
  const errorSession = [
    {
      type: "assistant",
      error: {
        message: "Context length exceeded limit of 128000 tokens",
        type: "rate_limit_error",
      },
    },
    { type: "idle", outcome: "failed" },
  ];
  const errorResult = parseTreeAgentSession(errorSession);
  assert.deepEqual(errorResult.error, {
    errorMessage: "Context length exceeded limit of 128000 tokens",
    errorType: "rate_limit_error",
  });
  assert.equal(errorResult.outcome, "failed");

  // Long text truncation for notification toast
  const longText = "A".repeat(300);
  const longSession = {
    data: [
      {
        type: "assistant",
        content: [{ type: "text", text: longText }],
      },
    ],
  };
  const longResult = parseTreeAgentSession(longSession);
  assert.equal(longResult.justification.length, 248);
  assert.equal(longResult.justification.endsWith("…"), true);
});

test("contextMenuPosition: calculates pane-relative coordinates and flips or clamps within bounds", () => {
  // 1. Standard mouse click with known origin (fits downward-right)
  const pos1 = contextMenuPosition({
    origin: { x: 100, y: 150 },
    bounds: { x: 100, y: 150, width: 800, height: 600 },
    width: 800,
    height: 600,
    event: { position: { x: 350, y: 300 } },
    menuWidth: 260,
    menuHeight: 180,
  });
  assert.deepEqual(pos1, { x: 250, y: 150 });

  // 2. Uses bounds fallback when origin is missing
  const pos2 = contextMenuPosition({
    origin: null,
    bounds: { x: 80, y: 120, width: 600, height: 500 },
    width: 600,
    height: 500,
    event: { position: { x: 200, y: 220 } },
    menuWidth: 240,
    menuHeight: 190,
  });
  assert.deepEqual(pos2, { x: 120, y: 100 });

  // 3. Fallback to defaults when event has no position
  const pos3 = contextMenuPosition({
    origin: { x: 50, y: 50 },
    bounds: null,
    width: 500,
    height: 500,
    event: null,
    menuWidth: 200,
    menuHeight: 150,
    defaultX: 140,
    defaultY: 80,
  });
  assert.deepEqual(pos3, { x: 140, y: 80 });

  // 4. Override takes priority over event position
  const pos4 = contextMenuPosition({
    origin: { x: 100, y: 100 },
    bounds: null,
    width: 800,
    height: 600,
    event: { position: { x: 500, y: 500 } },
    menuWidth: 200,
    menuHeight: 150,
    overrideX: 180,
    overrideY: 90,
  });
  assert.deepEqual(pos4, { x: 180, y: 90 });

  // 5. Flips to the left when right edge overflows and left has space
  const pos5 = contextMenuPosition({
    origin: { x: 100, y: 100 },
    bounds: { x: 100, y: 100, width: 600, height: 500 },
    width: 600,
    height: 500,
    event: { position: { x: 650, y: 200 } }, // x would be 550; 550 + 200 > 600
    menuWidth: 200,
    menuHeight: 150,
  });
  // x flips to x - menuWidth = 550 - 200 = 350
  assert.equal(pos5.x, 350);
  assert.equal(pos5.y, 100);

  // 6. Flips upwards when bottom edge overflows and top has space
  const pos6 = contextMenuPosition({
    origin: { x: 100, y: 100 },
    bounds: { x: 100, y: 100, width: 600, height: 500 },
    width: 600,
    height: 500,
    event: { position: { x: 250, y: 550 } }, // y would be 450; 450 + 150 > 500
    menuWidth: 200,
    menuHeight: 150,
  });
  assert.equal(pos6.x, 150);
  // y flips upwards to y - menuHeight = 450 - 150 = 300
  assert.equal(pos6.y, 300);

  // 7. Clamps when neither right nor left has enough space
  const pos7 = contextMenuPosition({
    origin: { x: 0, y: 0 },
    bounds: null,
    width: 300,
    height: 400,
    event: { position: { x: 180, y: 50 } }, // x = 180; 180 + 250 > 300; 180 - 250 = -70 < 10
    menuWidth: 250,
    menuHeight: 100,
  });
  // maxW - menuWidth - 10 = 300 - 250 - 10 = 40
  assert.equal(pos7.x, 40);
  assert.equal(pos7.y, 50);

  // 8. Clamps when neither bottom nor top has enough space
  const pos8 = contextMenuPosition({
    origin: { x: 0, y: 0 },
    bounds: null,
    width: 400,
    height: 250,
    event: { position: { x: 50, y: 150 } }, // y = 150; 150 + 200 > 250; 150 - 200 = -50 < 10
    menuWidth: 150,
    menuHeight: 200,
  });
  assert.equal(pos8.x, 50);
  // maxH - menuHeight - 10 = 250 - 200 - 10 = 40
  assert.equal(pos8.y, 40);

  // 9. When origin is known with window coordinates, correctly subtracts origin
  const pos9 = contextMenuPosition({
    origin: { x: 1352, y: 110 },
    bounds: null,
    width: 368,
    height: 400,
    event: {
      position: { x: 1450, y: 242 },
      bounds: { x: 1352, y: 230, width: 368, height: 24 },
    },
    menuWidth: 260,
    menuHeight: 135,
  });
  // x = 1450 - 1352 = 98 (fits <= 368)
  // y = 242 - 110 = 132 (132 + 135 = 267 <= 400)
  assert.equal(pos9.x, 98);
  assert.equal(pos9.y, 132);

  // 10. Guards against window-space leakage when origin is unknown and event.position exceeds height
  const pos10 = contextMenuPosition({
    origin: null,
    bounds: null,
    width: 368,
    height: 400,
    event: {
      position: { x: 1450, y: 850 },
      local_position: { x: 50, y: 12 },
    },
    menuWidth: 260,
    menuHeight: 135,
    defaultY: 100,
  });
  assert.equal(pos10.y, 12);

  // 11. Scales coordinates correctly with zoom: 1.1
  const pos11 = contextMenuPosition({
    origin: { x: 1000, y: 100 },
    bounds: null,
    width: 800,
    height: 600,
    zoom: 1.1,
    event: { position: { x: 1220, y: 320 } },
    menuWidth: 260,
    menuHeight: 180,
  });
  // (1220 - 1000) / 1.1 = 200, (320 - 100) / 1.1 = 200
  assert.deepEqual(pos11, { x: 200, y: 200 });

  // 12. Derives maxW and maxH from bounds scaled by zoom when width/height are 0
  const pos12 = contextMenuPosition({
    origin: { x: 100, y: 100 },
    bounds: { x: 100, y: 100, width: 880, height: 660 },
    width: 0,
    height: 0,
    zoom: 1.1,
    event: { position: { x: 320, y: 320 } },
    menuWidth: 200,
    menuHeight: 150,
  });
  // maxW = 880 / 1.1 = 800, maxH = 660 / 1.1 = 600
  // x = (320 - 100) / 1.1 = 200, y = (320 - 100) / 1.1 = 200
  assert.deepEqual(pos12, { x: 200, y: 200 });

  // 13. Edge-margin flipping at 10px boundary (horizontal)
  const pos13 = contextMenuPosition({
    origin: { x: 0, y: 0 },
    bounds: null,
    width: 600,
    height: 500,
    event: { position: { x: 395, y: 100 } },
    menuWidth: 200,
    menuHeight: 150,
  });
  // 395 + 200 = 595 > 600 - 10 (590) -> flips left to 395 - 200 = 195
  assert.equal(pos13.x, 195);
  assert.equal(pos13.y, 100);

  // 14. Edge-margin flipping at 10px boundary (vertical)
  const pos14 = contextMenuPosition({
    origin: { x: 0, y: 0 },
    bounds: null,
    width: 600,
    height: 500,
    event: { position: { x: 100, y: 345 } },
    menuWidth: 200,
    menuHeight: 150,
  });
  // 345 + 150 = 495 > 500 - 10 (490) -> flips upwards to 345 - 150 = 195
  assert.equal(pos14.x, 100);
  assert.equal(pos14.y, 195);

  // 15. Fallback: paneX falls back to event.bounds.x when origin is missing
  const pos15 = contextMenuPosition({
    origin: null,
    bounds: null,
    width: 400,
    height: 400,
    zoom: 1.1,
    event: {
      position: { x: 1450, y: 242 },
      bounds: { x: 1352, y: 230, width: 368, height: 24 },
      local_position: { x: 50, y: 12 },
    },
    menuWidth: 200,
    menuHeight: 100,
  });
  // paneX = 1352, x = Math.round((1450 - 1352) / 1.1) = Math.round(98 / 1.1) = 89
  assert.equal(pos15.x, 89);

  // 16. Window-space leakage guard scales local_position by zoom
  const pos16 = contextMenuPosition({
    origin: null,
    bounds: null,
    width: 400,
    height: 400,
    zoom: 1.1,
    event: {
      position: { x: 1450, y: 850 },
      local_position: { x: 55, y: 33 },
    },
    menuWidth: 200,
    menuHeight: 100,
    defaultY: 100,
  });
  // y leaks (850 > 400), local_position.y / 1.1 = 33 / 1.1 = 30
  assert.equal(pos16.y, 30);
});
