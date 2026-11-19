#!/usr/bin/env bash
# Copy the files Git Graph shares with herdr-mods (munza/herdr-mods) into mods/git-graph.
# They are kept byte for byte; edit them in herdr-mods, never here.
#   syntax.js      the lexer Better Files and Better Changes share
#   file-icons.js  Better Icons' resolver (the icons themselves stay in Better Icons)
# Usage: ./sync-shared.sh [path to a herdr-mods checkout]  (default: $HERDR_MODS or ~/.local/src/herdr-mods)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mods="${1:-${HERDR_MODS:-$HOME/.local/src/herdr-mods}}"
rev="$(git -C "$mods" rev-parse --short HEAD 2>/dev/null || echo unknown)"

sync() {
  local src="$mods/$1" dest="$root/mods/git-graph/$2"
  if [ ! -f "$src" ]; then
    echo "no herdr-mods checkout at $mods (missing $src)" >&2
    exit 1
  fi
  if cmp -s "$src" "$dest"; then
    echo "$2 already matches $mods"
  else
    cp "$src" "$dest"
    echo "$2 updated from $mods ($rev)"
  fi
}

sync better-files/mods/better-files/syntax.js syntax.js
sync better-icons/mods/better-icons/file-icons.js file-icons.js
