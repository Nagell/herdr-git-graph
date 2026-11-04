---
name: herdr-publish
description: Build, validate, sync, and publish Herdr extensions. Use this skill whenever a repository contains `mods/<name>/main.js` + `mod.json` (a Herdr app mod) or `herdr-plugin.toml` (a Herdr TUI plugin); when the task mentions Herdr mods or plugins, status-bar mods, layouts, `herdr-app check`, `herdr-app shot`, `herdr plugin`, `HERDR_BIN_PATH`, `herdr-plugin.toml`, `RECIPE.md`, `preview.png`, `herdr-mod`, `herdr-plugin`, or publishing to herdr.dev/mods or herdr.dev/plugins. Also use it when deciding whether something belongs in `~/.config/herdr-app/mods` or is a TUI plugin.
---

# Herdr extensions

Herdr has two different extension surfaces. Decide which one the repository is before changing files:

| | **App mod** | **TUI plugin** |
|---|---|---|
| What it changes | The Herdr app window: status bar, tabs, panels, layouts | The Herdr TUI: actions, panes, hooks, link handlers |
| Source | `mods/<name>/main.js`, `mod.json`, assets, `layouts/*.json` | `herdr-plugin.toml` + runnable commands |
| Local test | `herdr-app check`, `herdr-app shot`, `herdr-app status` | `herdr plugin link`, `action invoke`, `pane open`, `log list` |
| Marketplace | `herdr.dev/mods`, GitHub topic `herdr-mod` | `herdr.dev/plugins`, GitHub topic `herdr-plugin` |

If the repo contains both, handle each separately. Do not describe an app mod as a TUI plugin or vice versa.

## App mods

### Repo shape

```
repo/
├── AGENTS.md
├── README.md
├── RECIPE.md
├── preview.png
├── sync.sh
├── .gitignore
└── mods/
    └── <name>/
        ├── main.js
        ├── mod.json
        └── assets...
```

A feature that genuinely needs more than one mod may keep them in one repo (for example `ref-menu` + `tabs-ref`); document that they are installed together.

### Local loop

The repo is the source of truth. Herdr reads the live copy at `~/.config/herdr-app/mods/<name>`.

```sh
./sync.sh                    # copies each mod to the live folder and runs herdr-app check
herdr-app check mods/<name>  # or check the live copy directly
herdr-app shot /tmp/preview.png
herdr-app status             # layouts, overlays, errors
```

- Never edit the live folder directly; edit the repo and sync.
- Never edit a shipped mod or layout: Herdr restores them on restart. Clone first:
  `herdr-app do mod.clone --name workspace-status --as usage-status`
  `herdr-app do layout.clone --name main --as my-layout`
- Layout wiring lives in a personal layout clone. Common blocks:
  - status bar: `{ "id": "status", "content": { "mod": "usage-status" }, "size": { "px": 28 } }`
  - tab bar: `{ "id": "tabs", "content": { "mod": "tabs-ref" } }`
  - terminal right-click: root `"terminal_menu": "ref-menu"`
- Generated files (`gpui-kit.d.ts`, `jsconfig.json`, `.cache-*.json`, `__pycache__/`) are local; keep them in `.gitignore`.

### Publish to herdr.dev/mods

The app-mod index lists public GitHub repositories tagged `herdr-mod` that contain `mods/<name>/` plus a `RECIPE.md` and `preview.png`. It refreshes within about an hour.

Checklist:

1. Public GitHub repo, default branch.
2. `mods/<name>/` at the repo root; keep the folder name stable because `main.js` references `mods/<name>/...` assets.
3. `README.md` with what it does, requirements, install/sync, and the layout wiring.
4. `RECIPE.md` in the Herdr format: what you see, how it behaves, built from, watch out, done when.
5. `preview.png` — a real screenshot of the mod in Herdr (crop the window with `herdr-app shot` if needed).
6. Topic:
   ```sh
   gh repo edit --add-topic herdr-mod
   ```
7. Verify:
   ```sh
   gh repo view --json visibility,repositoryTopics,defaultBranchRef
   ```
8. Wait for `herdr.dev/mods` to index it; then share the repo and the install steps.

## TUI plugins

### Manifest minimum

```toml
id = "example.workspace-tools"
name = "Workspace Tools"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Small workspace helpers"
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "list-workspaces"
title = "List workspaces"
contexts = ["workspace"]
command = ["node", "index.js"]
```

