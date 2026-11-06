// Pure logic functions for Git Graph: ref parsing, topological DAG lane calculation,
// file tree construction, and diff line formatting.

/**
 * Resolves the effective repository root given the currently loaded root and a candidate cwd.
 * If cwd is inside currentRoot, currentRoot is preserved so subdirectories don't trigger
 * an unnecessary repository reload. Otherwise, cwd is returned so switching spaces or
 * repositories changes the location key immediately.
 *
 * @param {string | null | undefined} currentRoot
 * @param {string | null | undefined} cwd
 * @returns {string | null}
 */
export function computeEffectiveRoot(currentRoot, cwd) {
  if (!cwd) return null;
  if (currentRoot && (cwd === currentRoot || cwd.startsWith(currentRoot + "/"))) {
    return currentRoot;
  }
  return cwd;
}

/**
 * Determines whether a target node is currently visible in a layout tree,
 * accounting for hidden ancestors and stack active selections.
 *
 * @param {any} root
 * @param {string | ((node: any) => boolean)} targetOrPredicate
 * @returns {boolean}
 */
export function isLayoutNodeVisible(root, targetOrPredicate) {
  if (!root) return true;
  const match =
    typeof targetOrPredicate === "function"
      ? targetOrPredicate
      : (node) => node?.id === targetOrPredicate || node?.content?.mod === targetOrPredicate;

  function findPath(node, path) {
    if (match(node)) return [...path, node];
    for (const child of node?.children ?? []) {
      const res = findPath(child, [...path, node]);
      if (res) return res;
    }
    return null;
  }

  const path = findPath(root, []);
  if (!path) return true;

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    if (node.hidden) return false;
    if (node.type === "stack" && i + 1 < path.length) {
      const activeId = node.active ?? node.children?.[0]?.id;
      if (activeId && activeId !== path[i + 1].id) return false;
    }
  }
  return true;
}

export function countLines(text) {
  return text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
}

