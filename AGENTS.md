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
  - Unpinned spaces follow: the focused terminal's cwd, the terminal in this mod's own tab (the split partner), the space's folder, any terminal in the space, then the root already resolved.
  - A focus left behind in the previous space (when the selected space has no pane) is ignored, so the panel never reads another space's folder.
  - The resolved location is checked every 100 ms (in memory only): switching spaces reloads the panel at once instead of waiting for the 10 s refresh.
  - Opening the Changes tab or panel (transitioning from hidden or another panel tab to visible) triggers an immediate automatic refresh so git status is fresh on reveal.
  - `space.folder` is only a fallback, because Herdr sets it when the space is created and never updates it.
- **Safe Git Log Parsing & Unborn Branch Handling**:
  - Detects unborn branches via `git branch --show-current` with fallback to `HEAD`.
  - Checks `git rev-parse --verify HEAD` before attempting log extraction, providing a friendly empty state for fresh repositories without crashing.
  - Uses ASCII Unit Separator `%x1f` (`--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s`) to safely preserve commit subjects containing pipes `|` or special characters.
  - Detects in-progress Git operations (`MERGE_HEAD`, `rebase-merge/` or `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) and renders a prominent status banner with direct **Continue** and **Abort** actions.
- **Topological DAG Lane Allocation & Clean Termination**:
  - Modularized in `mods/git-graph/git-logic.js` for pure logic testability.
  - `computeLanes(commits)` allocates lanes without duplicate parent hashes in `activeLanes` and assigns stable colors via `colorIdx`.
  - `computeLanes` also records, per row, the edges crossing its top and bottom (`edgesUp` / `edgesDown`: `{ from, to, colorIdx }` lanes). Every edge runs node-row center to node-row center as one cosine S-curve; `renderGraphLanes` draws its upper half in the row it leaves and its lower half in the row it enters, so splits and merges bend over a full row.
  - A first-parent edge keeps the child's color while it bends, so a side branch rejoins its base in its own color. Edges from the working tree are dotted.
  - Commits are solid dots (merges included), HEAD gets a halo ring, and the working tree is a hollow ring.
  - Parents outside the current branch or filtered view gracefully terminate at the row edge (`terminated: true`) without leaving zombie rails across unrelated commits.
  - Dynamically recalculates lanes on filtered commit subsets when searching or switching branch reachability.
- **Virtualized High-Performance Commit Table**:
  - Uses `uniform_list` with `Scrollbar.vertical` for smooth 60fps scrolling across repositories with thousands of commits.
  - **Never register event handlers inside the row renderer** (`on_click`, `on_size_change`, `on_hover`, …): the runtime throws and the whole visible slice disappears, leaving a blank list. Use `on_item_click` / `on_item_secondary_click` on the list and compute per-badge hit boxes from the fixed widths the rows are laid out with.
  - Every row carries a 1px bottom rule and a vertical rule closes the graph column; the header mirrors those columns (`Graph / Description / Date / Author / Commit`).
  - HEAD folds into the checked-out branch pill (a check icon plus the branch name) instead of a separate badge. A local branch and its matching remote share one neon pill (`⎇ main | origin`); a remote without its local branch keeps its full `origin/main` label. Tags keep the tag icon.
  - Implements pagination with a "Load 100 more commits..." button and commit count status in the toolbar.
  - Caches inspected commit details (`commitDetailsCache`, up to 200 commits) for zero-latency instant commit selection without refetching or UI blanking.
  - Fast branch switching path: switching branch filters or loading more commits executes only `git log` and lane recalculation without re-scanning unchanged working tree status, remotes, or stashes.
  - Concurrent repository discovery: `refresh()` fires all independent git status, branch, remote, and log checks simultaneously with `Promise.all`.
  - Ref display memoization: `resolveDisplayRefs` precomputes folded HEAD and paired remote badges once per commit, eliminating per-frame allocations during table scrolling.
  - The **All branches** log excludes `refs/stash`, so Git's internal stash WIP/index/untracked commits never appear as graph rows. Each stash instead renders as one dedicated row.
- **Stash Rows**:
  - `git stash list` refreshes with the graph. Each stash sits above the working tree as a standalone row: a hollow stash node, a `stash@{n}` pill, the reflog subject, relative date, author, and stash commit.
  - Clicking a stash selects it like a commit and shows its changed files in the details tree; diffs open in normal diff tabs. Right-click offers **Unstash (Pop)…**, **Apply Stash (Keep)**, **Drop Stash…**, **Copy Stash Ref**, and **Copy Stash SHA**.
  - Right-clicking the WIP row offers **Stash All Changes…** (optional message, include-untracked toggle), **Stash Staged Changes…**, and **Unstash Latest…**.
- **Branch Selection Filter & Ref Context Menu**:
  - Toolbar dropdown allows selecting "All branches" (`--all`), "Current branch" (`HEAD`), or any specific local/remote branch (`git log <branch>`).
  - Clicking any branch badge in the commit table instantly filters the DAG to that branch's reachable history.
  - Right-clicking any branch badge (or a branch in the toolbar dropdown) opens a dedicated ref context menu: **Checkout Branch**, **Merge into Current Branch…** (disabled for the checked-out branch, confirmed before `git merge --no-edit`), **Rename Branch…** (renames the local ref and optionally its paired remote), **Rename Remote Branch…** (pushes the new name, deletes the old one, and updates local tracking), **Delete Branch...** (with safe/force delete confirmation), **Delete Remote Branch…** (for remote branches or branches with a paired remote, confirmed before `git push <remote> --delete`), and **Copy Branch Name**.
  - Rename uses a single modal prefilled with the current name, validates it with `git check-ref-format --branch`, rejects collisions, and toggles the counterpart ref. A remote rename is not in-place: it pushes `refs/remotes/<remote>/<old>` as `<remote>/<new>`, deletes the old remote branch, renames the same-named local branch when asked, and rewrites the local upstream only when it tracked the old remote ref. Partial failures keep the modal open, report exactly what changed, and refresh the graph.
- **One-Click Fetch / Pull / Push**:
  - Three icon buttons sit next to the branch selector: **Fetch** (`git fetch --all --prune`), **Pull** (`git pull --no-edit`), and **Push** (sets the upstream automatically when the branch has none).
  - With no remote configured, **Push** turns into **Publish to GitHub**: after `gh auth status` confirms a login, a modal asks for the repository name (prefilled from the folder name, sanitized) and Private / Public visibility, then runs `gh repo create <name> --source <root> --remote origin --private|--public` followed by `git push --set-upstream origin <branch>`.
  - A missing `gh` binary or an unauthenticated CLI produces an actionable toast instead of silently disabling the button.
  - The selector shows ahead/behind counts (`↑n` / `↓n`) and the dropdown shows the tracked upstream. Tooltips state the exact command and target.
  - Fetch disables without a remote; Pull needs an upstream, Push needs a commit and a branch, and all three wait for an in-progress merge/rebase/cherry-pick or another git operation.
  - Remote commands run with `credential.interactive=false` and an HTTP low-speed cutoff so a missing prompt or stalled transfer fails loudly instead of hanging the toolbar.
- **Background AI Commit Worker**:
  - A sparkles AI button beside the branch controls (and a matching action in the branch dropdown when the tree is dirty) starts **OpenCode Mini** in a background Herdr terminal with `hc run --bg --keep`. From the click until the worker settles, its sparkles glyph becomes a native spinning arc (`.spin(900)` in `treeAgentGlyph`), so the toolbar itself shows the cleanup is running.
  - It runs the `build` agent and always prefers free models: `opencode models` is consulted at launch and the first available entry from a curated free list (DeepSeek V4.1 Flash Free `#low`, GLM-5.3-Flash Free, MiMo-V2.6-Flash Free, …) is used. A saved choice in `shared("git-graph.cleanAgentModel")` wins only while it is still listed.
  - Right-clicking the toolbar button, or **AI commit model…** in the branch dropdown, opens a scrollable model picker with provider tabs (each provider's icon), a search field, free models first and a **Show all** toggle. The currently active model is pinned at the top with an `ACTIVE` badge, displayed in the header pill and button tooltip, and preselected so clicking **Start agent** or clicking the toolbar button directly always executes with the exact same model. If no free model is available, or the worker exits before the tree is clean, the picker opens automatically so the person can choose another model and retry.
  - It names the terminal `clean-<branch>` and starts it with no `herdr.space` / `herdr.tab` labels, so it stays a hidden background worker instead of being adopted into the current tab as a split pane.
  - Starting it posts a persistent **spinning toast** with the chosen model; the GIF spinner animates natively and the toast stays up (and click-to-peeks the worker) until the worker settles, then the mod dismisses it.
  - The first message carries the repository, current branch, dirty paths, and any in-progress merge/rebase/cherry-pick/revert. The agent must resolve conflicts and complete the operation, then make atomic Conventional Commits on the current branch using the `git-change-workflow` skill.
  - The task explicitly forbids pushing, fetching, force-pushing, history rewriting, `reset --hard`, and `git clean`. The button disables on a clean tree, detached HEAD, while another git action runs, or while the launched agent is still working; the progress toast can peek at its terminal.
  - Once the session goes idle **and** `git status` is clean, the worker is done: the graph dismisses the progress toast, reports how many commits were created, kills the background terminal, and closes its tab/pane. A dirty tree with a dead terminal instead dismisses the progress toast, shows an error, and opens the model picker.
  - Workers are independent per checkout: the shared key is `git-graph.activeTreeAgent.<encoded machine + checkout>` (the bare key stays as a fallback and drains a worker started before a reload), so every space can clean its own repository while another space already runs. Views of the same checkout share one worker, so a second start is refused while one exists and two agents never race over one working tree.
  - Every open copy of the mod polls every recorded worker through shared state, so a run that finishes while another repository is selected still closes its toast and terminal. The worker state is read from shared state each time (never cached per copy). Only the copy that wins `claimTreeAgent` for that checkout reports the outcome, so one run yields one toast. A poll lease (`pollUntil`) lets one copy query each session per interval. A failure detected by a hidden copy or another repository stops the spinner, reports the error, and leaves the retry picker for the visible view of that checkout.
  - A hidden copy skips its 10 s git refresh; the visibility watcher refreshes it when it is shown again.
- **Working Tree Inspection**:
  - Inspects uncommitted changes via `git status --porcelain=v1 -z --no-renames --untracked-files=all` and diff stats.
  - Displays a top "WIP" row with `+add` / `−del` badges connected directly to HEAD in lane 0.
  - Inspects modified, added, deleted, and untracked files; each diff opens in its own tab.
  - Right-clicking the WIP row opens a context menu: **Stash All Changes…** (optional message, include-untracked toggle), **Stash Staged Changes…**, and **Unstash Latest…** when a stash exists.
  - `git stash list` is loaded on every refresh. The branch dropdown lists every stash, so an unstash stays reachable after the dirty row disappears; choosing one runs `git stash pop --index` after confirmation.
- **Docked Panel Mode**:
  - `props: { panel: true }` renders the graph as the Files-style card inside a layout panel, such as Herdr's Changes slot.
  - The toolbar stays compact: the brand text is dropped, the branch selector flexes into the free width, and an expand button opens the same repository full size in a tab.
- **Commit Details Tree View & Diff Tabs**:
  - Changed files use a VS Code Source Control-style tree: a fixed **Changes** header with a count badge and collapse-all chevron, nested folder rows with indent guide lines, and the Material folder icon.
  - File rows show the full-color Material Icon Theme icon chosen by exact name or extension (`fileIconPath` in `git-logic.js`), using `_light` variants on light themes, with the porcelain status letter (`M`/`A`/`D`/`U`) on the right. This matches the `herdr-file-editor` icon pattern; icons live in `mods/git-graph/icons/` under the Material Icon Theme MIT license (`icons/LICENSE.txt`).
  - Hovering a file row reveals an **Open in file editor** button beside its name. The slot stays reserved so names never shift; it opens the current file in the optional `file-editor` mod and reuses that mod's live tab from `shared("file-editor.openTabs")`. Without the mod the button is disabled, its tooltip names the missing dependency, and clicking it posts the install hint instead of opening an unusable tab.
  - Right-clicking a file row opens a file context menu with **Show Diff**, **Show File**, and **Copy File Path**. Show File follows the same `file-editor` availability rule (disabled with the install hint when missing); Copy File Path copies the absolute path built by `resolveRepoPath`.
  - The diff tab header also shows the file's Material icon instead of the generic tinted glyph.
  - Folders with changes are expanded by default; the header collapses or expands all of them. File rows show colored `+added` / `−deleted` counts (green/red) beside the status; untracked files get their line count from `wc -l` so they show `+N` too.
  - The bottom details pane is a native `v_resizable` split: drag its top divider to trade height between the commit list and the file tree, and the size is kept across repaints.
  - The commit message wraps and grows to its content, up to 200px (150px in compact mode), then scrolls instead of clipping the description.
  - Clicking any file opens its diff in a dedicated Herdr tab (`Diff · <file>`) rendered with `v_virtual_list`: old/new line gutters, `+`/`−` backgrounds from `t.ansi2`/`t.ansi1`, styled hunk headers, and horizontal scrolling for long lines.
  - The toolbar switches between **Inline** (unified), **Split** (side by side) and **Stacked** (old above new). The choice persists in `shared("git-graph.diffView")`. Both split panes use one `VirtualListScrollHandle`, so vertical scrolling stays in lockstep while each pane keeps its own horizontal scrollbar.
  - **Wrap** toggles soft wrapping for long lines in every layout and persists in `shared("git-graph.diffWrap")`. Wrapped lines are expanded by `wrapInlineRows` / `wrapSplitRows` into consecutive 22px display rows, so both panes stay aligned; line numbers stay on the first chunk, and syntax spans plus intra-line change ranges carry into continuations. The diff tab's own `on_size_change` feeds `this.width`, which sets the wrap column count.
  - `git-logic.js` pairs each removed line with its added counterpart and computes character-level change ranges (`intraLineDiff`): word-level LCS first, character refinement inside changed words, and a whole-middle fallback for rewrites. `lineSegments` overlays those ranges on the syntax spans, which the renderer paints with a stronger `ansi1`/`ansi2` background.
  - A diff tab is a second mode of the same mod (`props: { folder, diffFile, diffKind: "worktree" | "commit", diffHash?, on?, diffView?, diffWrap? }`). Clicking a file already open by name selects that tab instead of duplicating it.
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

## Tests

Run the test suite:

```sh
node --test test/
```

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
