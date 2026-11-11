# Herdr Git Graph

A native, interactive **Git Graph Viewer** mod for Herdr with topological branch lanes, commit history, working tree inspection, hierarchical file tree, and full-size diff tabs.

Instead of switching away to an external Git GUI or browser tool, `git-graph` renders your repository's multi-branch DAG topology directly inside any Herdr split pane, dedicated tab, or sidebar panel with GPU-accelerated rendering and full keyboard navigation.

![Herdr Git Graph](preview.png)

## Features

- **Theme-First GPU UI**: Powered natively by GPUI (`gpui-kit` / `gpui-base`) with colors dynamically derived from your active Herdr theme (`graphite`, `ink`, `moss`, `paper`, `atom-one-dark`), eliminating hardcoded hex codes.
- **Topological Branch Lanes & Clean Line Termination**:
  - Modularized pure DAG logic in `mods/git-graph/git-logic.js`.
  - Non-overlapping branch rails with topological ordering and stable stream coloring.
  - Clear visual indicators for merge commits, converging branches, and outgoing parent connections.
  - Rounded S-bends join lanes instead of hard right angles, with pass-through rails kept crisp.
  - Distinct outer ring marking the active `HEAD` commit.
  - Graceful termination for parent links outside the branch reachability or filter scope, preventing broken or infinite pass-through rails.
- **Virtualized High-Performance Commit List**:
  - Powered by `uniform_list` with `Scrollbar.vertical` for smooth 60fps scrolling across large codebases.
  - Table layout with a ruled graph column, per-row separators, and `Graph / Description / Date / Author / Commit` headers.
  - Ref pills are rounded, tinted badges: `HEAD` folds into the checked-out branch as a check pill, a local branch and its matching remote collapse into one pill (`⎇ main | origin`), a remote without its local branch keeps `⎇ origin/main`, and tags keep the tag icon.
  - Pagination with "Load 500 more commits..." button and commit count status in toolbar.
  - The All branches view excludes `refs/stash`, so stash-internal WIP/index/untracked commits never show up as graph rows. Each stash renders as one dedicated row instead.
- **In-Progress Operation Detection & Banner**:
  - Automatically identifies in-progress merges (`MERGE_HEAD`), rebases (`rebase-merge/`, `rebase-apply/`), cherry-picks (`CHERRY_PICK_HEAD`), and reverts (`REVERT_HEAD`).
  - Renders a top banner with direct **Continue** and **Abort** actions.
- **Branch Selection Filter & Ref Context Menu**:
  - Toolbar dropdown selector supporting **All branches** (`--all`), **Current branch** (`HEAD`), and any explicit local or remote branch.
  - Clicking any branch badge directly in the commit table instantly isolates reachability to that branch.
  - Right-clicking any branch badge (or a branch in the toolbar dropdown) opens a dedicated context menu: **Checkout Branch**, **Merge into Current Branch...** (disabled for the checked-out branch, confirmed before `git merge --no-edit`), **Rename Branch...** (with an optional toggle to rename its paired remote branch), **Rename Remote Branch...** (pushes the new name, deletes the old one, and keeps local tracking in sync), **Delete Branch...** (with safe/force delete confirmation), **Delete Remote Branch...**, and **Copy Branch Name**.
  - Right-clicking a tag badge opens **Publish Tag to Remote...**, **Rename Tag...**, **Delete Tag...**, and **Copy Tag Name**. A tag that also exists on a remote shows it in the badge (`v1 | origin`), using a cached remote-tag map refreshed on load, manual refresh, and fetch/pull. Publish pushes the tag to a chosen remote without ever forcing it; Delete checks local and remote copies and offers Local only, Remote only, or Local and remote; Rename is local-only and preserves an annotated tag's message.
