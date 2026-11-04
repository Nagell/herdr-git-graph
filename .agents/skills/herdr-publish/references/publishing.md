# Publishing Herdr extensions

Herdr has two indexes. Use the right one or the listing will not appear.

| | App mods | TUI plugins |
|---|---|---|
| Index | <https://herdr.dev/mods> | <https://herdr.dev/plugins> |
| GitHub topic | `herdr-mod` | `herdr-plugin` |
| Manifest | `mods/<name>/main.js` + `mod.json` | `herdr-plugin.toml` |
| Extra files | `RECIPE.md`, `preview.png`, optional `keys.json` | valid manifest metadata, README |
| Discovery | within about an hour | every 30 minutes |
| Install | copy/sync `mods/<name>` into `~/.config/herdr-app/mods/`, wire the layout | `herdr plugin install owner/repo[/subdir...]` |

Both indexes are automatic and unreviewed. A listing means the repository tagged itself, not that Herdr vetted the code. Apply the trust guidance before installing third-party extensions.

## GitHub housekeeping

```sh
# Public repo, default branch, visible metadata
gh repo view --json visibility,repositoryTopics,defaultBranchRef,description,isFork,isArchived

# Add the correct topic
gh repo edit --add-topic herdr-mod       # app mod
gh repo edit --add-topic herdr-plugin    # TUI plugin

# Make sure the working tree is clean and pushed
git status --short
git push
```

A repository card shows the repository name/owner, description, stars, primary language, and last push. Write a useful `README.md` and repository description; they are part of the listing.

## App mods (`herdr.dev/mods`)

Structure:

```
repo/
├── README.md
├── RECIPE.md
├── preview.png
├── keys.json          # optional key snippet to merge into the user's keys
└── mods/
    └── <name>/
        ├── main.js
        ├── mod.json
        └── assets...
```

- The `mods/<name>/` folder name is part of the mod identity; `main.js` may reference `mods/<name>/...` assets by that path.
- One repo can hold several mods, each in its own `mods/<name>/` folder (for example `ref-menu` + `tabs-ref`). Document that they are installed together when they are one feature.
- Do not include a `layouts/` folder in a mod repo: a mod is a piece for the user's existing layout.
- `RECIPE.md` must be written from the real files: what you see, how it behaves, built from, watch out, done when.
- `preview.png` should be a real screenshot of the mod in Herdr. Use `herdr-app shot` and crop to the relevant area. Community pictures are screened before they appear.
- Optional `keys.json` at the repo root is a snippet users merge into their own `keys.json`.
- The index refreshes within about an hour after the topic and default-branch changes.

Install instructions for users:

```sh
# copy the mod folder into the live app home
cp -R mods/<name> ~/.config/herdr-app/mods/
# then point the personal layout block at it and run
herdr-app check ~/.config/herdr-app/mods/<name>
```

`AGENTS.md` in the repo should tell agents to edit the repo and run `./sync.sh`, never the live copy.

## TUI plugins (`herdr.dev/plugins`)

Structure:

```
repo/
├── README.md
├── herdr-plugin.toml
└── ...commands/assets
```

or multiple plugins:

```
repo/
├── README.md
├── plugin-one/herdr-plugin.toml
└── plugin-two/herdr-plugin.toml
```

- Required metadata must parse: `id`, `name`, `version`, `min_herdr_version`.
- Add `description` and `platforms`; item-level platforms override the top-level list.
- Plugin ids may contain ASCII letters, digits, dot, colon, underscore, and hyphen. Action, pane, and link-handler ids are local, may not contain dots, and must be unique within their type.
- Manifests may be at the root or in subdirectories of the default branch.
- One repository card lists each valid manifest as a separately installable plugin.
- Forks, archived or private repositories, repositories without a valid manifest, and malformed metadata are excluded.
- The index refreshes every 30 minutes and rescans when the default branch head changes.
- Each card shows repository name/owner, description, stars, primary language, and last push. Plugin rows show each manifest's `name` and `version` and link to the exact source directory.
- The index records the manifest path, `id`, `name`, `version`, `platforms`, and `min_herdr_version` together with the exact default-branch commit.
- Install with `herdr plugin install owner/repo[/subdir...]`; it accepts GitHub shorthand only.
- `plugin install` shows a preview of the source and commands in interactive terminals. Use `--yes` only after reviewing it, and `--ref` to pin a revision.
- Installed and linked plugins are global to the user and available in every Herdr session. Both can register while no server is running.
- `plugin update [ids|sources]` refetches recorded refs and ignores local links. `plugin uninstall <id-or-source>` unregisters but keeps files, config, and state; `plugin unlink` only unregisters a local link. Installing over a linked plugin is refused.
- `version` is shown in the listing; bump it for a release.

## Preflight

Run from the repo root:

```sh
.agents/skills/herdr-publish/scripts/preflight.sh
```

The script detects app mods (`mods/*/main.js`) and TUI plugins (`herdr-plugin.toml`), runs the relevant local checks, validates manifest metadata and ids, and prints GitHub visibility, topics, default branch, fork/archived state, and description when `gh` is available. It never commits or pushes.

## Release checklist

- [ ] The working tree is clean and the release commit is on the default branch.
- [ ] The correct topic is set (`herdr-mod` or `herdr-plugin`).
- [ ] The repo is public, not archived, and not a fork.
- [ ] The manifest/folder names are stable and documented.
- [ ] `README.md` has requirements and exact install steps.
- [ ] App mods: `RECIPE.md`, `preview.png`, `./sync.sh` and `herdr-app check` pass; no `layouts/` folder; optional `keys.json` is valid.
- [ ] TUI plugins: every `herdr-plugin.toml` links, actions/panes run, logs are clean; install preview was reviewed, `--ref` was tested when pinning.
- [ ] Version bumped where applicable.
- [ ] The exact install command was tested from a clean state.
- [ ] After indexing, open the marketplace card and verify the plugin row/source link and preview image.
