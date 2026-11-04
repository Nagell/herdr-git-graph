# Herdr TUI plugins

TUI plugins are directories with `herdr-plugin.toml` and runnable commands. They extend the Herdr TUI (actions, panes, startup hooks, events, link handlers) and are installed with `herdr plugin install`. This is a different surface from Herdr **app mods**.

Official references:

- <https://herdr.dev/tui/docs/plugins/>
- <https://herdr.dev/tui/docs/marketplace/>
- <https://herdr.dev/tui/docs/cli-reference/>
- <https://herdr.dev/tui/docs/socket-api/>

## Trust and security

A plugin is ordinary code, not a sandboxed extension. Its build and runtime commands run as your user, inherit your environment, and can call the full Herdr CLI. Install or link only from authors and repositories you trust. Before installing, skim the manifest and the scripts or binaries it runs.

- `herdr plugin install` shows a preview of the source and commands in interactive terminals.
- `--yes` skips the preview for sources you already trust; `--ref` pins a specific revision.
- `plugin install` accepts GitHub shorthand only: `owner/repo[/subdir...]`.
- The marketplace is an automatic, unreviewed index. A listing is not a security review.

## Manifest

Plugin v1 has no runtime action registration and no native non-terminal plugin UI; actions, events, panes, and link handlers are all declared in the manifest. A plugin can be any runnable argv command: Bash, JavaScript, Python, Lua, Rust, Go, or any other program available on the user's machine.

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
- `name`, `version`: shown in the marketplace listing; bump `version` for a release.
- `min_herdr_version`: the oldest Herdr that supports every API, event name, and manifest field you use. Herdr refuses to link or install when its minimum is newer than the running binary.
- `description`: optional but recommended.
- `platforms`: declare `linux`, `macos`, `windows`. Local plugins without it link with a warning. Item-level `platforms` on build, startup, action, event, pane, and link-handler entries override the top-level list.

### Commands

- `command` is an argv array. It is **not** run through a shell.
- Use `["sh", "-c", "..."]` for shell syntax.
- Action, pane, and link-handler ids are local. They may use ASCII letters, digits, colon, underscore, and hyphen, but **not dots**, and must be unique within their type.
- Action ids are globally qualified as `<plugin-id>.<action-id>`.
- `contexts` limits where an action appears (for example `["workspace"]`).
- On Windows, build, action, and event commands resolve common `PATHEXT` shims such as `npm.cmd`, `bun.cmd`, and `pnpm.cmd` when the bare command is on `PATH`. Pane commands use Herdr's normal Windows pane launcher and must still be valid Windows argv commands.

### Build commands

- `[[build]]` commands run during GitHub `plugin install`, after confirmation and before Herdr registers the plugin.
- A build failure aborts install and leaves the plugin unregistered. The error shows the plugin id, build index, working directory, command, exit status or spawn error, and capped stdout/stderr.
- `plugin link` does not run builds; local authors build their working tree themselves.
- Build commands do not receive runtime plugin context or Herdr socket env.
- Changing `herdr-plugin.toml` after the install preview aborts install.
- Document required toolchains such as `cargo`, `npm`, `bun`, or `lua`; Herdr reports failures but does not install missing tools.

### Startup hooks

- `[[startup]]` commands run once for each enabled plugin after Herdr restores the session and its API socket is ready.
- They run again when a new server takes over during live handoff, but not when a client attaches, config reloads, or a plugin is linked or enabled.
- Herdr starts them asynchronously and records completion in the plugin command log. A startup failure does not stop the server.
- A startup hook is one-shot initialization, not a supervised daemon. Restore state, call the required APIs, and exit.
- Startup hooks receive the normal runtime environment and `HERDR_PLUGIN_EVENT=startup`.
- The install preview lists every startup command.

### Panes

- `placement` defaults to `overlay`, which opens a temporary zoomed overlay over the active pane and restores the previous focus and zoom when it closes.
- A `plugin.pane.open` request can override the manifest placement with `overlay`, `popup`, `split`, `tab`, or `zoomed`.
- `popup` opens a session-modal terminal popup without changing the tiled layout. It accepts optional `width` and `height` in the manifest or open request: numbers are terminal cells; strings such as `"80%"` are percentages of the terminal area. Smaller sizes are clamped.
- A popup receives all terminal input, including Escape, and closes when the command exits or a `popup.close` request is sent.
- A popup is a session singleton, not a Herdr pane: it has no pane ID, does not change plugin focus context, emits no pane lifecycle events, and does not participate in pane, layout, persistence, or agent APIs. Its process does not receive `HERDR_PANE_ID`; the underlying tiled pane remains available through `HERDR_PLUGIN_CONTEXT_JSON`.
- Opening a popup returns `ui_busy` while Settings, Copy mode, or another Herdr modal is active. `plugin.pane.open` returns an `ok` result after launch.
- Split, tab, zoomed, and overlay plugin panes are normal Herdr panes after they open. Plugins can call `pane.move`, `pane.swap`, `pane.resize`, and `pane.zoom`; Herdr keeps pane ownership attached when a pane moves across tabs or workspaces.

### Keybindings

Bind a key to an installed plugin action:

```toml
[[keys.command]]
key = "prefix+l"
type = "plugin_action"
command = "example.layout.apply"
description = "apply layout"
```

### Link handlers