- **One-Click Remote Sync**:
  - Toolbar **Fetch**, **Pull**, and **Push** buttons beside the branch selector, each with a tooltip naming the exact command and target upstream.
  - The branch selector shows ahead/behind counts (`↑n` / `↓n`); the dropdown reports the tracked upstream.
  - **Push** sets the upstream automatically when the branch does not have one yet.
  - A push rejected as non-fast-forward opens a confirmation modal offering **Force Push**: it refreshes the target ref, then runs `git push --force-with-lease`. Plain `--force` is never used, server-hook rejections are not offered as forceable, and the lease still aborts if the remote moves again.
  - With no remote configured, **Push** publishes the repository to GitHub: it checks `gh auth status`, then asks for a repository name (prefilled from the folder name) and Private / Public visibility before creating the repo and pushing.
  - A missing or unauthenticated GitHub CLI reports what to install or run instead of disabling Push.
  - Fetch disables without a remote; Pull needs an upstream, Push needs a commit on a branch, and all three wait for an in-progress merge/rebase/cherry-pick or another git operation.
- **Background AI Commit Worker**:
  - A one-click sparkles AI button beside the branch controls (also available from the branch dropdown when dirty) starts **OpenCode Mini** in a background Herdr terminal. While the worker starts or runs, the sparkles glyph turns into a native spinning arc, so the toolbar shows that the cleanup is in progress.
  - It always picks the best available free model — DeepSeek V4.1 Flash Free by default, then other free `opencode models` entries — and receives the current branch, dirty paths, and any in-progress operation in its first message.
  - Right-click the AI button (or use **AI commit model…** in the branch dropdown) to choose a model from a scrollable, searchable picker with provider tabs. If no free model can start or the worker stops before finishing, the picker opens automatically.
  - The agent resolves merge/rebase/cherry-pick/revert conflicts, completes the operation, and turns the remaining changes into atomic Conventional Commits using the `git-change-workflow` skill. It slices hunks, not just files: when one file mixes features, each feature's hunks and integration land in their own commit.
  - If one new commit exceeds 1,000 changed lines, the finish toast warns and names it for review instead of claiming a clean atomic history.
  - It works on the current branch only and is explicitly told never to push, fetch, force-push, rewrite history, or discard work. The button disables when the tree is clean, HEAD is detached, or the launched agent is still running; the toast opens its terminal.
  - Starting it keeps a spinning progress toast on screen for the whole run; the toast is dismissed when the worker settles.
  - Workers are independent per checkout, so every space can clean its own repository at the same time; views of the same checkout share one worker and a second start is refused while it runs.
  - When the commits land and the tree is clean, the progress toast is dismissed and a success toast reports how many commits were created.
- **Stash Rows**:
  - Every `git stash` entry renders above the working tree as its own row: hollow stash node, `stash@{n}` pill, reflog subject, relative date, author, and stash commit.
  - Clicking a stash shows its changed files in the details tree and opens normal diff tabs. Right-click for **Unstash (Pop)**, **Apply Stash (Keep)**, **Drop Stash**, and copy actions.
  - Right-click the WIP row for **Stash All Changes…** (optional message, include-untracked toggle), **Stash Staged Changes…**, or **Unstash Latest…** (next to the staging actions below).
- **Working Tree Inspection**:
  - Real-time detection of dirty working trees via `git status` and diff statistics.
  - Dedicated top "WIP" row displaying uncommitted changes with `+add` / `−del` counters.
  - Full inspection of modified, added, deleted, and untracked files, each diff opening in its own tab.
  - Right-click the WIP row to **Stage All Changes** (`git add --all`), **Unstage All**, **Discard All Changes…**, **Stash All Changes…** (with an optional message and include-untracked toggle), **Stash Staged Changes…**, or **Unstash Latest…**.
  - **Discard All Changes…** confirms with the file count and restores tracked files to HEAD (staged and unstaged edits). Untracked files, and newly added files after they are unstaged, are kept unless the dialog's **Also delete N untracked files** toggle (off by default) is turned on, which then runs `git clean -fd`. Ignored files are never deleted.
  - The branch dropdown lists existing stashes even when the tree is clean, and restoring one opens a confirmation and runs `git stash pop --index`.
