# Herdr app mods

App mods are the Herdr **app** extension surface: panels, tab bars, status bars, dialogs. They are not the TUI plugin system (`herdr-plugin.toml`). They live in `~/.config/herdr-app/mods/<name>/` and are loaded by the running app.

## Source of truth

Keep the mod source in a git repo, not only in the live folder. The repo layout is:

```
repo/
├── AGENTS.md
├── README.md
├── RECIPE.md
├── preview.png
├── keys.json          # optional key snippet to merge into the user's keys
├── sync.sh
├── .gitignore
└── mods/
    └── <name>/
        ├── main.js
        ├── mod.json
        └── assets...
```

`sync.sh` copies `mods/<name>` to `~/.config/herdr-app/mods/<name>` and runs `herdr-app check`. A feature that needs two mods may keep both in one repo and sync both.

Do not edit the live copy directly. Do not edit shipped mods or layouts: Herdr restores them on restart. Clone first:

```sh
herdr-app do mod.clone --name workspace-status --as usage-status
herdr-app do layout.clone --name main --as my-layout
```

## `mod.json`

The minimal manifest for a panel or status-bar mod:

```json
{ "place": "none" }
```

- `place`: `right`, `left`, `top`, `bottom`, or `none`. A status-bar mod is `none`; the layout places it.
- `title`: optional title for a docked panel.
- `overlay`: `{ "width": 260, "height": 250 }` for a popup/overlay mod.
- `focusable`: `true` if `pane.go` should give it keyboard focus.
- `cloned_from`: metadata added by `mod.clone`; safe to keep.

## `main.js`

Default-export a class extending `View`; `init(props, cx)` runs once and `render(cx)` re-runs after `cx.notify()` and live data changes.

```js
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, spaces } from "herdr";

export default class Example extends View {
  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    return h_flex().size_full().px(14).items_center().bg(t.chrome).text_color(t.muted)
      .child(space?.name ?? "Herdr");
  }
}
```

Rules:

- Use `theme()` colors, not hardcoded hex, so light/dark themes work.
- Use `cx.timer.every` for data refresh, not `setTimeout`/`setInterval`.
- Use `cx.spawn` for async work; never keep a `cx` across an await.
- Put `exec`, network, and file work in the background.
- Assets are referenced from the app root: `mods/<name>/icon.svg`, `icons/...`.
- Generated files (`gpui-kit.d.ts`, `jsconfig.json`, `.cache-*`, `__pycache__`) are local.

## Layout wiring

A personal layout clone decides where the mod appears:

```json
{
  "id": "status",
  "type": "block",
  "content": { "mod": "usage-status" },
  "size": { "px": 28 }
}
```

Other common placements:

- Tab bar: `{ "id": "tabs", "content": { "mod": "tabs-ref" } }`
- Terminal right-click menu: root `"terminal_menu": "ref-menu"`
- Panel: a block with `content.mod` inside a resizable column.

If a layout reset removes the block, re-add it and switch to the personal layout (`herdr-app do layout.switch --name werlang`).

## Local checks

```sh
./sync.sh
herdr-app check mods/<name>
herdr-app shot /tmp/herdr.png
herdr-app status
```

`herdr-app check` loads the mod once and validates its initial render. It does not test later async states, so also open the mod in the app. `herdr-app status` should report no errors.

## Publishing to herdr.dev/mods

A shared app mod is a public GitHub repository with:

- `mods/<name>/` at the root. One repo can hold several mods, each in its own `mods/<name>/` folder; document that they are installed together when they are one feature.
- No `layouts/` folder: a mod is a piece for the user's existing layout.
- `RECIPE.md` in the Herdr sharing format.
- `preview.png` with a real screenshot. Community pictures are screened before they appear.
- Optional `keys.json` at the repo root with a snippet users can merge into their own `keys.json`.
- GitHub topic `herdr-mod`.

The index at `herdr.dev/mods` refreshes within about an hour. It is a community index, not a reviewed catalog. Mods are trusted code, not sandboxed: users should read the recipe and source before installing.

`RECIPE.md` sections:

1. `# Name` + one paragraph + `![Name](preview.png)`.
2. **What you see**: regions, sizes, colors, type.
3. **How it behaves**: clicks, keys, hovers, status changes.
4. **Built from**: layout nodes, mods, `props`, `herdr` functions and commands, any programs it runs.
5. **Watch out**: limits, assumptions, controls that do nothing, setup dependencies.
6. **Done when**: checks that prove a build works.

`preview.png` should show the mod in context, not a mockup. Use `herdr-app shot` and crop the relevant area.

## Checklist

- [ ] The repo has `AGENTS.md` with the sync rule.
- [ ] `./sync.sh` passes `herdr-app check` for every mod.
- [ ] The mod works in the running app; `herdr-app status` has no errors.
- [ ] `README.md` lists requirements and the exact layout wiring.
- [ ] `RECIPE.md` and `preview.png` exist; the preview is a real screenshot.
- [ ] No `layouts/` folder; optional `keys.json` is valid JSON.
- [ ] The repo is public and has topic `herdr-mod`.
- [ ] The exact install/sync steps are documented.