export function formatRelativeTime(epochSec, short = false) {
  if (!epochSec) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - epochSec;
  const suffix = short ? "" : " ago";
  if (diff < 60) return short ? "now" : "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m${suffix}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h${suffix}`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d${suffix}`;
  const date = new Date(epochSec * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function getLaneColor(idx, t) {
  const palette = [
    t.accent,
    t.ansi2,
    t.ansi4,
    t.ansi5,
    t.ansi3,
    t.ansi6,
    t.ansi1,
    t.working,
    t.done,
  ].filter(Boolean);
  return palette[Math.abs(idx) % palette.length] || t.accent || "#3b82f6";
}

export function getStatusColor(status, t) {
  switch (status) {
    case "A":
      return t.ansi2;
    case "D":
      return t.ansi1;
    case "U":
      return t.ansi3;
    case "M":
    default:
      return t.ansi4;
  }
}

/**
 * Whether a `#rgb` / `#rrggbb` color is light enough to need dark ink.
 * Used to pick the toast spinner that contrasts with the theme's popover.
 *
 * @param {string | null | undefined} value
 * @returns {boolean}
 */
export function isLightColor(value) {
  const raw = String(value || "").trim().replace(/^#/, "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return true;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(full.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

/**
 * Icons by exact file name (Git, lock and tool files), keyed by lowercase name.
 * Values are icon names from Material Icon Theme; the SVGs live in `icons/`.
 */
export const FILE_ICON_BY_NAME = {
  ".gitattributes": "git",
  ".gitignore": "git",
  ".gitkeep": "git",
  ".gitmodules": "git",
  "bun.lockb": "bun",
  "cargo.lock": "lock",
  "gemfile.lock": "ruby",
  "go.sum": "go-mod",
  dockerfile: "docker",
  ".dockerignore": "docker",
  makefile: "makefile",
  "package-lock.json": "nodejs",
  "pnpm-lock.yaml": "pnpm",
  "poetry.lock": "poetry",
  "yarn.lock": "yarn",
};

/**
 * Icons by lowercase extension, without the dot. Values are icon names from
 * Material Icon Theme; the SVGs live in `icons/`.
 */
export const FILE_ICON_BY_EXT = {
  "7z": "zip",
  a: "lib",
  avi: "video",
  avif: "image",
  bash: "console",
  bat: "console",
  bin: "hex",
  bmp: "image",
  bz2: "zip",
  c: "c",
  cc: "cpp",
  cer: "certificate",
  cfg: "settings",
  cjs: "javascript",
  class: "javaclass",
  clj: "clojure",
  cmd: "console",
  conf: "settings",
  config: "settings",
  cpp: "cpp",
  crt: "certificate",
  cs: "csharp",
  css: "css",
  csv: "table",
  cxx: "cpp",
  dart: "dart",
  db: "database",
  dll: "dll",
  doc: "word",
  docx: "word",
  dylib: "dll",
  editorconfig: "settings",
  erl: "erlang",
  ex: "elixir",
  exe: "exe",
  exs: "elixir",
  fish: "console",
  flac: "audio",
  gif: "image",
  go: "go",
  gz: "zip",
  h: "h",
  hpp: "hpp",
  hs: "haskell",
  htm: "html",
  html: "html",
  ico: "image",
  ini: "settings",
  jar: "jar",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "react",
  key: "key",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lock: "lock",
  log: "log",
  lua: "lua",
  m4a: "audio",
  markdown: "markdown",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mkv: "video",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  o: "exe",
  odt: "word",
  ogg: "audio",
  pages: "document",
  pdf: "pdf",
  pem: "key",
  php: "php",
  pl: "prolog",
  png: "image",
  properties: "settings",
  ps1: "powershell",
  py: "python",
  pyc: "python-misc",
  r: "r",
  rar: "zip",
  rb: "ruby",
  rs: "rust",
  rst: "markdown",
  rtf: "word",
  sass: "sass",
  scala: "scala",
  scss: "sass",
  sh: "console",
  so: "dll",
  sql: "database",
  sqlite: "database",
  sqlite3: "database",
  styl: "stylus",
  svelte: "svelte",
  svg: "svg",
  swift: "swift",
  tar: "zip",
  text: "document",
  tgz: "zip",
  tif: "image",
  tiff: "image",
  toml: "toml",
  ts: "typescript",
  tsv: "table",
  tsx: "react_ts",
  txt: "document",
  vue: "vue",
  wasm: "webassembly",
  wav: "audio",
  webm: "video",
  webp: "image",
  xhtml: "html",
  xls: "table",
  xlsx: "table",
  xml: "xml",
  xz: "zip",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zip: "zip",
  zsh: "console",
};

/** Icons that have a light-background variant (`<name>_light.svg`). */
const FILE_ICON_LIGHT = new Set(["bun", "pnpm", "toml"]);

/** Generic icon for files whose type is unknown. */
export const FILE_ICON_DEFAULT = "document";

/** Folder icon, relative to the Herdr app folder. */
export const FOLDER_ICON_PATH = "mods/git-graph/icons/folder-base.svg";

/**
 * Chooses the icon for a file by its name: exact names first (Git and lock files,
 * `.env` variants), then the extension. Unknown files get the generic icon. On a
 * light background the `_light` variant is used when the icon provides one.
 *
 * @param {string} fileName Base name only.
 * @param {boolean} [light=false] True when the theme background is light.
 * @returns {string} Path to the SVG, relative to the Herdr app folder.
 */
export function fileIconPath(fileName, light = false) {
  const name = typeof fileName === "string" ? fileName : "";
  const lower = name.toLowerCase();
  let icon = FILE_ICON_DEFAULT;
  if (lower === ".env" || lower.startsWith(".env.")) {
    icon = "tune";
  } else if (FILE_ICON_BY_NAME[lower]) {
    icon = FILE_ICON_BY_NAME[lower];
  } else {
    const dot = lower.lastIndexOf(".");
    const ext = dot > 0 ? lower.slice(dot + 1) : "";
    if (FILE_ICON_BY_EXT[ext]) icon = FILE_ICON_BY_EXT[ext];
  }
  const variant = light && FILE_ICON_LIGHT.has(icon) ? `${icon}_light` : icon;
  return `mods/git-graph/icons/${variant}.svg`;
}

/** Herdr mod that renders a file in its own tab. */
export const FILE_EDITOR_MOD = "file-editor";

/** Message shown when the file-editor mod is not installed. */
export const FILE_EDITOR_INSTALL_HINT =
  "Install the file-editor mod to open files in the editor.";

/**
 * Resolves the tab that should show a file in the file-editor mod.
 *
 * Reuses the live file-editor tab recorded in `shared("file-editor.openTabs")`
 * when it still exists. Otherwise derives a collision-free tab name following
 * the file-editor naming rules (base name, then containing directory or
 * repository name, then a numeric suffix), so both mods agree on which tab
 * belongs to which file.
 *
 * @param {string | null | undefined} root
 * @param {string | null | undefined} file
 * @param {Array<{ id: string, name: string, settled?: boolean }>} [activeTabs=[]]
 * @param {Record<string, { tabId?: string, tabName?: string, root?: string | null, file?: string }>} [openTabs={}]
 * @param {Set<string> | string[] | null} [fileEditorTabIds=null] Live tab ids known to host the file-editor mod.
 * @returns {{ existingTabId: string | null, tabName: string, fileKey: string, entry: Record<string, any> | null }}
 */
export function fileEditorTabTarget(
  root,
  file,
  activeTabs = [],
  openTabs = {},
  fileEditorTabIds = null
) {
  const normFile = typeof file === "string" ? file.replace(/\\/g, "/").replace(/^\/+/, "") : "";
  const normRoot = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const fileKey = normRoot ? `${normRoot}/${normFile}` : normFile;

  if (!normFile) {
    return { existingTabId: null, tabName: "File", fileKey, entry: null };
  }

  const liveTabs = Array.isArray(activeTabs)
    ? activeTabs.filter((tab) => tab && !tab.settled)
    : [];
  const editorIds =
    fileEditorTabIds instanceof Set
      ? fileEditorTabIds
      : new Set(Array.isArray(fileEditorTabIds) ? fileEditorTabIds : []);
  const isFileEditorTab = (tab) => editorIds.size === 0 || editorIds.has(tab.id);
  const map = openTabs && typeof openTabs === "object" ? openTabs : {};
  const recorded = map[fileKey];

  if (recorded && typeof recorded === "object") {
    const matched = liveTabs.find((tab) => {
      if (!isFileEditorTab(tab)) return false;
      if (typeof recorded.tabId === "string" && recorded.tabId.length > 0) {
        return tab.id === recorded.tabId;
      }
      return (
        typeof recorded.tabName === "string" &&
        recorded.tabName.length > 0 &&
        tab.name === recorded.tabName
      );
    });
    if (matched) {
      return {
        existingTabId: matched.id,
        tabName: matched.name,
        fileKey,
        entry: {
          ...recorded,
          root: normRoot || null,
          file: normFile,
          tabId: matched.id,
          tabName: matched.name,
        },
      };
    }
  }

  const base = normFile.split("/").pop() || "File";
  const hasCollision = (name) => liveTabs.some((tab) => tab.name === name);
  let tabName = base;

  if (hasCollision(tabName)) {
    const dir = normFile.includes("/") ? normFile.slice(0, normFile.lastIndexOf("/")) : "";
    const rootBase = normRoot.split("/").filter(Boolean).pop() || "";
    const candidate = dir || (rootBase ? `${rootBase}/${base}` : base);
    if (!hasCollision(candidate)) {
      tabName = candidate;
    } else {
      let n = 2;
      while (hasCollision(`${candidate} (${n})`)) n++;
      tabName = `${candidate} (${n})`;
    }
  }

  return {
    existingTabId: null,
    tabName,
    fileKey,
    entry: { root: normRoot || null, file: normFile, tabName },
  };
}

/**
 * Builds the absolute path of a repository-relative file. Separators are
 * normalized to forward slashes, and a trailing root slash is not doubled.
 *
 * @param {string | null | undefined} root
 * @param {string | null | undefined} file
 * @returns {string}
 */
export function resolveRepoPath(root, file) {
  const normRoot = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const normFile = typeof file === "string" ? file.replace(/\\/g, "/").replace(/^\/+/, "") : "";
  if (!normRoot) return normFile;
  return normFile ? `${normRoot}/${normFile}` : normRoot;
}

/**
 * Parses decorated ref strings produced by `git log --decorate=full --format=%D`.
 * Correctly distinguishes local branches with slashes (e.g. refs/heads/feat/foo)
 * from remote branches (refs/remotes/origin/...) and filters out symbolic refs (origin/HEAD).
 *
 * @param {string} refStr
 * @returns {Array<{ kind: "head" | "local" | "remote" | "tag", text: string }>}
 */
export function parseRefs(refStr) {
  if (!refStr) return [];
  const clean = refStr.trim().replace(/^\(/, "").replace(/\)$/, "").trim();
  if (!clean) return [];
  const items = clean.split(", ");
  /** @type {Array<{ kind: "head" | "local" | "remote" | "tag", text: string }>} */
  const badges = [];

  for (const rawItem of items) {
    const item = rawItem.trim();
    if (!item) continue;

    // HEAD pointing to local branch
    if (item.includes("HEAD -> refs/heads/")) {
      badges.push({ kind: "head", text: "HEAD" });
      const branch = item.replace("HEAD -> refs/heads/", "").trim();
      badges.push({ kind: "local", text: branch });
      continue;
    }

    // HEAD pointing to remote branch
    if (item.includes("HEAD -> refs/remotes/")) {
      badges.push({ kind: "head", text: "HEAD" });
      const remote = item.replace("HEAD -> refs/remotes/", "").trim();
      if (!remote.endsWith("/HEAD") && remote !== "HEAD") {
        badges.push({ kind: "remote", text: remote });
      }
      continue;
    }

    // Generic HEAD pointer (non-full fallback)
    if (item.includes("HEAD -> ")) {
      badges.push({ kind: "head", text: "HEAD" });
      const branch = item.replace("HEAD -> ", "").trim();
      badges.push({ kind: "local", text: branch });
      continue;
    }

    if (item === "HEAD") {
      badges.push({ kind: "head", text: "HEAD" });
      continue;
    }

    // Tags
    if (item.startsWith("tag: refs/tags/")) {
      badges.push({ kind: "tag", text: item.slice("tag: refs/tags/".length).trim() });
      continue;
    }
    if (item.startsWith("refs/tags/")) {
      badges.push({ kind: "tag", text: item.slice("refs/tags/".length).trim() });
      continue;
    }
    if (item.startsWith("tag: ")) {
      badges.push({ kind: "tag", text: item.slice(5).trim() });
      continue;
    }

    // Remote branches (e.g. refs/remotes/origin/main, refs/remotes/origin/feat/foo)
    if (item.startsWith("refs/remotes/")) {
      const remote = item.slice("refs/remotes/".length).trim();
      // Hide symbolic HEAD refs like origin/HEAD
      if (!remote.endsWith("/HEAD") && remote !== "HEAD") {
        badges.push({ kind: "remote", text: remote });
      }
      continue;
    }

    // Local branches (e.g. refs/heads/main, refs/heads/feat/test-slash)
    if (item.startsWith("refs/heads/")) {
      badges.push({ kind: "local", text: item.slice("refs/heads/".length).trim() });
      continue;
    }

    // Fallbacks for non-full decorate
    if (item.startsWith("origin/") || item.startsWith("upstream/")) {
      if (!item.endsWith("/HEAD") && item !== "HEAD") {
        badges.push({ kind: "remote", text: item });
      }
      continue;
    }

    badges.push({ kind: "local", text: item });
  }

  return badges;
}

/**
 * Resolves raw parsed refs into display refs:
 * 1. Folds HEAD into the checked-out branch pill (marked with isHead: true).
 * 2. Pairs local branches with matching remotes (e.g. main | origin).
 *
 * @param {Array<{ kind: "head" | "local" | "remote" | "tag", text: string }>} refs
 * @returns {Array<any>}
 */
export function resolveDisplayRefs(refs) {
  if (!refs || refs.length === 0) return [];
  const folded = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (ref.kind !== "head") {
      folded.push(ref);
      continue;
    }
    const next = refs[i + 1];
    if (next && next.kind === "local") {
      folded.push({ ...next, isHead: true });
      i++;
    } else {
      folded.push(ref);
    }
  }

  const pairedRemoteTexts = new Set();
  const pairByLocal = new Map();
  for (const ref of folded) {
    if (ref.kind !== "local") continue;
    const remote = folded.find(
      (r) => r.kind === "remote" && !pairedRemoteTexts.has(r.text) && r.text.endsWith("/" + ref.text)
    );
    if (remote) {
      pairedRemoteTexts.add(remote.text);
      pairByLocal.set(ref.text, remote);
    }
  }

  const displayRefs = [];
  for (const ref of folded) {
    if (ref.kind === "remote" && pairedRemoteTexts.has(ref.text)) continue;
    displayRefs.push(
      ref.kind === "local" && pairByLocal.has(ref.text)
        ? { ...ref, pairedRemote: pairByLocal.get(ref.text) }
        : ref
    );
  }
  return displayRefs;
}

/**
 * Computes the full text tooltip for a ref badge. A branch checked out in a
 * linked worktree says so and names that checkout's path.
 *
 * @param {{ kind?: string, text?: string, pairedRemote?: { text: string }, isWorktree?: boolean, worktreePath?: string | null }} ref
 * @returns {string}
 */
export function badgeTooltip(ref) {
  if (!ref) return "";
  if (ref.kind === "head") return "HEAD";
  const label = ref.pairedRemote ? `${ref.text} | ${ref.pairedRemote.text}` : ref.text || "";
  if (!ref.isWorktree) return label;
  return ref.worktreePath
    ? `${label} · worktree branch at ${ref.worktreePath}`
    : `${label} · worktree branch`;
}

/**
 * Computes the tooltip for an overflow "+N" refs badge.
 *
 * @param {Array<{ kind?: string, text?: string, pairedRemote?: { text: string } }>} extraRefs
 * @returns {string}
 */
export function extraRefsTooltip(extraRefs) {
  if (!extraRefs || !extraRefs.length) return "";
  return extraRefs.map(badgeTooltip).join(", ");
}

/**
 * Parses raw git log output formatted with Unit Separator (%x1f).
 *
 * @param {string} stdout
 * @returns {Array<any>}
 */
export function parseCommitLog(stdout) {
  if (!stdout || !stdout.trim()) return [];
  const rawLines = stdout.trim().split("\n").filter(Boolean);
  const commits = [];
  for (const line of rawLines) {
    const parts = line.split("\x1f");
    if (parts.length < 7) continue;
    const [hash, parentStr, author, email, timestamp, refStr, ...subjectParts] = parts;
    const subject = subjectParts.join("\x1f");
    const parents = parentStr ? parentStr.trim().split(" ").filter(Boolean) : [];
    const refs = parseRefs(refStr);
    const displayRefs = resolveDisplayRefs(refs);
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      author,
      email,
      timestamp: parseInt(timestamp, 10) || 0,
      subject,
      refs,
      displayRefs,
      isHead: refs.some((r) => r.kind === "head"),
    });
  }
  return commits;
}

/**
 * Computes topological DAG lanes for commits with stable line colors.
 * Keeps each branch line's color index consistent throughout its lifetime.
 * Outgoing connections to parents outside the loaded set terminate cleanly at row edge.
 *
 * @param {Array<any>} commits
 * @returns {number} maxGlobalLane
 */
export function computeLanes(commits) {
  let activeLanes = [];
  let activeLaneColors = [];
  let nextColorIdx = 0;
  let maxGlobalLane = 0;
  const commitHashes = new Set(commits.map((c) => c.hash));
  // Edges leaving the previous row, waiting to learn where they land in this one.
  let pending = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const hash = commit.hash;
    const parents = commit.parents || [];

    // Find all indices in activeLanes where activeLanes[l] === commit.hash
    const matchingLanes = [];
    for (let l = 0; l < activeLanes.length; l++) {
      if (activeLanes[l] === hash) {
        matchingLanes.push(l);
      }
    }

    let lane;
    let colorIdx;
    if (matchingLanes.length > 0) {
      lane = matchingLanes[0];
      colorIdx = activeLaneColors[lane] ?? nextColorIdx++;
      commit.fromChild = true;
      commit.convergingLanes = matchingLanes.slice(1).map((cLane) => ({
        lane: cLane,
        colorIdx: activeLaneColors[cLane] ?? cLane,
      }));
      // Clear matching lanes
      for (const m of matchingLanes) {
        activeLanes[m] = null;
        activeLaneColors[m] = null;
      }
    } else {
      const firstNull = activeLanes.indexOf(null);
      if (firstNull === -1) {
        lane = activeLanes.length;
        activeLanes.push(null);
        activeLaneColors.push(null);
      } else {
        lane = firstNull;
      }
      colorIdx = nextColorIdx++;
      commit.fromChild = false;
      commit.convergingLanes = [];
    }

    commit.lane = lane;
    commit.colorIdx = colorIdx;

    // Resolve the edges crossing the boundary above this row. An edge that
    // carries this commit's hash lands on its node; any other keeps its slot.
    // Each edge is drawn as one S-curve from the previous node row to this
    // one: the upper half in the previous row, the lower half here.
    commit.edgesUp = pending.map((e) => ({
      from: e.from,
      to: e.hash === hash ? lane : e.slot,
      colorIdx: e.colorIdx,
      fromWorkingTree: e.fromWorkingTree,
    }));
    if (i > 0) commits[i - 1].edgesDown = commit.edgesUp;

    // Pass-through lanes: lanes that continue across this commit row
    commit.passThroughLanes = [];
    for (let l = 0; l < activeLanes.length; l++) {
      if (activeLanes[l] !== null && l !== lane) {
        commit.passThroughLanes.push({
          lane: l,
          colorIdx: activeLaneColors[l] ?? l,
        });
      }
    }

    // Process parents
    commit.parentConnections = [];
    for (let pIdx = 0; pIdx < parents.length; pIdx++) {
      const pHash = parents[pIdx];
      const parentExists = commitHashes.has(pHash);

      if (!parentExists) {
        // Parent is outside the current filtered view or reachability.
        // Render an outgoing connector that gracefully terminates at the row edge.
        commit.parentConnections.push({
          toLane: lane,
          colorIdx: colorIdx,
          parentHash: pHash,
          terminated: true,
        });
        continue;
      }

      const existingLane = activeLanes.indexOf(pHash);
      if (existingLane !== -1) {
        commit.parentConnections.push({
          toLane: existingLane,
          colorIdx: activeLaneColors[existingLane] ?? existingLane,
          parentHash: pHash,
          terminated: false,
        });
      } else {
        if (pIdx === 0 && activeLanes[lane] === null) {
          activeLanes[lane] = pHash;
          activeLaneColors[lane] = colorIdx; // retain stream color
          commit.parentConnections.push({
            toLane: lane,
            colorIdx: colorIdx,
            parentHash: pHash,
            terminated: false,
          });
        } else {
          // A side branch (or branch whose direct lane is unavailable) must not reuse
          // the commit's own lane, which would cause an abrupt color switch on a straight rail.
          let newLane = -1;
          for (let l = 0; l < activeLanes.length; l++) {
            if (activeLanes[l] === null && l !== lane) {
              newLane = l;
              break;
            }
          }
          const newColor = pIdx === 0 ? colorIdx : nextColorIdx++;
          if (newLane === -1) {
            newLane = activeLanes.length;
            activeLanes.push(pHash);
            activeLaneColors.push(newColor);
          } else {
            activeLanes[newLane] = pHash;
            activeLaneColors[newLane] = newColor;
          }
          commit.parentConnections.push({
            toLane: newLane,
            colorIdx: newColor,
            parentHash: pHash,
            terminated: false,
          });
        }
      }
    }

    // Trim trailing nulls
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
      activeLaneColors.pop();
    }

    // Edges leaving this row: every pass-through rail plus every live parent link.
    pending = [
      ...commit.passThroughLanes.map((p) => ({
        from: p.lane,
        slot: p.lane,
        hash: activeLanes[p.lane],
        colorIdx: p.colorIdx,
      })),
      // A first-parent edge keeps this commit's color even when it bends into
      // another lane, so a side branch rejoins its base in its own color.
      ...commit.parentConnections
        .filter((c) => !c.terminated)
        .map((c) => ({
          from: lane,
          slot: c.toLane,
          hash: c.parentHash,
          colorIdx: c.parentHash === parents[0] ? colorIdx : c.colorIdx,
          fromWorkingTree: !!commit.isWorkingTree,
        })),
    ];
    commit.edgesDown = [];

    const rowMax = Math.max(
      lane,
      ...commit.passThroughLanes.map((p) => p.lane),
      ...commit.convergingLanes.map((c) => c.lane),
      ...commit.parentConnections.map((c) => c.toLane),
      0
    );
    if (rowMax > maxGlobalLane) maxGlobalLane = rowMax;
    commit.maxLaneAtRow = rowMax;
  }
  // A view cut by pagination leaves the last row's edges running off the bottom.
  const last = commits[commits.length - 1];
  if (last) {
    last.edgesDown = pending.map((e) => ({
      from: e.from,
      to: e.slot,
      colorIdx: e.colorIdx,
      fromWorkingTree: e.fromWorkingTree,
    }));
  }

  return maxGlobalLane;
}