- **Staging & Committing** (working tree selected):
  - The file list splits into a **Staged Changes** group (index vs HEAD) and a **Changes** group (working tree vs index, plus untracked files), like VS Code. A partly staged file appears in both groups, each with that side's status letter and `+`/`−` counts. Clicking a group header collapses it.
  - Right-clicking a working-tree file adds **Stage** (`git add`; on a conflicted file it marks the conflict resolved), **Unstage** (`git restore --staged`, or `git rm --cached` before the first commit), and **Discard Changes…** above Show Diff / Show File / Copy File Path. Stage and Unstage both appear for a partly staged file.
  - **Discard Changes…** confirms first and says it cannot be undone. A tracked file is restored from HEAD in both the index and the working tree; an untracked file is deleted with `git clean -f`; a new file staged as added is removed from the index and deleted. The dialog names which of these will happen.
  - A commit box above the file list: a multi-line message field, an **Amend** toggle, and a **Commit** button. Commit runs `git commit -m <message>` on the staged changes only and is disabled with a hint while nothing is staged or the message is empty. Amend loads HEAD's message (turning it off brings the earlier draft back), adds any staged changes to HEAD, and warns in the box when HEAD is already on its upstream. On success the box clears and a toast names the new commit; when git or a hook refuses, its stderr is shown under the field.
  - Every action refreshes the graph and file list. Paths are passed as literal pathspecs, git runs in the repository root the graph resolved (linked worktrees included), and no shell is involved.