- Required: `id`, `name`, `version`, `min_herdr_version`. Add `description` and `platforms`.
- `command` is an argv array; it does not go through a shell. Use `["sh", "-c", "..."]` when shell syntax is needed.
- Action, pane, and link-handler ids are local; action ids may not contain dots.
- `min_herdr_version` is the oldest Herdr that supports the APIs you use.
- `[[build]]` runs during GitHub install, not local `plugin link`.
- `[[startup]]` is a one-shot hook, not a daemon.
- `[[panes]]` placement defaults to `overlay`; also `popup`, `split`, `tab`, `zoomed`.
- `[[events]]`, `[[link_handlers]]`, and `[[keys.command]]` are declared in the manifest.

See `references/tui-plugins.md` for the full manifest and environment reference.

### Local loop

```sh
herdr plugin link .                 # link the working tree; does not run builds
herdr plugin list
herdr plugin config-dir <plugin-id>
herdr plugin action list --plugin <plugin-id>
herdr plugin action invoke <plugin-id>.<action-id>
herdr plugin pane open --plugin <plugin-id> --entrypoint <pane-id>
herdr plugin log list --plugin <plugin-id>
herdr plugin unlink <plugin-id>
```

If the repo has manifests in subdirectories, link each plugin directory separately. `plugin link` works even when no Herdr server is running.

Inside runtime commands, call Herdr through `HERDR_BIN_PATH` (portable across Unix sockets and Windows named pipes), not a hard-coded socket path:

```js
const { spawnSync } = require("node:child_process");
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const result = spawnSync(herdr, ["workspace", "list"], { encoding: "utf8" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
```

Use `HERDR_PLUGIN_CONFIG_DIR` for user config and `HERDR_PLUGIN_STATE_DIR` for runtime state. Do not store credentials or durable state in `HERDR_PLUGIN_ROOT` (it is a managed checkout). See `references/tui-plugins.md` for the full environment list.

### Publish to herdr.dev/plugins

The TUI marketplace indexes public GitHub repositories tagged `herdr-plugin` that contain at least one parseable `herdr-plugin.toml` on the default branch. One repository card can list multiple separately installable plugins.

Checklist:

1. Public, non-archived, non-fork repository.
2. `herdr-plugin.toml` at the root or in a subdirectory of the default branch.
3. Required metadata parses: `id`, `name`, `version`, `min_herdr_version`. Add `platforms`.
4. Bump `version` for the release.
5. `README.md` with what it does, requirements, manifest path, and install command.
6. Topic:
   ```sh
   gh repo edit --add-topic herdr-plugin
   ```
7. Verify:
   ```sh
   gh repo view --json visibility,repositoryTopics,defaultBranchRef
   ```
8. Test the exact install path:
   ```sh
   herdr plugin install owner/repo[/subdir]
   ```
9. The index refreshes every 30 minutes and rescans when the default branch head changes. Check `herdr.dev/plugins`.

## Preflight

Run the bundled script from the repo root:

```sh
.agents/skills/herdr-publish/scripts/preflight.sh
```

It detects app mods and TUI plugins, runs the local checks it can, and prints GitHub visibility/topic/default-branch metadata when `gh` is available. Fix the warnings before publishing.

For an app-mod repo it runs `herdr-app check` on each `mods/<name>`; for a TUI plugin repo it links each manifest and lists actions/logs. It never commits or pushes.

## Common mistakes

- Assuming `command` goes through a shell: it is an argv array.
- Storing state or secrets in `HERDR_PLUGIN_ROOT`: use the config/state dirs.
- Setting `min_herdr_version` too high: Herdr refuses to link or install.
- Forgetting `platforms`: local links warn.
- Linking the repo root when the manifest is in a subdirectory: link the subdirectory.
- Publishing a private, archived, or forked repo: the index skips it.
- Confusing an app mod (`mods/<name>/main.js`) with a TUI plugin (`herdr-plugin.toml`).
- Publishing an app mod with the `herdr-plugin` topic, or a TUI plugin with `herdr-mod`: the wrong index will ignore it.

## References

- `references/app-mods.md` — app mod structure, layout wiring, sync/check, RECIPE, preview, herdr.dev/mods.
- `references/tui-plugins.md` — full manifest, commands, environment, panes, hooks, link handlers.
- `references/publishing.md` — both marketplaces, discovery rules, GitHub commands, release checklist.
- `scripts/preflight.sh` — local checks plus GitHub metadata.
- Official docs: <https://herdr.dev/tui/docs/plugins/>, <https://herdr.dev/tui/docs/marketplace/>, <https://herdr.dev/tui/docs/agent-skill/>.