/**
 * Builds a hierarchical tree from a flat list of files with changed paths.
 */
export function buildFileTree(files) {
  const root = { isDir: true, path: "", name: "", children: new Map(), add: 0, del: 0 };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join("/");
      if (!current.children.has(part)) {
        current.children.set(part, {
          isDir: true,
          path: dirPath,
          name: part,
          children: new Map(),
          add: 0,
          del: 0,
        });
      }
      const dirNode = current.children.get(part);
      dirNode.add += file.add || 0;
      dirNode.del += file.del || 0;
      current = dirNode;
    }
    const fileName = parts[parts.length - 1];
    current.children.set(fileName, {
      isDir: false,
      path: file.path,
      name: fileName,
      file,
      add: file.add || 0,
      del: file.del || 0,
      status: file.status || "M",
    });
    root.add += file.add || 0;
    root.del += file.del || 0;
  }

  return root;
}

/**
 * Flattens the file tree into rows for display, sorting folders first then files alphabetically.
 */
export function flattenFileTree(node, depth, collapsedFolders, rows = []) {
  const entries = Array.from(node.children.values());
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (entry.isDir) {
      const isExpanded = !collapsedFolders.has(entry.path);
      rows.push({
        isDir: true,
        path: entry.path,
        name: entry.name,
        depth,
        isExpanded,
        add: entry.add,
        del: entry.del,
      });
      if (isExpanded) {
        flattenFileTree(entry, depth + 1, collapsedFolders, rows);
      }
    } else {
      rows.push({
        isDir: false,
        path: entry.path,
        name: entry.name,
        depth,
        file: entry.file,
        status: entry.status,
        add: entry.add,
        del: entry.del,
      });
    }
  }

  return rows;
}

