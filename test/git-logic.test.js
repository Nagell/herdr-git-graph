import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEffectiveRoot,
  isLayoutNodeVisible,
  parseRefs,
  resolveDisplayRefs,
  parseCommitLog,
  logArgs,
  tagArgs,
  computeLanes,
  buildDiffView,
  intraLineDiff,
  diffRows,
  lineSegments,
  wrapInlineRows,
  wrapSplitRows,
  isFreeModel,
  isLightColor,
  cleanModelLabel,
  resolveCleanAgentModelLogic,
  filterVisibleCleanModels,
  splitRemoteBranch,
  deleteRemoteBranchArgs,
  OPENCODE_INSTALL_CMD,
  OPENCODE_DOCS_URL,
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
