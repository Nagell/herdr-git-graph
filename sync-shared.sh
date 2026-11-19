#!/usr/bin/env bash
# Copy the files Git Graph shares with herdr-mods (munza/herdr-mods) into mods/git-graph.
# They are kept byte for byte; edit them in herdr-mods, never here.
# Usage: ./sync-shared.sh [path to a herdr-mods checkout]  (default: $HERDR_MODS or ~/.local/src/herdr-mods)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mods="${1:-${HERDR_MODS:-$HOME/.local/src/herdr-mods}}"
src="$mods/better-files/mods/better-files/syntax.js"

if [ ! -f "$src" ]; then
  echo "no herdr-mods checkout at $mods (missing $src)" >&2
  exit 1
fi

dest="$root/mods/git-graph/syntax.js"
if cmp -s "$src" "$dest"; then
  echo "syntax.js already matches $mods"
else
  cp "$src" "$dest"
  echo "syntax.js updated from $mods ($(git -C "$mods" rev-parse --short HEAD 2>/dev/null || echo unknown))"
fi