/**
 * Parses a unified diff into the rows the diff tab draws.
 *
 * File headers (`diff --git`, `index`, `---`, `+++`, mode/rename lines) are
 * dropped: the tab header already names the file. Hunk headers become their
 * own row, and every line carries the old and new line numbers so the view can
 * show both gutters.
 *
 * @param {string} text
 * @returns {Array<{ kind: "@" | "+" | "-" | " " | "\\" | "", text: string, oldNum?: number, newNum?: number }>}
 */
export function diffRows(text) {
  /** @type {Array<any>} */
  const rows = [];
  let oldNum = 0;
  let newNum = 0;
  let inHunk = false;
  const clip = (line) => (line.length > 4000 ? line.slice(0, 4000) + "…" : line);

  for (const raw of text.split("\n")) {
    if (
      raw.startsWith("diff --git ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file mode ") ||
      raw.startsWith("deleted file mode ") ||
      raw.startsWith("old mode ") ||
      raw.startsWith("new mode ") ||
      raw.startsWith("similarity index ") ||
      raw.startsWith("dissimilarity index ") ||
      raw.startsWith("rename from ") ||
      raw.startsWith("rename to ") ||
      raw.startsWith("Binary files ")
    ) {
      continue;
    }

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      inHunk = true;
      oldNum = Number(hunk[1]);
      newNum = Number(hunk[2]);
      rows.push({ kind: "@", text: clip(raw) });
      continue;
    }

    if (!inHunk) continue;
    if (raw.startsWith("\\")) {
      rows.push({ kind: "\\", text: clip(raw) });
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "-", oldNum: oldNum++, text: clip(raw.slice(1)) });
    } else if (raw.startsWith("+")) {
      rows.push({ kind: "+", newNum: newNum++, text: clip(raw.slice(1)) });
    } else if (raw.startsWith(" ")) {
      rows.push({ kind: " ", oldNum: oldNum++, newNum: newNum++, text: clip(raw.slice(1)) });
    } else if (raw) {
      rows.push({ kind: "", text: clip(raw) });
    }
  }

  return rows;
}

/**
 * Builds safe arguments for git tag.
 * Ensures --end-of-options precedes the user-provided name.
 */
export function tagArgs(name, msg, hash) {
  if (msg) {
    return ["tag", "-a", "-m", msg, "--end-of-options", name, hash];
  }
  return ["tag", "--end-of-options", name, hash];
}

/**
 * Builds safe arguments for git log.
 * Ensures options like --all precede --end-of-options, and -- terminates ref.
 */
export function logArgs(branchFilter, commitLimit = 500) {
  const args = [
    "log",
    "--topo-order",
    "--decorate=full",
    "-n",
    String(commitLimit),
    "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s",
  ];
  if (branchFilter === "all") {
    // `--exclude` only applies to refs listed after it. `--all` includes
    // refs/stash, whose WIP/index/untracked commits are internal stash
    // plumbing rather than branch history, so keep them out of the graph.
    args.push("--exclude=refs/stash", "--all", "--");
  } else if (branchFilter === "current") {
    args.push("--end-of-options", "HEAD", "--");
  } else {
    args.push("--end-of-options", branchFilter, "--");
  }
  return args;
}

/**
 * Splits a remote branch reference name (e.g. "origin/main", "origin/feat/nested", "upstream/dev")
 * into its remote and branch components based on configured remotes or the first slash.
 *
 * @param {string} refText
 * @param {string[]} [remotes=[]]
 * @returns {{ remote: string, branch: string }}
 */
export function splitRemoteBranch(refText, remotes = []) {
  if (!refText) return { remote: "origin", branch: "" };
  const sortedRemotes = Array.isArray(remotes)
    ? remotes.slice().sort((a, b) => b.length - a.length)
    : [];
  for (const r of sortedRemotes) {
    if (refText.startsWith(`${r}/`)) {
      return { remote: r, branch: refText.slice(r.length + 1) };
    }
  }
  const slashIdx = refText.indexOf("/");
  if (slashIdx !== -1) {
    return {
      remote: refText.slice(0, slashIdx),
      branch: refText.slice(slashIdx + 1),
    };
  }
  return { remote: "origin", branch: refText };
}

/**
 * Builds safe arguments for deleting a remote branch via `git push`.
 *
 * @param {string} remote
 * @param {string} branch
 * @returns {string[]}
 */
export function deleteRemoteBranchArgs(remote, branch) {
  return ["push", remote, "--delete", "--end-of-options", branch];
}

/**
 * Refreshes one remote-tracking ref before it is renamed, so a stale local view
 * can never make the rename drop remote-only commits when the old branch is
 * deleted.
 *
 * @param {string} remote
 * @param {string} branch
 * @returns {string[]}
 */