- **VS Code-Style Changed Files Tree**:
  - For a commit or stash, a fixed **Changes** group header with a count badge and a chevron that collapses or expands every folder. The working tree shows **Staged Changes** and **Changes** groups instead (see Staging & Committing).
  - Nested folders with indentation guide lines, chevrons, and the Material folder icon.
  - Full-color Material Icon Theme icons per file, chosen by exact name or extension (`fileIconPath` in `git-logic.js`), with `_light` variants on light themes — the same icon pattern as the File Editor mod.
  - Hovering a file reveals an **Open in file editor** button beside its name. It opens the current file in the optional `file-editor` mod, reuses that mod's live tab, and keeps the slot reserved so file names never shift. Without the mod the button is disabled and explains how to enable the feature.
  - Right-clicking a file row opens its context menu: **Show Diff**, **Show File**, and **Copy File Path** (working-tree files also get Stage / Unstage / Discard Changes…). **Show Diff** is disabled for binary non-diffable files; Show File is disabled with the install hint when `file-editor` is missing; Copy File Path copies the absolute path.
  - Porcelain status letters on the right: Added (green/`ansi2`), Deleted (red/`ansi1`), Modified (blue/`ansi4`), Conflict (yellow/`ansi3`).
  - Colored per-file `+added` / `−deleted` counts beside the status letter (green/red); untracked diffable text files also show `+N` by counting their lines. The hover tooltip keeps the full path and status label.
  - The details pane below the graph is resizable: drag the divider to change how much of the panel belongs to the commit list and how much to the changed-file tree.
  - Diffs use the same syntax colours as Better Files and Better Changes ([herdr-mods](https://github.com/munza/herdr-mods)): keywords, strings, numbers, constants, functions, types, markup tags and attributes, and JSON/YAML keys.
  - The commit message wraps and expands with its content up to a readable cap, then scrolls, so the description is never clipped. With the working tree selected, the commit box takes its place.
- **Full-Size Diff Tabs**:
  - Clicking a diffable file in the changed-files tree opens its diff in a dedicated Herdr tab (`Diff · <file>`): the tab header shows the file's Material icon, and the body is a virtualized editor with old/new line gutters, green/red change backgrounds, styled hunk headers, and horizontal scrolling for long lines. Non-diffable binary files (`.png`, images, audio, video, archives, binaries) are not diffable and do not open diff tabs.
  - Three layouts, switchable from the tab toolbar and remembered across tabs: **Inline** (unified), **Split** (old and new side by side), and **Stacked** (old above new). Both split panes share one vertical scroll position and keep their own horizontal scrollbar.
  - **Wrap** toggles soft wrapping for long lines in every layout, with the choice remembered across tabs. It reflows to the pane width, keeps line numbers on the first visual row, and preserves syntax colors and intra-line highlights across continuation rows.
  - Character-level intra-line highlighting: changed characters get a brighter red/green background on top of the syntax colors, so a one-character edit inside a long line is visible at a glance (VS Code-style).
  - Working-tree diffs are synthesized for untracked files and refresh automatically while the repo changes.
  - Clicking the same file again selects the existing diff tab instead of piling up duplicates; commit diffs are named `Diff · <file> (<short sha>)`.
- **Commit Right-Click Context Menu & Interactive Modals**:
  - Right-click any commit row to open a native context menu with 10 Git actions:
    - **Checkout Commit...** (confirmation modal with detached HEAD and dirty tree warnings)
    - **Create Branch here...** (interactive modal with "Checkout after creating" toggle and ref validation)
    - **Add Tag here...** (interactive modal with optional annotated tag message)
    - **Cherry Pick...** (confirmation modal)
    - **Revert Commit...** (confirmation modal)
    - **Reset Current Branch to this Commit...** (interactive modal prompt for Mixed / Soft / Hard)
    - **Merge into Current Branch...** (confirmation modal)
    - **Rebase Current Branch on this Commit...** (confirmation modal)
    - **Copy Commit SHA** (copies 40-char hash to clipboard)
    - **Copy Commit Subject** (copies subject line to clipboard)
  - All git arguments are protected with `--end-of-options` to prevent command injection.
  - Interactive inline modal dialogs with Enter (submit) and Esc (cancel) keyboard shortcuts.
  - Provides feedback via Herdr's `notify({...})` toast notifications and automatically refreshes repository state upon mutating actions.
- **Search & Ref Filtering**:
  - Instant search filtering by commit subject, author, email, commit SHA, or branch/tag refs.
  - Click any tag badge in the commit table to search for that ref.
- **Keyboard Navigation**:
  - `↑` / `↓` or `k` / `j` (when not typing in search) moves selection smoothly across commits and the working tree.
  - `Esc` dismisses modals, context menus, branch dropdowns, search focus, or commit selection hierarchically. Diff tabs are ordinary Herdr tabs, closed from the tab bar.
  - `Enter` submits active modal dialogs.
  - `r` triggers an immediate repository refresh.
  - `b` toggles branch scope (`--all` vs. current branch).
- **Responsive Layout**:
  - Dynamically measures container width via `on_size_change`.
  - In compact panes (< 560px), hides the brand text, collapses the author and commit columns and shows the details panel as a full-width file tree.
  - `panel: true` docks it in a layout sidebar with the Files-style card; the toolbar flexes the branch selector and adds an expand button for the full-size tab.

## Requirements

- Herdr desktop app (`herdr-app`).
- Git installed on your system.
- GitHub CLI (`gh`) authenticated with `gh auth login` for the optional **Publish to GitHub** push flow.
- OpenCode CLI (`opencode`) for the optional background **Clean tree** agent button.

## Usage

### Open beside your active terminal
To open side-by-side with your terminal in the active space:
```sh
herdr-app do pane.split --direction right --mod git-graph
```

Or target a specific repository path:
```sh
herdr-app do pane.split --direction right --mod git-graph --props '{"folder":"/path/to/repo"}'
```

### Open in a dedicated tab
```sh
herdr-app do tab.new --name "Git Graph" --mod git-graph --props '{"folder":"/path/to/repo"}'
```

### Layout Wiring (Sidebar / Resizable Panel)
To add Git Graph to your personal Herdr layout clone (e.g. `~/.config/herdr-app/layouts/my-layout.json`), add it to a resizable column or stack:

```json
{
  "id": "git-graph-panel",
  "type": "block",
  "content": {
    "mod": "git-graph",
    "props": { "panel": true }
  },
  "size": {
    "px": 420
  }
}
```

`panel: true` gives the mod the same rounded card as the Files panel, a compact
toolbar, and an expand button that opens the repository full size in a tab.

### Replace the Changes panel
Herdr's tab-bar **Changes** button toggles the `changes` child of the layout's
`panel-body` stack. Point that child at `git-graph` to make the graph the
Changes view:

```json
{
  "id": "changes",
  "type": "block",
  "content": {
    "mod": "git-graph",
    "props": { "panel": true }
  }
}
```

The button keeps working — it now toggles the graph instead of the old changes
list, with the working tree row, file tree, and diff tabs already built in.
The panel resolves its repository from the selected space, checks that location
and panel visibility every 100 ms in memory, and reloads as soon as it opens or changes — so switching spaces
or opening the Changes tab updates the Changes panel immediately with fresh status. A pinned space still keeps its pinned
folder regardless of where its terminals `cd`.

### Test Preview Props
For headless testing or automated surface inspection, open specific overlays on first load using the `preview` prop (`"context-menu"`, `"branch-context-menu"`, `"remote-branch-context-menu"`, `"dropdown"`, `"modal-branch"`, `"modal-tag"`, `"modal-reset"`, `"modal-rename-branch"`, `"modal-rename-remote-branch"`, `"modal-delete-remote-branch"`, `"confirm-merge"`, `"modal-merge-branch"`, `"file-diff"`):
```sh
herdr-app do tab.new --mod git-graph --props '{"folder":"/tmp/repo","preview":"modal-branch"}'
```

### Diff Tabs
The graph opens diffs itself, but a diff tab can also be opened directly:

```sh
# Working-tree diff for one file
herdr-app do tab.new --name "Diff · file.txt" --mod git-graph \
  --props '{"folder":"/path/to/repo","diffFile":"src/file.txt","diffKind":"worktree"}'

# A file as of one commit
herdr-app do tab.new --name "Diff · file.txt (abc1234)" --mod git-graph \
  --props '{"folder":"/path/to/repo","diffFile":"src/file.txt","diffKind":"commit","diffHash":"abc1234"}'
```

Diffs open in the last layout used (Inline, Split, or Stacked) and remember it across tabs, and the **Wrap** toggle is remembered the same way. Pass `"diffView": "inline" | "split" | "stacked"` or `"diffWrap": true` to choose them when opening a tab directly. Pass `"on": "<machine>"` as well to read the diff from a remote space's machine.

## Credits

File and folder icons are from [Material Icon Theme](https://github.com/PKief/vscode-material-icon-theme), MIT License. See `mods/git-graph/icons/LICENSE.txt`.

## Install & Sync

Sync `mods/git-graph` into `~/.config/herdr-app/mods/`:

```sh
./sync.sh
```

Then check that the mod passes validation:
```sh
herdr-app check ~/.config/herdr-app/mods/git-graph
```

## Publishing

To publish `git-graph` to the Herdr marketplace (`herdr.dev/mods`):

1. Keep `mods/git-graph/` at the repository root.
2. Keep `RECIPE.md` and `preview.png`.
3. Add the GitHub topic `herdr-mod`:
   ```sh
   gh repo edit --add-topic herdr-mod
   ```
4. Verify visibility and topics:
   ```sh
   gh repo view --json visibility,repositoryTopics,defaultBranchRef
   ```

## Git worktrees

A branch checked out in a linked worktree (`git worktree add`) gets a worktree icon, a `worktree` chip, and the `ansi6` colour on its badge. Its tooltip names the checkout path.

When the optional `worktree-plus` mod from `herdr-space-actions` is installed, the branch menu also offers:

- **Switch to Worktree Space** (or **Switch to Main Space**) selects the Herdr space that shows that checkout, or opens one. No `git checkout` runs, because git refuses a branch that is checked out elsewhere.
- **Delete Branch and Worktree…** runs only when the branch is fully merged into HEAD. It closes the checkout's space, removes the worktree without `--force`, then runs `git branch -d`. Uncommitted changes make git refuse the removal, and the dialog shows why.

Without the mod, these items behave as before: checkout uses git, and **Delete Branch…** deletes only the branch.
