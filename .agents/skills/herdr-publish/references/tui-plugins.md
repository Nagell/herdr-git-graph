# Herdr TUI plugins

TUI plugins are directories with `herdr-plugin.toml` and runnable commands. They extend the Herdr TUI (actions, panes, startup hooks, events, link handlers) and are installed with `herdr plugin install`. This is a different surface from Herdr **app mods**.

Official reference: <https://herdr.dev/tui/docs/plugins/>

## Manifest

```toml
id = "example.workspace-tools"
name = "Workspace Tools"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Small workspace helpers"
platforms = ["linux", "macos", "windows"]

[[build]]
command = ["npm", "ci"]

[[startup]]
command = ["node", "dist/restore.js"]

[[actions]]
id = "list-workspaces"
title = "List workspaces"
contexts = ["workspace"]
command = ["node", "index.js"]

[[events]]
on = "worktree.created"
command = ["herdr", "workspace", "list"]

[[panes]]
id = "board"
title = "Project board"
placement = "overlay"
command = ["herdr-board"]

[[link_handlers]]
id = "github-issue"
title = "Open GitHub issue"
pattern = "^https://github\\.com/[^/]+/[^/]+/(issues|pull)/[0-9]+$"
action = "list-workspaces"

[[keys.command]]
key = "prefix+l"
type = "plugin_action"
command = "example.workspace-tools.list-workspaces"
description = "list workspaces"
```

### Required metadata

`id`, `name`, `version`, `min_herdr_version`.

- `id`: ASCII letters, digits, dot, colon, underscore, hyphen.
- `min_herdr_version`: the oldest Herdr that supports every API and manifest field you use. Herdr refuses to link/install when its minimum is newer than the running binary.
- `description`: optional but recommended.
- `platforms`: declare `linux`, `macos`, `windows`; local plugins without it link with a warning.

### Commands

- `command` is an argv array. It is **not** run through a shell.
- Use `["sh", "-c", "..."]` for shell syntax.
- Action, pane, and link-handler ids are local; action ids may not contain dots.
- Action ids are globally qualified as `<plugin-id>.<action-id>`.
- `contexts` limits where an action appears (for example `["workspace"]`).

### Build, startup, panes, keys, links

- `[[build]]`: runs during GitHub `plugin install`, after confirmation, before registration. `plugin link` does not run builds. Build failures abort install. Document required toolchains.
- `[[startup]]`: one-shot hook after session restore and socket readiness. It runs again on live handoff, not on client attach or config reload. It is not a supervised daemon; exit when done.
- `[[panes]]`: `placement` defaults to `overlay`; also `popup`, `split`, `tab`, `zoomed`. Popups accept `width`/`height` (cells or strings like `"80%"`). A popup is a session singleton, not a normal pane.
- `[[keys.command]]`: binds a key to a plugin action.
- `[[link_handlers]]`: routes modified (Ctrl) clicks on matching terminal URLs to an action; `pattern` is a Rust regex; `action` must be declared by the same plugin.

## Runtime environment

Runtime commands run with the plugin directory as their working directory and receive:

- `HERDR_BIN_PATH` — the running Herdr binary. Prefer this for CLI calls; it is portable across Unix sockets and Windows named pipes.
- `HERDR_SOCKET_PATH` — raw socket/named pipe path.
- `HERDR_ENV=1`.
- `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`.
- `HERDR_PLUGIN_CONTEXT_JSON` — workspace, tab, focused pane, worktree, agent, selected text, clicked URL, and link-handler fields when available.
- `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`.
- Action commands: `HERDR_PLUGIN_ACTION_ID`.
- Startup/event hooks: `HERDR_PLUGIN_EVENT`; event hooks also get `HERDR_PLUGIN_EVENT_JSON`.
- Pane commands: `HERDR_PLUGIN_ENTRYPOINT_ID`.

`HERDR_PLUGIN_ROOT` is the installed/linked source checkout. Do not store user credentials or durable state there. Put config in `HERDR_PLUGIN_CONFIG_DIR` and runtime state in `HERDR_PLUGIN_STATE_DIR`.

## Calling Herdr

Use `HERDR_BIN_PATH` from Node, Bash, Python, PowerShell, or any runtime:

```js
const { spawnSync } = require("node:child_process");
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const result = spawnSync(herdr, ["workspace", "list"], { encoding: "utf8" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
```

The full Herdr CLI is the plugin API. Use the CLI reference for commands and the socket API for raw JSON requests when needed.

## Local development

```sh
herdr plugin link .                 # link the working directory
herdr plugin list
herdr plugin config-dir <plugin-id>
herdr plugin action list --plugin <plugin-id>
herdr plugin action invoke <plugin-id>.<action-id>
herdr plugin pane open --plugin <plugin-id> --entrypoint <pane-id>
herdr plugin log list --plugin <plugin-id>
herdr plugin unlink <plugin-id>
```

- `plugin link` registers a local working tree and does not run builds.
- `plugin install`/`plugin update` are for GitHub sources; `plugin install` shows a preview in interactive terminals. Use `--yes` for trusted sources and `--ref` to pin.
- Installed/linked plugins are global to the user and available in every Herdr session.
- If the repo has multiple manifests, link each plugin directory separately.

## Marketplace

Public GitHub repositories tagged `herdr-plugin` with at least one parseable `herdr-plugin.toml` on the default branch are indexed at `herdr.dev/plugins`.

- One card per repository; each manifest is a separately installable plugin.
- Manifests may be at the root or in subdirectories.
- The index refreshes every 30 minutes and rescans on default-branch head changes.
- Forks, archived repos, repos without a valid manifest, and malformed metadata are excluded.
- Install with `herdr plugin install owner/repo[/subdir]`.
- The catalog is automatic and unreviewed; apply the trust guidance before installing third-party code.

## Checklist

- [ ] Each manifest has `id`, `name`, `version`, `min_herdr_version`, and `platforms`.
- [ ] `herdr plugin link <dir>` succeeds for each manifest.
- [ ] Actions/panes run; `herdr plugin log list` has no relevant errors.
- [ ] `README.md` documents requirements and the exact install command.
- [ ] The repo is public, default branch, not archived/forked.
- [ ] Topic `herdr-plugin` is set.
- [ ] `herdr plugin install owner/repo[/subdir]` works from a clean state.
- [ ] `version` is bumped for the release.