export function fetchRemoteBranchArgs(remote, branch) {
  return [
    "fetch",
    remote,
    "--end-of-options",
    `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
  ];
}

/**
 * Builds the refspec that recreates a remote branch under a new name before
 * the old name is deleted. Git cannot rename a remote branch in place, so the
 * refreshed remote-tracking ref is pushed to the new name first; this preserves
 * the remote content instead of uploading unpushed local commits.
 *
 * @param {string} remote
 * @param {string} oldBranch
 * @param {string} newBranch
 * @returns {string[]}
 */
export function renameRemoteBranchPushArgs(remote, oldBranch, newBranch) {
  const source = `refs/remotes/${remote}/${oldBranch}`;
  return ["push", remote, "--end-of-options", `${source}:refs/heads/${newBranch}`];
}

// --- Git worktrees ------------------------------------------------------

/**
 * Optional Herdr mod (space-actions repo) that owns worktree create, open, and
 * remove. Worktree switching and removal appear only while its manifest exists.
 */
export const SPACE_ACTIONS_MOD = "worktree-plus";

/**
 * Normalises a checkout path for comparison: forward slashes and no trailing
 * slash, so the same folder compares equal however it was spelled.
 *
 * @param {string | null | undefined} path
 * @returns {string}
 */
export function normalizeCheckoutPath(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Parses `git worktree list --porcelain`. Records are separated by blank lines
 * and each starts with a `worktree <path>` line. Bare and prunable records are
 * skipped, but the first record is always the main checkout, so a linked
 * checkout is never mistaken for it.
 *
 * @param {string} stdout
 * @returns {Array<{ path: string, branch: string | null, main: boolean }>}
 */
export function parseWorktreeList(stdout) {
  /** @type {Array<{ path: string, branch: string | null, bare: boolean, prunable: boolean }>} */
  const records = [];
  let current = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (line === "") {
      current = null;
    } else if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, bare: false, prunable: false };
      records.push(current);
    } else if (current) {
      if (line === "bare") current.bare = true;
      else if (line === "prunable" || line.startsWith("prunable ")) current.prunable = true;
      else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
    }
  }
  /** @type {Array<{ path: string, branch: string | null, main: boolean }>} */
  const checkouts = [];
  records.forEach((record, index) => {
    if (record.bare || record.prunable || !record.path) return;
    checkouts.push({ path: record.path, branch: record.branch, main: index === 0 });
  });
  return checkouts;
}

/**
 * Maps each local branch checked out in a linked worktree to that checkout's
 * path. The main checkout is left out: its branch is an ordinary branch.
 *
 * @param {Array<{ path: string, branch: string | null, main: boolean }>} checkouts
 * @returns {Map<string, string>}
 */
export function worktreeBranchMap(checkouts) {
  const branches = new Map();
  for (const checkout of checkouts ?? []) {
    if (!checkout.main && checkout.branch) branches.set(checkout.branch, checkout.path);
  }
  return branches;
}

/**
 * Finds the checkout, other than the current root, that holds a local branch.
 * Returns null when no other checkout has it.
 *
 * @param {Array<{ path: string, branch: string | null, main: boolean }>} checkouts
 * @param {string} branch
 * @param {string | null | undefined} currentRoot
 * @returns {{ path: string, branch: string | null, main: boolean } | null}
 */
export function findBranchCheckout(checkouts, branch, currentRoot) {
  if (!branch) return null;
  const here = normalizeCheckoutPath(currentRoot);
  return (
    (checkouts ?? []).find(
      (checkout) => checkout.branch === branch && normalizeCheckoutPath(checkout.path) !== here
    ) ?? null
  );
}

/**
 * Sets `isWorktree` and `worktreePath` on every local display ref whose branch
 * is checked out in a linked worktree. The refs are created per parse, so they
 * are updated in place and the badge renderer and tooltip read the flags.
 *
 * @param {Array<any>} commits
 * @param {Array<{ path: string, branch: string | null, main: boolean }>} checkouts
 * @returns {Array<any>} the same commits
 */
export function markWorktreeRefs(commits, checkouts) {
  const branches = worktreeBranchMap(checkouts);
  for (const commit of commits ?? []) {
    for (const ref of commit.displayRefs ?? []) {
      if (ref.kind !== "local") continue;
      const path = branches.get(ref.text);
      ref.isWorktree = path !== undefined;
      ref.worktreePath = path ?? null;
    }
  }
  return commits;
}

/**
 * Finds the Herdr space that shows a checkout. A space matches when its first
 * terminal (or, without one, its folder) sits inside the checkout path on the
 * same machine. A checkout nested inside this one keeps the terminals in it, and
 * a sibling that only shares a name prefix (/a/wt2 for /a/wt) never matches.
 *
 * @param {string} checkoutPath
 * @param {Array<any>} spaceList spaces() entries: { id, machine, tabs, folder }
 * @param {Array<any>} paneList panes() entries: { tab, cwd }
 * @param {string | null | undefined} on machine the repository lives on (null for this machine)
 * @param {string[]} [checkoutPaths=[]] every checkout path of the repository, to resolve nesting
 * @returns {any | null} the matching space, or null
 */
export function findCheckoutSpace(checkoutPath, spaceList, paneList, on, checkoutPaths = []) {
  const target = normalizeCheckoutPath(checkoutPath);
  if (!target) return null;
  const within = (path, dir) => path === dir || path.startsWith(dir + "/");
  const nested = (checkoutPaths ?? [])
    .map(normalizeCheckoutPath)
    .filter((path) => path !== target && within(path, target));
  const machine = on ?? null;
  const placeOf = (space) => {
    const tabIds = new Set((space.tabs ?? []).map((tab) => tab.id));
    const pane = (paneList ?? []).find((p) => tabIds.has(p.tab) && p.cwd);
    return normalizeCheckoutPath(pane ? pane.cwd : space.folder);
  };
  return (
    (spaceList ?? []).find((space) => {
      if ((space.machine ?? null) !== machine) return false;
      const at = placeOf(space);
      if (!at || !within(at, target)) return false;
      return !nested.some((dir) => within(at, dir));
    }) ?? null
  );
}

/**
 * Builds the check that decides whether a local branch is fully merged into
 * HEAD. Git exits 0 when it is merged and 1 when it is not; any other code means
 * the check itself failed. The ref is spelled out in full so a branch name can
 * never be read as an option.
 *
 * @param {string} branch
 * @returns {string[]}
 */
export function mergedCheckArgs(branch) {
  return ["merge-base", "--is-ancestor", "--end-of-options", `refs/heads/${branch}`, "HEAD"];
}

/**
 * Builds `git worktree remove` for one linked checkout. It is never forced: git
 * refuses a checkout with local changes, untracked files, or submodules, and the
 * caller keeps its dialog open with that error.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function removeWorktreeArgs(path) {
  return ["worktree", "remove", "--end-of-options", path];
}

// --- Diff syntax highlighting -------------------------------------------

const KEYWORDS = {
  js: new Set(
    "const let var function return if else for while do switch case break continue new class extends super this import export from default async await try catch finally throw typeof instanceof in of null undefined true false static get set yield delete void interface type enum implements readonly public private protected as satisfies keyof namespace declare abstract override using".split(" ")
  ),
  py: new Set(
    "def class return if elif else for while in not and or is None True False import from as try except finally raise with yield lambda pass break continue global nonlocal async await self match case".split(" ")
  ),
  go: new Set(
    "func package import var const type struct interface map chan go defer return if else for range switch case break continue select nil true false make new len cap append string int bool byte rune error float64 float32 int64 int32 uint uint64 uint32 any fallthrough goto".split(" ")
  ),
  rs: new Set(
    "fn let mut const struct enum impl trait use mod pub crate self Self super match if else loop while for in return break continue where async await move ref as dyn type unsafe extern true false None Some Ok Err static union".split(" ")
  ),
  sh: new Set(
    "if then else elif fi for while until do done case esac function in select time export local readonly return exit set unset shift source alias declare typeset break continue".split(" ")
  ),
  sql: new Set(
    "select from where join left right inner outer full on group by order having limit offset insert into values update set delete create table alter drop index view and or not null as distinct count sum avg min max union all case when then else end like in exists between is".split(" ")
  ),
  css: new Set(["none", "inherit", "initial", "unset", "revert", "auto", "transparent", "currentColor"]),
  data: new Set(["true", "false", "null", "yes", "no", "on", "off"]),
};

const LANGS = {
  js: { line: ["//"], block: ["/*", "*/"], quotes: ["'", '"', "`"], keywords: KEYWORDS.js, id: /[A-Za-z_$][\w$]*/y },
  css: {
    line: ["//"],
    block: ["/*", "*/"],
    quotes: ["'", '"'],
    keywords: KEYWORDS.css,
    css: true,
    id: /-{0,2}[A-Za-z_][\w-]*/y,
  },
  json: { quotes: ['"'], keywords: KEYWORDS.data, json: true, id: /[A-Za-z_$][\w$]*/y },
  py: { line: ["#"], quotes: ["'", '"'], keywords: KEYWORDS.py, id: /[A-Za-z_][\w]*/y },
  go: { line: ["//"], block: ["/*", "*/"], quotes: ["'", '"', "`"], keywords: KEYWORDS.go, id: /[A-Za-z_][\w]*/y },
  rs: { line: ["//"], block: ["/*", "*/"], quotes: ['"'], keywords: KEYWORDS.rs, id: /[A-Za-z_][\w]*/y },
  sh: { line: ["#"], quotes: ["'", '"'], keywords: KEYWORDS.sh, id: /[A-Za-z_][\w]*/y },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: ["'", '"'], keywords: KEYWORDS.sql, id: /[A-Za-z_][\w$]*/y, ci: true },
  yaml: { line: ["#"], quotes: ["'", '"'], keywords: KEYWORDS.data, key: ":", id: /[A-Za-z_][\w.-]*/y },
  toml: { line: ["#"], quotes: ["'", '"'], keywords: KEYWORDS.data, key: "=", id: /[A-Za-z_][\w.-]*/y },
  html: { block: ["<!--", "-->"], quotes: ["'", '"'], keywords: new Set(), html: true, id: /[A-Za-z_:][\w:.-]*/y },
  plain: { keywords: new Set(), id: /[A-Za-z_$][\w$]*/y },
};

const EXTENSION_LANG = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  css: "css", scss: "css", sass: "css", less: "css",
  json: "json", jsonc: "json", json5: "json",
  py: "py", pyi: "py",
  go: "go", rs: "rs",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  sql: "sql",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  html: "html", htm: "html", vue: "html", svelte: "html", xml: "html", svg: "html",
};

/** The highlighter family for a file path, by extension. */
export function languageOf(path) {
  const name = String(path ?? "");
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXTENSION_LANG[ext] ?? "plain";
}

/** Index of the closing quote, honouring backslash escapes, or -1. */
function closingQuote(text, from, quote) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

/**
 * Splits one line into coloured spans for a language.
 *
 * The scanner is deliberately small: comments, strings, numbers, keywords,
 * functions/types and (for CSS/YAML/TOML) keys and custom properties. Block
 * comments and template literals carry over into the next line through
 * `state`, so a multi-line comment is not repainted as code.
 *
 * @param {string} text
 * @param {string} language
 * @param {{ block?: boolean, quote?: string | null }} state
 * @returns {Array<{ text: string, kind: string }>}
 */
