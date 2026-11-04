#!/usr/bin/env bash
# Preflight for a Herdr extension repo: app mods and/or TUI plugins.
# Read-only for git; links local TUI plugins in Herdr so they can be tested.
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root"

if [ -t 1 ]; then
  bold="$(printf '\033[1m')"; dim="$(printf '\033[2m')"; reset="$(printf '\033[0m')"
else
  bold=""; dim=""; reset=""
fi

say() { printf '%s%s%s\n' "$bold" "$*" "$reset"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

app_mods=()
while IFS= read -r -d '' file; do
  app_mods+=("$(dirname "$file")")
done < <(find mods -maxdepth 2 -name main.js -print0 2>/dev/null || true)

plugin_manifests=()
while IFS= read -r -d '' file; do
  plugin_manifests+=("$file")
done < <(find . -name herdr-plugin.toml -not -path './.git/*' -print0 2>/dev/null || true)

if [ ${#app_mods[@]} -eq 0 ] && [ ${#plugin_manifests[@]} -eq 0 ]; then
  warn "no Herdr app mods (mods/*/main.js) or TUI plugins (herdr-plugin.toml) found"
  exit 1
fi

say "Herdr extension preflight"
echo "root: $root"

if [ ${#app_mods[@]} -gt 0 ]; then
  say "App mods"
  [ -f README.md ] || warn "app-mod repo is missing README.md"
  [ -f RECIPE.md ] || warn "app-mod repo is missing RECIPE.md"
  [ -f preview.png ] || warn "app-mod repo is missing preview.png"
  if [ -d layouts ]; then
    warn "app-mod repo has a layouts/ folder; a mod repo should not ship layouts/"
  fi
  if [ -f keys.json ]; then
    if python3 -m json.tool keys.json >/dev/null 2>&1; then
      echo "  keys.json: valid"
    else
      warn "keys.json is not valid JSON"
    fi
  fi
  for mod in "${app_mods[@]}"; do
    echo "  - $mod"
    [ -f "$mod/mod.json" ] || warn "$mod is missing mod.json"
    if herdr-app check "$mod"; then
      echo "    ok"
    else
      warn "herdr-app check failed for $mod"
    fi
  done
fi

if [ ${#plugin_manifests[@]} -gt 0 ]; then
  say "TUI plugins"
  [ -f README.md ] || warn "TUI plugin repo is missing README.md"
  for manifest in "${plugin_manifests[@]}"; do
    dir="$(dirname "$manifest")"
    echo "  - $manifest"
    if ! herdr plugin link "$dir"; then
      warn "herdr plugin link failed for $dir"
      continue
    fi
    id="$(python3 - "$manifest" <<'PY'
import sys
path = sys.argv[1]
try:
    import tomllib
except ImportError:
    tomllib = None
if tomllib:
    with open(path, "rb") as handle:
        print(tomllib.load(handle).get("id", ""))
else:
    for line in open(path, encoding="utf-8"):
        key, _, value = line.partition("=")
        if key.strip() == "id":
            print(value.strip().strip('"').strip("'"))
            break
PY
)"
    if [ -z "$id" ]; then
      warn "could not read id from $manifest"
      continue
    fi
    echo "    id: $id"
    python3 - "$manifest" <<'PY'
import re, sys

path = sys.argv[1]
try:
    import tomllib
except ImportError:
    print("    WARN: python3 has no tomllib; skipped manifest metadata checks", file=sys.stderr)
    raise SystemExit(0)

with open(path, "rb") as handle:
    data = tomllib.load(handle)

def warn(message):
    print(f"    WARN: {message}", file=sys.stderr)

required = ("id", "name", "version", "min_herdr_version")
missing = [key for key in required if not str(data.get(key, "")).strip()]
if missing:
    warn("missing required metadata: " + ", ".join(missing))
if not data.get("platforms"):
    warn("missing top-level platforms")

plugin_id = str(data.get("id", ""))
if plugin_id and not re.fullmatch(r"[A-Za-z0-9._:-]+", plugin_id):
    warn("plugin id contains unsupported characters: " + plugin_id)

local_id = re.compile(r"[A-Za-z0-9:_-]+")
for section in ("actions", "panes", "link_handlers"):
    seen = set()
    for item in data.get(section, []) or []:
        item_id = str(item.get("id", ""))
        if not item_id:
            warn(f"{section} entry is missing id")
            continue
        if not local_id.fullmatch(item_id):
            warn(f"{section} id may not contain dots: {item_id}")
        if item_id in seen:
            warn(f"duplicate {section} id: {item_id}")
        seen.add(item_id)

actions = {str(item.get("id", "")) for item in data.get("actions", []) or []}
for item in data.get("link_handlers", []) or []:
    action = str(item.get("action", ""))
    if action and action not in actions:
        warn(f"link handler action is not declared by this plugin: {action}")

for section in ("build", "startup", "actions", "events", "panes", "link_handlers"):
    for item in data.get(section, []) or []:
        command = item.get("command")
        if command is not None and (
            not isinstance(command, list)
            or not command
            or not all(isinstance(part, str) for part in command)
        ):
            warn(f"{section} command must be a non-empty argv array")
PY
    herdr plugin action list --plugin "$id" 2>/dev/null || true
    herdr plugin log list --plugin "$id" 2>/dev/null | tail -20 || true
  done
fi

say "Git"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  dirty="$(git status --porcelain)"
  if [ -n "$dirty" ]; then
    warn "working tree is not clean; commit or stash before publishing"
    printf '%s\n' "$dirty"
  else
    echo "  clean"
  fi
else
  warn "not a git repository"
fi

say "GitHub"
has_mods=0; [ ${#app_mods[@]} -gt 0 ] && has_mods=1
has_plugins=0; [ ${#plugin_manifests[@]} -gt 0 ] && has_plugins=1
if command -v gh >/dev/null 2>&1 && gh repo view --json visibility,repositoryTopics,defaultBranchRef,description,isFork,isArchived >/tmp/herdr-preflight-gh.json 2>/dev/null; then
  python3 - "$has_mods" "$has_plugins" <<'PY'
import json, sys
has_mods = sys.argv[1] == "1"
has_plugins = sys.argv[2] == "1"
data = json.load(open("/tmp/herdr-preflight-gh.json"))
topics = [t.get("name") for t in data.get("repositoryTopics") or [] if isinstance(t, dict)]
visibility = data.get("visibility")
branch = (data.get("defaultBranchRef") or {}).get("name")
is_fork = bool(data.get("isFork"))
is_archived = bool(data.get("isArchived"))
print("  visibility:", visibility or "(unknown)")
print("  topics:", ", ".join(topics) if topics else "(none)")
print("  default branch:", branch or "(unknown)")
print("  description:", data.get("description") or "(none)")
print("  fork:", "yes" if is_fork else "no")
print("  archived:", "yes" if is_archived else "no")
if visibility and visibility != "PUBLIC":
    print("  WARN: repository is not public")
if not data.get("description"):
    print("  WARN: repository description is empty; it is shown on the marketplace card")
if has_mods and "herdr-mod" not in topics:
    print("  WARN: app mod repo is missing the GitHub topic herdr-mod")
if has_plugins and "herdr-plugin" not in topics:
    print("  WARN: TUI plugin repo is missing the GitHub topic herdr-plugin")
if has_plugins and is_fork:
    print("  WARN: TUI plugin index skips forked repositories")
if has_plugins and is_archived:
    print("  WARN: TUI plugin index skips archived repositories")
PY
else
  warn "gh repo view failed (no GitHub remote or gh not installed)"
fi

say "Next"
echo "  app mods: ./sync.sh, herdr-app check, herdr-app shot, RECIPE.md, preview.png, topic herdr-mod"
echo "  TUI plugins: herdr plugin action/pane tests, README, topic herdr-plugin"
echo "  full checklists: references/publishing.md"
