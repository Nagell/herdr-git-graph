import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRefs,
  logArgs,
  tagArgs,
  computeLanes,
  buildDiffView,
  intraLineDiff,
  diffRows,
  lineSegments,
} from "../mods/git-graph/git-logic.js";

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
