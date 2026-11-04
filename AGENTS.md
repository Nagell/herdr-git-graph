# herdr-git-graph

Source of truth for the `git-graph` Herdr mod: a visual Git graph viewer with topological branch lanes, commit history, working tree inspection, a hierarchical file tree, full-size diff tabs, branch filtering, right-click context menu actions, and modal dialogs built natively with GPUI.

## Rule: Always Update the Herdr Live Folder

Herdr reads active mods from `~/.config/herdr-app/mods/<name>`. After **any** code change in this repository, run:

```sh
./sync.sh
```

The script copies `mods/git-graph` to `~/.config/herdr-app/mods/git-graph` and runs `herdr-app check`. Never edit files in `~/.config/herdr-app/mods/` directly.

## How It Works

- **Theme-First Dynamic Colors**: Lane and status colors are computed dynamically from `theme()` (`[t.accent, t.ansi2, t.ansi4, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.working, t.done]`), ensuring crisp contrast and native styling across all light and dark Herdr themes (`graphite`, `ink`, `moss`, `paper`, `atom-one-dark`).
- **Rendering Rules**:
  - Never pass `null` or `undefined` to `.child()`: a re-render aborts with `child(value) expects an element…` and Herdr keeps the last good frame behind an error banner. Use `.when(cond, (el) => el.child(...))` for optional children.
  - Never use an event handler's `cx` after an `await`: that `Context` is valid only for the host call that delivered the event, and using it later throws (leaving `busy` flags stuck). Do the synchronous reads first, then wrap every awaited operation in `cx.spawn(async (cx) => …)` and use the `AsyncContext` it provides.
- **Stable Location Resolution**:
  - Uses `props().folder || props().repo || props().cwd` when provided.
  - Retains user-selected repositories via `this.manualRoot` from `pickFolder()` so clicking into the graph never resets the repository view.
  - A **pinned space is anchored to its pinned location** (`spaces.pinned_locations`): terminals inside the space may `cd` anywhere, but the graph stays on the pinned project.
  - Unpinned spaces follow: the focused terminal's cwd, the terminal in this mod's own tab (the split partner), the space's folder, the root already resolved, then any terminal in the space.
  - `space.folder` is only a fallback, because Herdr sets it when the space is created and never updates it.
