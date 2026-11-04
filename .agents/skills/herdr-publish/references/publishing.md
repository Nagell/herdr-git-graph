# Publishing Herdr extensions

Herdr has two indexes. Use the right one or the listing will not appear.

| | App mods | TUI plugins |
|---|---|---|
| Index | <https://herdr.dev/mods> | <https://herdr.dev/plugins> |
| GitHub topic | `herdr-mod` | `herdr-plugin` |
| Manifest | `mods/<name>/main.js` + `mod.json` | `herdr-plugin.toml` |
| Extra files | `RECIPE.md`, `preview.png` | valid manifest metadata, README |
| Discovery | within about an hour | every 30 minutes |
| Install | copy/sync `mods/<name>` into `~/.config/herdr-app/mods/`, wire the layout | `herdr plugin install owner/repo[/subdir]` |

Both indexes are automatic and unreviewed. A listing means the repository tagged itself, not that Herdr vetted the code. Apply the trust guidance before installing third-party extensions.

## GitHub housekeeping

```sh
# Public repo, default branch, visible metadata
gh repo view --json visibility,repositoryTopics,defaultBranchRef,description

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
└── mods/
    └── <name>/
        ├── main.js
        ├── mod.json
        └── assets...
```

- The `mods/<name>/` folder name is part of the mod identity; `main.js` may reference `mods/<name>/...` assets by that path.
- Several mods may live in one repo when they are one feature (for example `ref-menu` + `tabs-ref`). Document that they are installed together.
- `RECIPE.md` must be written from the real files: what you see, how it behaves, built from, watch out, done when.
- `preview.png` should be a real screenshot of the mod in Herdr. Use `herdr-app shot` and crop to the relevant area.
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
- Add `description` and `platforms`.
- Manifests may be at the root or in subdirectories of the default branch.
- One repository card lists each valid manifest as a separately installable plugin.
- Forks, archived repositories, private repositories, repositories without a valid manifest, and malformed metadata are excluded.
- The index refreshes every 30 minutes and rescans when the default branch head changes.
- Install with `herdr plugin install owner/repo[/subdir]`.
- `version` is shown in the listing; bump it for a release.

## Preflight

Run from the repo root:

```sh
.agents/skills/herdr-publish/scripts/preflight.sh
```

The script detects app mods (`mods/*/main.js`) and TUI plugins (`herdr-plugin.toml`), runs the relevant local checks, and prints GitHub visibility/topic/default-branch metadata when `gh` is available. It never commits or pushes.

## Release checklist

- [ ] The working tree is clean and the release commit is on the default branch.
- [ ] The correct topic is set (`herdr-mod` or `herdr-plugin`).
- [ ] The repo is public, not archived, and not a fork.
- [ ] The manifest/folder names are stable and documented.
- [ ] `README.md` has requirements and exact install steps.
- [ ] App mods: `RECIPE.md`, `preview.png`, `./sync.sh` and `herdr-app check` pass.
- [ ] TUI plugins: every `herdr-plugin.toml` links, actions/panes run, logs are clean.
- [ ] Version bumped where applicable.
- [ ] The exact install command was tested from a clean state.
- [ ] After indexing, open the marketplace card and verify the plugin row/source link.
