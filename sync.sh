#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
live="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
mod="git-graph"
src="$root/mods/$mod"

if [ ! -d "$src" ]; then
  echo "missing $src" >&2
  exit 1
fi

mkdir -p "$live/$mod"
rsync -a --delete \
  --exclude 'gpui-kit.d.ts' \
  --exclude 'jsconfig.json' \
  --exclude '.cache-*' \
  --exclude '__pycache__' \
  "$src/" "$live/$mod/"
herdr-app check "$live/$mod"

echo "Synced: $mod -> $live"
