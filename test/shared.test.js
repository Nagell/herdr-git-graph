import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// syntax.js and file-icons.js are byte-for-byte copies from herdr-mods. With a herdr-mods
// checkout around ($HERDR_MODS or ~/.local/src/herdr-mods), a stale copy fails here: run
// ./sync-shared.sh. Without one, there is nothing to compare against.
const mods = process.env.HERDR_MODS || join(homedir(), ".local/src/herdr-mods");

for (const [ours, theirs] of [
  ["syntax.js", "better-files/mods/better-files/syntax.js"],
  ["file-icons.js", "better-icons/mods/better-icons/file-icons.js"],
]) {
  const upstream = join(mods, theirs);
  const local = fileURLToPath(new URL(`../mods/git-graph/${ours}`, import.meta.url));
  test(`${ours} matches herdr-mods' copy`, { skip: !existsSync(upstream) && `no herdr-mods checkout at ${mods}` }, () => {
    assert.ok(readFileSync(local).equals(readFileSync(upstream)), `${ours} differs from ${upstream}: run ./sync-shared.sh`);
  });
}