export function tokenizeLine(text, language, state) {
  const cfg = LANGS[language] ?? LANGS.plain;
  /** @type {Array<{ text: string, kind: string }>} */
  const spans = [];
  const add = (kind, value) => {
    if (value) spans.push({ text: value, kind });
  };

  let i = 0;
  let pending = null;

  // CSS declaration and YAML/TOML key: colour the leading name.
  if (cfg.css) {
    const m = /^(\s*)([A-Za-z-][\w-]*)(\s*):(?!:)/.exec(text);
    if (m) {
      add("plain", m[1]);
      add("property", m[2]);
      add("plain", m[3] + ":");
      i = m[0].length;
    }
  } else if (cfg.key) {
    const re = cfg.key === "=" ? /^(\s*)([A-Za-z_][\w.-]*)(\s*)=/ : /^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*)(\s*):(?!:)/;
    const m = re.exec(text);
    if (m) {
      add("plain", m[1]);
      add("property", m[2]);
      add("plain", m[3] + cfg.key);
      i = m[0].length;
    }
  }

  while (i < text.length) {
    if (state.block) {
      const end = cfg.block ? text.indexOf(cfg.block[1], i) : -1;
      if (end === -1) {
        add("comment", text.slice(i));
        i = text.length;
        break;
      }
      add("comment", text.slice(i, end + cfg.block[1].length));
      i = end + cfg.block[1].length;
      state.block = false;
      continue;
    }

    if (state.quote) {
      const end = closingQuote(text, i, state.quote);
      if (end === -1) {
        add("string", text.slice(i));
        i = text.length;
        break;
      }
      add("string", text.slice(i, end + 1));
      i = end + 1;
      state.quote = null;
      continue;
    }

    if (cfg.block && text.startsWith(cfg.block[0], i)) {
      const end = text.indexOf(cfg.block[1], i + cfg.block[0].length);
      if (end === -1) {
        add("comment", text.slice(i));
        state.block = true;
        i = text.length;
        break;
      }
      add("comment", text.slice(i, end + cfg.block[1].length));
      i = end + cfg.block[1].length;
      continue;
    }

    const lineComment = (cfg.line ?? []).find(
      (marker) => text.startsWith(marker, i) && (marker !== "#" || i === 0 || /[\s;([{,]/.test(text[i - 1]))
    );
    if (lineComment) {
      add("comment", text.slice(i));
      break;
    }

    if (cfg.css && text[i] === "@") {
      const m = /^@[\w-]+/.exec(text.slice(i));
      if (m) {
        add("keyword", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (cfg.css && text[i] === "#") {
      const m = /^#[0-9a-fA-F]{3,8}\b/.exec(text.slice(i));
      if (m) {
        add("number", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (cfg.quotes?.includes(text[i])) {
      const quote = text[i];
      const end = closingQuote(text, i + 1, quote);
      const value = end === -1 ? text.slice(i) : text.slice(i, end + 1);
      const after = end === -1 ? "" : text.slice(end + 1);
      let kind = "string";
      if (cfg.json && /^\s*:/.test(after)) kind = "property";
      else if (cfg.html && /^\s*=/.test(after)) kind = "property";
      add(kind, value);
      if (end === -1 && quote === "`") state.quote = quote;
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    if (/[0-9]/.test(text[i]) || (text[i] === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const m = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[a-zA-Z%]+)?/.exec(text.slice(i));
      if (m) {
        add("number", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (cfg.html && text[i] === "<") {
      const m = /^<\/?([A-Za-z][\w:-]*)/.exec(text.slice(i));
      if (m) {
        add("punct", m[0].startsWith("</") ? "</" : "<");
        add("type", m[1]);
        i += m[0].length;
        continue;
      }
    }

    cfg.id.lastIndex = i;
    const id = cfg.id.exec(text);
    if (id && id.index === i) {
      const word = id[0];
      i += word.length;
      const after = text.slice(i);
      const key = cfg.ci ? word.toLowerCase() : word;
      let kind = "plain";

      if (cfg.keywords?.has(key)) {
        kind = "keyword";
        if (["def", "function", "fn", "func"].includes(key)) pending = "function";
        else if (["class", "struct", "enum", "interface", "trait", "type"].includes(key)) pending = "type";
      } else if (pending === "function") {
        kind = "function";
        pending = null;
      } else if (pending === "type") {
        kind = "type";
        pending = null;
      } else if (cfg.css && after.startsWith("(")) {
        kind = "function";
      } else if (cfg.css && word.startsWith("--")) {
        kind = "property";
      } else if (cfg.html && /^\s*=/.test(after)) {
        kind = "property";
      } else if (cfg.json && /^\s*:/.test(after)) {
        kind = "property";
      } else if (/^[A-Z][A-Za-z0-9_$]*$/.test(word) && (language === "js" || language === "rs")) {
        kind = "type";
      }

      add(kind, word);
      continue;
    }

    add("plain", text[i]);
    i++;
  }

  return spans;
}

/**
 * Adds syntax spans to parsed diff rows. Removed and added lines are tokenized
 * against separate states so a `/*` opened on one side does not bleed into the
 * other; context lines advance both.
 *
 * @param {Array<any>} rows
 * @param {string} path
 */
export function highlightRows(rows, path) {
  const language = languageOf(path);
  const oldState = /** @type {any} */ ({});
  const newState = /** @type {any} */ ({});

  return rows.map((row) => {
    if (row.kind === "@" || row.kind === "\\") return row;
    if (row.kind === "-") {
      return { ...row, spans: tokenizeLine(row.text, language, oldState) };
    }
    const spans = tokenizeLine(row.text, language, newState);
    if (row.kind === " ") {
      oldState.block = newState.block;
      oldState.quote = newState.quote;
    }
    return { ...row, spans };
  });
}

// --- Side-by-side layouts and intra-line change highlighting -------------
//
// A unified diff only says that a line was replaced; it does not say which
// characters of the two lines differ. Both the inline and the split view want
// that information, so it is computed once per changed line pair while the
// rows are paired into columns.

const CHAR_DIFF_LIMIT = 200000;
const TOKEN_DIFF_LIMIT = 200000;

const WORD_CHAR = /[\p{L}\p{N}_$]/u;
const SPACE_CHAR = /\s/u;

/** UTF-16 offsets of every code point in `chars`, plus the end offset. */
function codePointOffsets(chars) {
  const offsets = new Array(chars.length + 1);
  let offset = 0;
  for (let i = 0; i < chars.length; i++) {
    offsets[i] = offset;
    offset += chars[i].length;
  }
  offsets[chars.length] = offset;
  return offsets;
}

/** Appends a changed code-point range, merging it with the previous one when adjacent. */
function pushRange(ranges, start, end) {
  if (end <= start) return;
  const last = ranges[ranges.length - 1];
  if (last && last[1] >= start) {
    last[1] = Math.max(last[1], end);
  } else {
    ranges.push([start, end]);
  }
}

/** Splits a code-point slice into identifier, whitespace and single-punctuation tokens. */
function tokenizeCodePoints(chars, start, end) {
  const tokens = [];
  let i = start;
  while (i < end) {
    const ch = chars[i];
    let j = i + 1;
    if (WORD_CHAR.test(ch)) {
      while (j < end && WORD_CHAR.test(chars[j])) j++;
    } else if (SPACE_CHAR.test(ch)) {
      while (j < end && SPACE_CHAR.test(chars[j])) j++;
    }
    tokens.push({ start: i, end: j, text: chars.slice(i, j).join("") });
    i = j;
  }
  return tokens;
}

/**
 * Finds the unmatched code points in two aligned character ranges.
 *
 * The common prefix and suffix are dropped first, which keeps the quadratic
 * part small on ordinary edits. The remainder is diffed character by character
 * when it is small enough; a very large rewrite is marked whole rather than
 * spending the frame on an LCS table.
 */
function charDiffRanges(A, B, aStart, aEnd, bStart, bEnd, outA, outB) {
  while (aStart < aEnd && bStart < bEnd && A[aStart] === B[bStart]) {
    aStart++;
    bStart++;
  }
  while (aEnd > aStart && bEnd > bStart && A[aEnd - 1] === B[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (aStart === aEnd && bStart === bEnd) return;
  if (aStart === aEnd) {
    pushRange(outB, bStart, bEnd);
    return;
  }
  if (bStart === bEnd) {
    pushRange(outA, aStart, aEnd);
    return;
  }

  const m = aEnd - aStart;
  const n = bEnd - bStart;
  if (m * n > CHAR_DIFF_LIMIT) {
    pushRange(outA, aStart, aEnd);
    pushRange(outB, bStart, bEnd);
    return;
  }

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    const ch = A[aStart + i];
    for (let j = n - 1; j >= 0; j--) {
      row[j] = ch === B[bStart + j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[aStart + i] === B[bStart + j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushRange(outA, aStart + i, aStart + i + 1);
      i++;
    } else {
      pushRange(outB, bStart + j, bStart + j + 1);
      j++;
    }
  }
  if (i < m) pushRange(outA, aStart + i, aEnd);
  if (j < n) pushRange(outB, bStart + j, bEnd);
}

/** Merges changed ranges with a short unchanged gap, so a rewrite does not read as confetti. */
function mergeCloseRanges(ranges, gap) {
  if (ranges.length < 2) return;
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] - last[1] <= gap) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }
  ranges.length = 0;
  ranges.push(...merged);
}

/** Number of code points covered by a range list. */
function coveredLength(ranges) {
  return ranges.reduce((total, [start, end]) => total + (end - start), 0);
}

/**
 * Diffs two ranges word by word, then refines each changed word run character
 * by character. Word matching keeps `updateScore` → `updateScores` down to the
 * single `s`, while a completely rewritten expression is highlighted as a
 * block instead of a handful of scattered letters.
 */
function tokenDiffRanges(A, B, aStart, aEnd, bStart, bEnd, outA, outB) {
  while (aStart < aEnd && bStart < bEnd && A[aStart] === B[bStart]) {
    aStart++;
    bStart++;
  }
  while (aEnd > aStart && bEnd > bStart && A[aEnd - 1] === B[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (aStart === aEnd && bStart === bEnd) return;
  if (aStart === aEnd) {
    pushRange(outB, bStart, bEnd);
    return;
  }
  if (bStart === bEnd) {
    pushRange(outA, aStart, aEnd);
    return;
  }

  const middleAStart = aStart;
  const middleBStart = bStart;
  const middleAEnd = aEnd;
  const middleBEnd = bEnd;
  const ta = tokenizeCodePoints(A, aStart, aEnd);
  const tb = tokenizeCodePoints(B, bStart, bEnd);
  if (ta.length * tb.length > TOKEN_DIFF_LIMIT) {
    charDiffRanges(A, B, aStart, aEnd, bStart, bEnd, outA, outB);
    return;
  }

  const dp = Array.from({ length: ta.length + 1 }, () => new Uint16Array(tb.length + 1));
  for (let i = ta.length - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    const token = ta[i].text;
    for (let j = tb.length - 1; j >= 0; j--) {
      row[j] = token === tb[j].text ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  /** @type {Array<[number, number]>} */
  const matches = [];
  let i = 0;
  let j = 0;
  while (i < ta.length && j < tb.length) {
    if (ta[i].text === tb[j].text) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  let ai = 0;
  let bi = 0;
  for (const [ma, mb] of [...matches, [ta.length, tb.length]]) {
    const as = ai < ta.length ? ta[ai].start : aEnd;
    const ae = ma < ta.length ? ta[ma].start : aEnd;
    const bs = bi < tb.length ? tb[bi].start : bEnd;
    const be = mb < tb.length ? tb[mb].start : bEnd;
    charDiffRanges(A, B, as, ae, bs, be, outA, outB);
    ai = ma + 1;
    bi = mb + 1;
  }

  // A rewritten identifier or expression can produce a spray of one-letter
  // ranges. Bridging one- and two-character gaps turns those back into readable
  // blocks, and when most of the line changed the whole middle is clearer than
  // any refinement.
  mergeCloseRanges(outA, 2);
  mergeCloseRanges(outB, 2);
  const changedA = coveredLength(outA);
  const changedB = coveredLength(outB);
  const totalA = middleAEnd - middleAStart;
  const totalB = middleBEnd - middleBStart;
  if (
    outA.length + outB.length >= 4 &&
    ((totalA > 0 && changedA >= totalA * 0.6) || (totalB > 0 && changedB >= totalB * 0.6))
  ) {
    outA.length = 0;
    outB.length = 0;
    pushRange(outA, middleAStart, middleAEnd);
    pushRange(outB, middleBStart, middleBEnd);
  }
}

/**
 * The character ranges that differ between two lines.
 *
 * Returns half-open UTF-16 ranges for each side, ready to be laid over the
 * syntax spans of the line. Identical lines give empty ranges.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ old: Array<[number, number]>, new: Array<[number, number]> }}
 */
export function intraLineDiff(oldText, newText) {
  const A = Array.from(oldText ?? "");
  const B = Array.from(newText ?? "");
  /** @type {Array<[number, number]>} */
  const outA = [];
  /** @type {Array<[number, number]>} */
  const outB = [];
  tokenDiffRanges(A, B, 0, A.length, 0, B.length, outA, outB);

  const offsetsA = codePointOffsets(A);
  const offsetsB = codePointOffsets(B);
  return {
    old: outA.map(([start, end]) => [offsetsA[start], offsetsA[end]]),
    new: outB.map(([start, end]) => [offsetsB[start], offsetsB[end]]),
  };
}

/** One cell of a side-by-side row (or of the inline row, reused as-is). */
function diffCell(row, side) {
  return {
    kind: row.kind,
    num: side === "old" ? row.oldNum ?? null : row.newNum ?? null,
    text: row.text ?? "",
    spans: row.spans ?? [],
    changes: row.changes ?? [],
  };
}

/**
 * Builds the three presentations of one diff from the highlighted unified rows:
 * the inline rows (with intra-line ranges attached) and the two aligned columns
 * of the split layout. Both columns always have the same length, so the two
 * virtual lists stay in lockstep; an unmatched line leaves a filler cell on the
 * other side.
 *
 * @param {Array<any>} rows
 * @returns {{ inline: Array<any>, left: Array<any>, right: Array<any> }}
 */
export function buildDiffView(rows) {
  /** @type {Array<any>} */
  const inline = [];
  /** @type {Array<any>} */
  const left = [];
  /** @type {Array<any>} */
  const right = [];

  const addMarker = (row) => {
    inline.push(row);
    left.push({ kind: row.kind, text: row.text ?? "" });
    // File-level markers and hunk headers are drawn once, across both columns;
    // the new column keeps the row (so the lists stay aligned) but no text.
    right.push({ kind: row.kind, text: "" });
  };

  let i = 0;
  while (i < rows.length) {
    const row = rows[i];

    if (row.kind === "-") {
      /** @type {Array<any>} */
      const dels = [];
      while (i < rows.length && rows[i].kind === "-") dels.push(rows[i++]);
      /** @type {Array<any>} */
      const adds = [];
      while (i < rows.length && rows[i].kind === "+") adds.push(rows[i++]);

      const pairs = Math.max(dels.length, adds.length);
      for (let k = 0; k < pairs; k++) {
        const del = dels[k] ?? null;
        const add = adds[k] ?? null;
        if (del && add) {
          const changes = intraLineDiff(del.text, add.text);
          del.changes = changes.old;
          add.changes = changes.new;
        }
        left.push({
          kind: "pair",
          left: del ? diffCell(del, "old") : null,
          right: add ? diffCell(add, "new") : null,
        });
        // The two columns are built in lockstep; the row above already carries
        // both cells, so `right` mirrors it rather than holding its own copy.
        right.push(left[left.length - 1]);
      }

      for (const del of dels) inline.push(del);
      for (const add of adds) inline.push(add);
      continue;
    }

    if (row.kind === "+") {
      while (i < rows.length && rows[i].kind === "+") {
        const add = rows[i++];
        inline.push(add);
        const splitRow = { kind: "pair", left: null, right: diffCell(add, "new") };
        left.push(splitRow);
        right.push(splitRow);
      }
      continue;
    }

    if (row.kind === " ") {
      i++;
      inline.push(row);
      const splitRow = { kind: "pair", left: diffCell(row, "old"), right: diffCell(row, "new") };
      left.push(splitRow);
      right.push(splitRow);
      continue;
    }

    i++;
    addMarker(row);
  }

  return { inline, left, right };
}

// --- Soft wrapping ---------------------------------------------------------
//
// The diff lists are uniform 22px rows, so a wrapped long line becomes several
// consecutive display rows instead of one taller row. Splitting happens here,
// on the highlighted rows, so syntax colors and intra-line change ranges carry
// over to every continuation chunk. Columns are counted in code points to keep
// surrogate pairs intact.

/**
 * Clips intra-line change ranges to one chunk and rebases them to its start.
 *
 * @param {Array<[number, number]>} changes
 * @param {number} start
 * @param {number} end
 * @returns {Array<[number, number]>}
 */
function sliceRanges(changes, start, end) {
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const [from, to] of changes ?? []) {
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (b > a) out.push([a - start, b - start]);
  }
  return out;
}

/**
 * The code-point index where a chunk starting at `start` should end. It takes
 * `limit` characters, then backs up to the last space in the second half so a
 * word stays whole when the line has one; unbreakable runs still hard-wrap.
 *
 * @param {string[]} chars
 * @param {number} start
 * @param {number} limit
 * @returns {number}
 */
function wrapBreak(chars, start, limit) {
  const end = Math.min(chars.length, start + limit);
  if (end >= chars.length) return end;

  const floor = start + Math.max(1, Math.floor(limit / 2));
  for (let i = end; i > floor; i--) {
    if (SPACE_CHAR.test(chars[i - 1])) return i;
  }
  return end;
}

/**
 * Splits one diff cell into chunks of at most `columns` code points, keeping
 * its syntax spans and rebased change ranges on each chunk.
 *
 * @param {{ text?: string, spans?: Array<{ text: string, kind: string }>, changes?: Array<[number, number]> }} cell
 * @param {number} columns
 * @returns {Array<{ text: string, spans: Array<{ text: string, kind: string }>, changes: Array<[number, number]> }>}
 */
function wrapCellChunks(cell, columns) {
  const text = cell.text ?? "";
  const spans = cell.spans ?? [];
  const changes = cell.changes ?? [];
  const limit = Math.max(1, Math.floor(columns));

  if (!text) return [{ text: "", spans: [], changes: [] }];

  const chars = Array.from(text);
  const offsets = codePointOffsets(chars);
  /** @type {Array<{ text: string, spans: Array<{ text: string, kind: string }>, changes: Array<[number, number]> }>} */
  const chunks = [];

  // Walk the spans with the chunks instead of rescanning from the start, so a
  // very long minified line stays linear.
  let spanIndex = 0;
  let spanStart = 0;

  for (let charIndex = 0; charIndex < chars.length; ) {
    const endIndex = wrapBreak(chars, charIndex, limit);
    const start = offsets[charIndex];
    const end = offsets[endIndex];

    while (spanIndex < spans.length && spanStart + spans[spanIndex].text.length <= start) {
      spanStart += spans[spanIndex].text.length;
      spanIndex++;
    }

    /** @type {Array<{ text: string, kind: string }>} */
    const parts = [];
    let index = spanIndex;
    let position = spanStart;
    while (index < spans.length && position < end) {
      const span = spans[index];
      const a = Math.max(start, position);
      const b = Math.min(end, position + span.text.length);
      if (b > a) parts.push({ kind: span.kind, text: span.text.slice(a - position, b - position) });
      position += span.text.length;
      index++;
    }

    const chunkText = chars.slice(charIndex, endIndex).join("");
    if (!parts.length && chunkText) parts.push({ kind: "plain", text: chunkText });

    chunks.push({ text: chunkText, spans: parts, changes: sliceRanges(changes, start, end) });
    charIndex = endIndex;
  }

  return chunks;
}

/**
 * Expands inline diff rows into display rows of `columns` code points each.
 * Line numbers stay on the first chunk; continuation chunks keep the row's
 * kind so added/removed backgrounds carry down the wrap.
 *
 * @param {Array<any>} rows
 * @param {number} columns
 * @returns {Array<any>}
 */
export function wrapInlineRows(rows, columns) {
  /** @type {Array<any>} */
  const out = [];

  for (const row of rows) {
    const chunks = wrapCellChunks(row, columns);

    if (row.kind === "@" || row.kind === "\\") {
      for (const chunk of chunks) out.push({ ...row, text: chunk.text });
      continue;
    }

    chunks.forEach((chunk, index) => {
      out.push({
        ...row,
        text: chunk.text,
        spans: chunk.spans,
        changes: chunk.changes,
        oldNum: index === 0 ? row.oldNum ?? null : null,
        newNum: index === 0 ? row.newNum ?? null : null,
      });
    });
  }

  return out;
}

/**
 * Expands both split columns in lockstep. A pair yields as many display rows
 * as its longest side needs, and the shorter side becomes filler cells; that
 * keeps both panes at the same row count and the shared scroll in sync.
 *
 * @param {Array<any>} left
 * @param {Array<any>} right
 * @param {number} columns
 * @returns {{ left: Array<any>, right: Array<any> }}
 */
export function wrapSplitRows(left, right, columns) {
  /** @type {Array<any>} */
  const outLeft = [];
  /** @type {Array<any>} */
  const outRight = [];
  const count = Math.max(left.length, right.length);

  for (let i = 0; i < count; i++) {
    const l = left[i] ?? null;
    const r = right[i] ?? l;

    if (l?.kind === "pair" || r?.kind === "pair") {
      const leftCell = l?.kind === "pair" ? l.left : null;
      const rightCell = r?.kind === "pair" ? r.right : null;
      const leftChunks = leftCell ? wrapCellChunks(leftCell, columns) : [];
      const rightChunks = rightCell ? wrapCellChunks(rightCell, columns) : [];
      const lines = Math.max(leftChunks.length, rightChunks.length, 1);

      for (let j = 0; j < lines; j++) {
        const row = {
          kind: "pair",
          left: leftChunks[j]
            ? { ...leftCell, ...leftChunks[j], num: j === 0 ? leftCell.num ?? null : null }
            : null,
          right: rightChunks[j]
            ? { ...rightCell, ...rightChunks[j], num: j === 0 ? rightCell.num ?? null : null }
            : null,
        };
        outLeft.push(row);
        outRight.push(row);
      }
      continue;
    }

    const leftChunks = wrapCellChunks(l ?? { text: "" }, columns);
    const rightChunks = wrapCellChunks(r ?? { text: "" }, columns);
    const lines = Math.max(leftChunks.length, rightChunks.length, 1);

    for (let j = 0; j < lines; j++) {
      outLeft.push({ kind: l?.kind ?? "@", text: leftChunks[j]?.text ?? "" });
      outRight.push({ kind: r?.kind ?? l?.kind ?? "@", text: rightChunks[j]?.text ?? "" });
    }
  }

  return { left: outLeft, right: outRight };
}

/**
 * Splits one syntax highlighter span list into drawable segments, marking the
 * segments that fall inside an intra-line change range. Adjacent segments with
 * the same token kind and change flag are merged so a row is a handful of spans
 * rather than one per character.
 *
 * @param {Array<{ text: string, kind: string }>} spans
 * @param {Array<[number, number]>} changes
 * @returns {Array<{ text: string, kind: string, changed: boolean }>}
 */
export function lineSegments(spans, changes) {
  const source = spans?.length ? spans : [{ text: " ", kind: "plain" }];
  const ranges = changes ?? [];
  /** @type {Array<{ text: string, kind: string, changed: boolean }>} */
  const out = [];
  let position = 0;
  let rangeIndex = 0;

  for (const span of source) {
    const spanStart = position;
    const spanEnd = position + span.text.length;
    let i = spanStart;

    while (i < spanEnd) {
      while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= i) rangeIndex++;
      const changed = rangeIndex < ranges.length && ranges[rangeIndex][0] <= i;
      let next = spanEnd;
      if (changed) {
        next = Math.min(spanEnd, ranges[rangeIndex][1]);
      } else if (rangeIndex < ranges.length && ranges[rangeIndex][0] < spanEnd) {
        next = ranges[rangeIndex][0];
      }
      if (next <= i) next = spanEnd;

      const text = span.text.slice(i - spanStart, next - spanStart);
      if (text) {
        const last = out[out.length - 1];
        if (last && last.kind === span.kind && last.changed === changed) {
          last.text += text;
        } else {
          out.push({ text, kind: span.kind, changed });
        }
      }
      i = next;
    }

    position = spanEnd;
  }

  return out;
}

/**
 * True for a model the OpenCode catalog offers without charge.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isFreeModel(id) {
  const base = String(id || "").split("#")[0];
  return /(?:^|[/-])free(?:$|[/-])/.test(base) || base === "opencode/big-pickle";
}

/**
 * A readable label for a `provider/model#variant` id.
 *
 * @param {string} id
 * @returns {string}
 */
export function cleanModelLabel(id) {
  const base = String(id || "").split("#")[0];
  const name = base.split("/").pop() || base;
  const special = {
    claude: "Claude",
    crouton: "Crouton",
    deepseek: "DeepSeek",
    flint: "Flint",
    gemini: "Gemini",
    glm: "GLM",
    gpt: "GPT",
    iceman: "Iceman",
    kimi: "Kimi",
    llama: "Llama",
    mimo: "MiMo",
    nemotron: "Nemotron",
    pulse: "Pulse",
    qwen: "Qwen",
    sonnet: "Sonnet",
  };
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => special[word.toLowerCase()] || (word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Resolves which AI commit model to use:
 * 1. An explicit override/requested model wins if it is available in models.
 * 2. A saved preference wins if it is available in models.
 * 3. Fallback preferences in priority order.
 * 4. First available free model.
 *
 * @param {Array<any>} models
 * @param {{ override?: string | null, saved?: string | null, preferences?: string[] }} [options]
 * @returns {string | null}
 */
export function resolveCleanAgentModelLogic(models, { override = null, saved = null, preferences = [] } = {}) {
  const baseOf = (id) => String(id || "").split("#")[0];
  const list = Array.isArray(models) ? models : [];
  const has = (id) => Boolean(id) && list.some((m) => (m.id || m) === baseOf(id));
  if (override && has(override)) return override;
  if (saved && has(saved)) return saved;
  for (const candidate of preferences) {
    if (has(candidate)) return candidate;
  }
  const free = list.find((m) => m?.free);
  return free ? free.id : null;
}

/**
 * Filters and orders models for the AI worker picker dialog.
 * Pins the currently active model to the top so it is immediately visible
 * and clearly indicated, even if showAll is false or searching.
 *
 * @param {Array<any>} models
 * @param {{ provider?: string | null, query?: string, showAll?: boolean, activeModel?: string | null }} [options]
 * @returns {Array<any>}
 */
export function filterVisibleCleanModels(models, { provider = null, query = "", showAll = false, activeModel = null } = {}) {
  const all = Array.isArray(models) ? models : [];
  const pool = provider ? all.filter((m) => m.provider === provider) : all;
  const activeBase = String(activeModel || "").split("#")[0];
  const trimmed = String(query || "").trim().toLowerCase();
  let list;
  if (trimmed) {
    list = pool.filter(
      (m) => (m.id && m.id.toLowerCase().includes(trimmed)) || (m.label && m.label.toLowerCase().includes(trimmed))
    );
  } else if (showAll) {
    list = [...pool];
  } else {
    list = pool.filter((m) => m.free);
    if (activeBase && pool.some((m) => m.id === activeBase) && !list.some((m) => m.id === activeBase)) {
      const activeEntry = pool.find((m) => m.id === activeBase);
      if (activeEntry) list.unshift(activeEntry);
    }
  }

  if (activeBase && list.some((m) => m.id === activeBase)) {
    list.sort((a, b) => {
      const aActive = a.id === activeBase ? 1 : 0;
      const bActive = b.id === activeBase ? 1 : 0;
      return bActive - aActive;
    });
  }

  return list;
}

/** Official OpenCode CLI install command from https://opencode.ai/docs/ */
export const OPENCODE_INSTALL_CMD = "curl -fsSL https://opencode.ai/install | bash";

/** Official OpenCode documentation URL */
export const OPENCODE_DOCS_URL = "https://opencode.ai/docs/";