- `[[link_handlers]]` route modified clicks on matching terminal URLs to a plugin action instead of opening the URL in the browser.
- The modified-click modifier is Control on every platform, including macOS, because captured terminal mouse reports do not expose Command/Super separately from a plain click.
- `pattern` is a Rust regular expression matched against the clicked URL. `action` must name an action declared by the same plugin.
- Handlers are checked in manifest order inside each plugin.
- Link-handler actions receive `invocation_source = "link_click"`, `clicked_url`, and `link_handler_id` in `HERDR_PLUGIN_CONTEXT_JSON`; shell plugins can also read `HERDR_PLUGIN_CLICKED_URL` and `HERDR_PLUGIN_LINK_HANDLER_ID`.
- Link clicks invoke plugins only while `ui.mouse_capture` is enabled. Matching handlers run first. A launch failure shows an error and stops. Without a matching handler, only HTTP(S) links open externally.
- When capture is disabled, the outer terminal handles explicit hyperlinks with its own shortcuts and warnings.

### Storage

There is no Herdr-managed plugin storage API in v1. Plugins that need durable state should own their files or database. Keep user config in `HERDR_PLUGIN_CONFIG_DIR` and runtime state in `HERDR_PLUGIN_STATE_DIR`.

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
- Link-handler actions: `HERDR_PLUGIN_CLICKED_URL`, `HERDR_PLUGIN_LINK_HANDLER_ID`.

`HERDR_PLUGIN_ROOT` is the installed or linked plugin directory. Do not store user credentials or durable state there, because GitHub-installed plugin roots are managed source checkouts. Herdr creates `HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR`, seeds the config directory from legacy plugin config locations when present, and does not validate, sync, or delete their contents.

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

## Install, update, and remove

```sh
herdr plugin install owner/repo[/subdir...]   # GitHub shorthand only; preview + build
herdr plugin update [ids|sources]             # refetch recorded refs; skip unchanged; ignore links
herdr plugin uninstall <id-or-source>         # unregister; keep files, config, and state
herdr plugin link /path/to/plugin             # local working tree; no build
herdr plugin unlink <id>                      # unregister a link; leave files
```

- Installed and linked plugins are global to the current user and available in every Herdr session.
- Both `plugin install` and `plugin link` can register plugins while no Herdr server is running.
- `plugin install` clones with `git`, shows the preview in interactive terminals, builds in a new Herdr-managed installation directory, and registers it. Use `--yes` for noninteractive installs and `--ref` to pin.
- Updates and reinstalls leave the previous installation in place: running commands and panes keep their original files, while new invocations use the new installation without a config reload. Existing processes are not restarted; startup hooks run at the next server startup.
- `plugin update` refreshes every GitHub-managed plugin when called without a target, or only the listed plugin ids or GitHub sources. It refetches the ref recorded during install, skips unchanged commits, and ignores locally linked plugins during bulk updates.
- Installing over a locally linked plugin is refused; unlink or uninstall the local plugin first.
- `plugin uninstall` accepts either the plugin id or the same `owner/repo[/subdir...]` shorthand used by install. Installation files are retained so running plugins can finish; a later successful install/update or server startup removes obsolete managed installations once the servers using them have exited. Legacy installations without cleanup tracking are retained. Config and state are preserved.
- Stop plugin work before shutting down its server: processes surviving server exit are not protected from cleanup. Plugins must stop detached background processes before their parent command or pane exits.
- Plugins installed only in a named session on Herdr 0.7.3 must be installed or linked again; existing config and state remain.
- `plugin install` and `plugin link` create the plugin's config and state directories. `plugin config-dir <plugin-id>` prints the config directory for setup docs and shell scripts.

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
- If the repo has multiple manifests, link each plugin directory separately.
- `plugin link` works even when no Herdr server is running.

## Marketplace

Public GitHub repositories tagged `herdr-plugin` with at least one parseable `herdr-plugin.toml` on the default branch are indexed at `herdr.dev/plugins`.

- One card per repository; each valid manifest is a separately installable plugin.
- Manifests may be at the root or in subdirectories.
- The index refreshes every 30 minutes and rescans when the default-branch head changes.
- Forks, archived or private repositories, repositories without a valid manifest, and malformed metadata are excluded.
- Each card shows repository name and owner, description, stars, primary language, and last push.
- Plugin rows show each manifest's `name` and `version` and link to the exact source directory.
- The index records the manifest path, `id`, `name`, `version`, `platforms`, and `min_herdr_version` together with the exact default-branch commit.
- Search by repository or plugin metadata; sort by popularity, recent activity, or newest.
- Install with `herdr plugin install owner/repo[/subdir...]`.
- The catalog is automatic and unreviewed; apply the trust guidance before installing third-party code.

## Checklist

- [ ] Each manifest has `id`, `name`, `version`, `min_herdr_version`, and `platforms`.
- [ ] Action, pane, and link-handler ids contain no dots and are unique.
- [ ] `herdr plugin link <dir>` succeeds for each manifest.
- [ ] Actions, panes, and startup hooks run; `herdr plugin log list` has no relevant errors.
- [ ] `README.md` documents requirements and the exact install command.
- [ ] The repo is public, on its default branch, not archived, and not a fork.
- [ ] Topic `herdr-plugin` is set.
- [ ] `herdr plugin install owner/repo[/subdir...]` works from a clean state; the preview was reviewed.
- [ ] `version` is bumped for the release.
