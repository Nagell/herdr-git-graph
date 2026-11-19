import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// syntax.js is a byte-for-byte copy of herdr-mods' lexer. With a herdr-mods checkout
// around ($HERDR_MODS or ~/.local/src/herdr-mods), a stale copy fails here: run
// ./sync-shared.sh. Without one, there is nothing to compare against.
const mods = process.env.HERDR_MODS || join(homedir(), ".local/src/herdr-mods");
const upstream = join(mods, "better-files/mods/better-files/syntax.js");
const ours = fileURLToPath(new URL("../mods/git-graph/syntax.js", import.meta.url));

test("syntax.js matches herdr-mods' lexer", { skip: !existsSync(upstream) && `no herdr-mods checkout at ${mods}` }, () => {
  assert.ok(readFileSync(ours).equals(readFileSync(upstream)), `syntax.js differs from ${upstream}: run ./sync-shared.sh`);
});