- **Safe Git Log Parsing & Unborn Branch Handling**:
  - Detects unborn branches via `git branch --show-current` with fallback to `HEAD`.
  - Checks `git rev-parse --verify HEAD` before attempting log extraction, providing a friendly empty state for fresh repositories without crashing.
  - Uses ASCII Unit Separator `%x1f` (`--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s`) to safely preserve commit subjects containing pipes `|` or special characters.
  - Detects in-progress Git operations (`MERGE_HEAD`, `rebase-merge/` or `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) and renders a prominent status banner with direct **Continue** and **Abort** actions.
- **Topological DAG Lane Allocation & Clean Termination**:
  - Modularized in `mods/git-graph/git-logic.js` for pure logic testability.
  - `computeLanes(commits)` allocates lanes without duplicate parent hashes in `activeLanes` and assigns stable colors via `colorIdx`.
  - Accurately renders converging lanes from children merging into a parent, pass-through vertical rails, outgoing connections to parents, merge commit indicators, and a distinct outer ring for HEAD.
  - Parents outside the current branch or filtered view gracefully terminate at the row edge (`terminated: true`) without leaving zombie rails across unrelated commits.
  - Dynamically recalculates lanes on filtered commit subsets when searching or switching branch reachability.
- **Virtualized High-Performance Commit Table**:
  - Uses `uniform_list` with `Scrollbar.vertical` for smooth 60fps scrolling across repositories with thousands of commits.
  - **Never register event handlers inside the row renderer** (`on_click`, `on_size_change`, `on_hover`, …): the runtime throws and the whole visible slice disappears, leaving a blank list. Use `on_item_click` / `on_item_secondary_click` on the list and compute per-badge hit boxes from the fixed widths the rows are laid out with.
  - Implements pagination with a "Load 500 more commits..." button and commit count status in the toolbar.
- **Branch Selection Filter & Ref Context Menu**:
  - Toolbar dropdown allows selecting "All branches" (`--all`), "Current branch" (`HEAD`), or any specific local/remote branch (`git log <branch>`).
  - Clicking any branch badge in the commit table instantly filters the DAG to that branch's reachable history.
  - Right-clicking any branch badge opens a dedicated ref context menu: **Checkout Branch**, **Delete Branch...** (with safe/force delete confirmation), and **Copy Branch Name**.
- **One-Click Fetch / Pull / Push**:
  - Three icon buttons sit next to the branch selector: **Fetch** (`git fetch --all --prune`), **Pull** (`git pull --no-edit`), and **Push** (sets the upstream automatically when the branch has none).
  - The selector shows ahead/behind counts (`↑n` / `↓n`) and the dropdown shows the tracked upstream. Tooltips state the exact command and target.
  - Buttons disable themselves with no remote, no upstream (pull), a detached HEAD (push), an in-progress merge/rebase/cherry-pick, or while another git operation is running.
  - Remote commands run with `credential.interactive=false` and an HTTP low-speed cutoff so a missing prompt or stalled transfer fails loudly instead of hanging the toolbar.
- **Background Tree Cleanup Agent**:
  - An OpenCode icon button beside the branch controls (and a matching action in the branch dropdown when the tree is dirty) starts **OpenCode Mini** in a background Herdr terminal with `hc run --bg --keep`.
  - It runs the `build` agent with `opencode-go/deepseek-v4.1-flash#low` and names the terminal `clean-<branch>` (labels it to the current space/tab).
  - The first message carries the repository, current branch, dirty paths, and any in-progress merge/rebase/cherry-pick/revert. The agent must resolve conflicts and complete the operation, then make atomic Conventional Commits on the current branch using the `git-change-workflow` skill.
  - The task explicitly forbids pushing, fetching, force-pushing, history rewriting, `reset --hard`, and `git clean`. The button disables on a clean tree, detached HEAD, while another git action runs, or while the launched agent is still working; the success toast can peek at its terminal.
- **Working Tree Inspection**:
  - Inspects uncommitted changes via `git status --porcelain=v1 -z --no-renames --untracked-files=all` and diff stats.
  - Displays a top "DIRTY" row with `+add` / `−del` badges connected directly to HEAD in lane 0.
  - Inspects modified, added, deleted, and untracked files; each diff opens in its own tab.
- **Docked Panel Mode**:
  - `props: { panel: true }` renders the graph as the Files-style card inside a layout panel, such as Herdr's Changes slot.
  - The toolbar stays compact: the brand text is dropped, the branch selector flexes into the free width, and an expand button opens the same repository full size in a tab.
- **Commit Details Tree View & Diff Tabs**:
  - Changed files are organized in a hierarchical tree view with collapsible/expandable directory nodes and chevron toggles (`chevron-down.svg` / `chevron-right.svg`).
  - Folders with changes are expanded by default.
  - Clicking any file opens its diff in a dedicated Herdr tab (`Diff · <file>`) rendered with `v_virtual_list`: old/new line gutters, `+`/`−` backgrounds from `t.ansi2`/`t.ansi1`, styled hunk headers, and horizontal scrolling for long lines.
  - The toolbar switches between **Inline** (unified), **Split** (side by side) and **Stacked** (old above new). The choice persists in `shared("git-graph.diffView")`. Both split panes use one `VirtualListScrollHandle`, so vertical scrolling stays in lockstep while each pane keeps its own horizontal scrollbar.
  - `git-logic.js` pairs each removed line with its added counterpart and computes character-level change ranges (`intraLineDiff`): word-level LCS first, character refinement inside changed words, and a whole-middle fallback for rewrites. `lineSegments` overlays those ranges on the syntax spans, which the renderer paints with a stronger `ansi1`/`ansi2` background.
  - A diff tab is a second mode of the same mod (`props: { folder, diffFile, diffKind: "worktree" | "commit", diffHash?, on?, diffView? }`). Clicking a file already open by name selects that tab instead of duplicating it.
  - Working-tree diffs watch the repository and refresh; untracked files are shown as synthesized all-added diffs.
- **Commit Right-Click Context Menu & Interactive Modals**:
  - Right-clicking any commit row opens an in-component context menu with 10 native Git operations:
    1. **Checkout Commit...** (confirmation modal warning of detached HEAD or dirty working tree)
    2. **Create Branch here...** (prompts for branch name with "Checkout after creating" toggle and `git check-ref-format` validation)
    3. **Add Tag here...** (prompts for tag name and optional annotated tag message)
    4. **Cherry Pick...** (confirmation modal before cherry-picking)
    5. **Revert Commit...** (confirmation modal before reverting)
    6. **Reset Current Branch to this Commit...** (prompts for Mixed / Soft / Hard)
    7. **Merge into Current Branch...** (confirmation modal before merging)
    8. **Rebase Current Branch on this Commit...** (confirmation modal before rebasing)
    9. **Copy Commit SHA** (copies 40-char hash to clipboard)
    10. **Copy Commit Subject** (copies subject line to clipboard)
  - All git arguments are protected with `--end-of-options` to prevent command injection.
  - Interactive inline modal dialogs with Enter (submit) and Esc (cancel) keyboard handling.
  - Provides feedback via Herdr `notify({...})` toast notifications and automatically refreshes repository state upon mutation.
- **Keyboard Navigation & Responsive Layout**:
  - `Up` / `Down` (or `k` / `j` when search input is not focused) navigates commit and working tree selection.
  - `Escape` dismisses modals, context menus, branch dropdowns, search focus, or commit selection hierarchically. Diff tabs are regular Herdr tabs and are closed from the tab bar.
  - `Enter` submits active dialog prompts.
  - `r` refreshes repository state, `b` toggles current branch vs. all branches.

## How to Open in Herdr

### Split beside an active terminal
```sh
herdr-app do pane.split --direction right --mod git-graph
```

Or target an explicit repository folder:
```sh
herdr-app do pane.split --direction right --mod git-graph --props '{"folder":"/path/to/repo"}'
```

### Open in a dedicated tab
```sh
herdr-app do tab.new --name "Git Graph" --mod git-graph --props '{"folder":"/path/to/repo"}'
```

### Replace the Changes panel

Herdr's **Changes** panel is a stack child in the layout. Point that slot at
`git-graph` and pass `panel: true`:

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

`panel: true` draws the rounded card used by the Files panel, keeps the toolbar
compact, and adds an expand button that opens the repository full size in a tab.
The tab-bar Changes button then toggles the graph instead of the old changes list.

## Skill

The `herdr-publish` skill is located in `.agents/skills/herdr-publish/SKILL.md`. It provides local preflight checks (`preflight.sh`), sync guidelines, and publishing steps for `herdr.dev/mods` under topic `herdr-mod`.
