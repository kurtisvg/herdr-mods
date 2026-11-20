// The Files | Changes | Comments side panel.
//
// Inspects the git repository of the focused pane, or its folder outside git:
//   Files     every file: markdown rendered with pictures and diagrams
//             (Preview / Edit / Comment), other files in Herdr's Editor with
//             auto-save (Edit / Comment; Read on remote spaces)
//   Changes   uncommitted files as syntax-colored, commentable diffs, plus Commit
//   Comments  every comment on this tab, open ones first
//
// When `review-panel` with `props.role === "tabs"` is in the layout's `tabs`
// block, its top-right Files | Changes | Comments buttons choose the mode via
// `shared("review-panel.mode")`. Otherwise the panel draws its own mode switcher.

import { div, svg, image } from "gpui-kit";
import {
  v_flex,
  h_flex,
  Scrollbar,
  ScrollHandle,
  Input,
  InputState,
  Textarea,
  TextareaState,
  TextView,
  Editor,
  EditorState,
} from "gpui-base";
import {
  spaces,
  machines,
  panes,
  focused,
  agents,
  layout,
  exec,
  hc,
  readTextFile,
  writeTextFile,
  watchFolder,
  theme,
  settings,
  window,
  shared,
  setShared,
  checking,
} from "herdr";
import {
  untab,
  isLine,
  fileRows,
  diffRows,
  selection,
  lines,
  where,
  editorLines,
  locate,
  outdated,
  sortComments,
  formatReview,
  stateOf,
  unsent,
  replyFolder,
  applyReply,
  markSent,
  DAY,
  newSet,
  findSet,
  migrate,
  sweep,
  adoptable,
  attach,
  isMarkdown,
  markdownBlocks,
  bareFences,
  blockFor,
  textKey,
  pictureFile,
  tokenizeLine,
  formatMarkdown,
} from "./model.js";
import { Diagrams } from "./diagrams.js";
import { Pictures, CACHE as PICTURES } from "./pictures.js";

const MODES = ["files", "changes", "comments"];
const PAGE = 300; // rows per page in Comment and diff views
const SPAN_BUDGET = 1100; // max colored token divs once cached
const FIRST_BUDGET = 700; // max colored token divs while tokenizing
const TOK_SLICE = 40; // uncached lines tokenized per frame
const AUTOSAVE_MS = 800; // debounce after typing in Edit mode
const CHANGED = 1000;
const PER_FOLDER = 500;
const TOTAL = 5000;
const STALE = 10000; // ms before re-reading displayed state
const SEND_TIMEOUT = 120000; // `hc send` waits up to a minute for partial input

const READ = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];

const LANG = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  pyi: "py",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
  sh: "bash",
  zsh: "bash",
  markdown: "md",
  mdx: "md",
};

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function focusedFolder() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return {
    cwd: pane?.cwd || f?.cwd || space?.folder,
    on,
    space: space?.id,
    tab: f?.tab ?? "",
  };
}

function shown(node = layout(), visible = true) {
  if (!node || typeof node !== "object") return null;
  if (
    node.content?.mod === "review-panel" &&
    !node.content?.props?.file &&
    node.content?.props?.role !== "viewer"
  ) {
    return visible;
  }
  const children = node.children ?? [];
  const here = visible && !node.hidden;
  for (const child of children) {
    const active =
      node.type !== "stack" || (node.active ?? children[0]?.id) === child.id;
    const found = shown(child, here && active);
    if (found !== null) return found;
  }
  return null;
}

function reviewer() {
  const f = focused();
  const all = agents();
  const inPane = f?.pane ? all.find((a) => a.pane === f.pane) : null;
  if (inPane) return { agent: inPane };
  const inTab = all.filter((a) => a.tab === f?.tab);
  if (inTab.length === 1) return { agent: inTab[0] };
  return {
    agent: null,
    hint: inTab.length
      ? "Click the agent's pane to choose it"
      : "No agent in this tab",
  };
}

const agentName = (a) =>
  `${a.program?.name ?? "agent"} in ${a.tab_name || a.tab_index} (${a.address})`;

const tabNames = (tabs) =>
  [...tabs].map(([id, tab]) => `${id}=${tab.name}`).join("\n");

const newKey = () =>
  Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0");

const PREPARE = `
  mkdir -p "$1" || exit 1
  if [ "$2" = git ] && [ ! -e "$3/.gitignore" ]; then
    printf "*\\n" > "$3/.gitignore"
  fi
  cd "$1" && shift 3 && rm -f -- "$@"
`;

const REPLIES = `
  cd "$1" 2>/dev/null || exit 0
  shift
  for id in "$@"; do
    [ -f "$id.md" ] || continue
    printf "%s\\0" "$id"
    head -c 20000 "$id.md"
    printf "\\0"
  done
`;

const DIR_SH = `
  n=0
  for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    name=\${p##*/}
    [ "$name" = .git ] && continue
    if [ -d "$p" ]; then
      kind=d
    else
      kind=f
    fi
    printf "%s\\0%s\\0" "$kind" "$name"
    n=$((n + 1))
    [ "$n" -gt 500 ] && break
  done
  test -d "$1"
`;

async function windowsDirectory(path, on) {
  const escaped = path.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&");
  const script = `
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    & {
      param($p)
      @(
        Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop |
          Where-Object Name -ne '.git' |
          Select-Object -First 501 |
          ForEach-Object {
            $isDir = $_.PSIsContainer -and (
              -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
              -not $_.LinkType -or
              (
                $_.Target -and [IO.Directory]::Exists(
                  [IO.Path]::Combine(
                    [IO.Path]::GetDirectoryName($_.FullName),
                    $_.Target[0]
                  )
                )
              )
            )
            @{ name = $_.Name; dir = $isDir }
          }
      ) | ConvertTo-Json -Compress
    } '${escaped}'
  `;
  const r = await exec("powershell", ["-NoProfile", "-Command", script], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const result = JSON.parse(r.stdout || "[]");
  return Array.isArray(result) ? result : [result];
}

async function directory(path, on) {
  if (!on && window()?.platform === "windows") return windowsDirectory(path, on);
  let r;
  try {
    r = await exec("sh", ["-c", DIR_SH, "review", path], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) {
      return windowsDirectory(path, on);
    }
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  }
  return out;
}

export class Panel {
  init(_props, cx) {
    const sharedMode = shared("review-panel.mode");
    const savedMode = localStorage.getItem("mode");
    this.seenMode = sharedMode;
    this.mode = MODES.includes(sharedMode)
      ? sharedMode
      : MODES.includes(savedMode)
        ? savedMode
        : "changes";
    this.sets = this.loadSets();
    this.ctx = null;
    this.root = null;
    this.on = null;
    this.repo = false;
    this.tab = "";
    this.files = [];
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.treeLimited = false;
    this.open = null;
    this.rows = [];
    this.start = 0;
    this.ready = false;
    // A file load that started before `loadSeq` changed discards its result.
    this.loadSeq = 0;
    // A read of the reply files that started before `replySeq` changed
    // discards its result.
    this.replySeq = 0;
    // A refresh or a reply check was asked for while one ran. One more runs
    // after it.
    this.refreshQueued = false;
    this.replyQueued = false;
    this.anchor = null;
    this.head = null;
    this.dragging = false;
    this.pick = null;
    this.editing = null;
    this.replying = null;
    this.hasText = false;
    this.unfolded = new Set();
    this.raw = localStorage.getItem("raw") === "1";
    this.mdMode = "rendered"; // "rendered" | "edit" | "comment" in Files
    this.blocks = null;
    this.anchorBlock = null;
    this.headBlock = null;
    this.editor = null;
    this.editorRoot = null;
    this.editorPath = null;
    // Tracks whether the editor was focused in this session so clicking the
    // Comment pill (which blurs the editor first) carries the cursor line only
    // after the user actually placed the cursor in the editor.
    this.editorFocused = false;
    this.canEdit = false;
    this.diskText = null;
    this.dirty = false;
    this.saving = false;
    // Changes whenever the editor text and the file on disk are compared or
    // replaced. A load or a save that started before the change must not
    // overwrite the newer editor text.
    this.saveSeq = 0;
    this.saveTask = null; // the write in flight: { root, path, text }
    this.saveQueued = false;
    this.saveQueuedForce = false;
    this.savedFlash = false;
    this.conflictDisk = null;
    this.saveError = null;
    this.saveTimer = null;
    this.savedTimer = null;
    this.copied = false;
    this.copiedTimer = null;
    this.commenting = false;
    this.revealRow = null;
    this.watched = null; // token of the watch loop that is current
    this.folderWatch = null; // the `watchFolder` call in flight, to cancel it
    this.diagrams = new Diagrams();
    this.pictures = new Pictures();
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();

    this.draft = TextareaState.new({ placeholder: "Leave a comment", rows: 4 });
    this.draft.on("change", (_e, cx) => {
      const has = Boolean(this.draft.value().trim());
      if (has !== this.hasText) {
        this.hasText = has;
        cx.notify();
      }
    });
    this.draft.on("submit", (e, cx) => {
      if (e?.secondary) this.save(cx);
    });

    this.note = InputState.new({ placeholder: "Overall note (optional)" });
    this.note.on("blur", () => this.keepNote());

    this.commitMsg = InputState.new({ placeholder: "Commit message" });
    this.hasCommitMsg = false;
    this.committing = false;
    this.typingCommit = false;
    this.commitError = null;
    this.commitMsg.on("change", (_e, cx) => {
      const has = Boolean(this.commitMsg.value().trim());
      if (has !== this.hasCommitMsg) {
        this.hasCommitMsg = has;
        cx.notify();
      }
    });
    this.commitMsg.on("submit", (_e, cx) => this.commit(cx));
    this.commitMsg.on("focus", (_e, cx) => {
      this.typingCommit = true;
      cx.notify();
    });
    this.commitMsg.on("blur", (_e, cx) => {
      this.typingCommit = false;
      cx.notify();
    });

    this.refresh(cx);
    cx.timer.every(STALE, (cx) => {
      if (shown() !== false) this.refresh(cx);
    });
  }

  async close() {
    this.stopWatch();
    this.saveTimer?.cancel();
    this.savedTimer?.cancel();
    this.copiedTimer?.cancel();
    const pendingWrite = this.flushPendingWrite();
    this.editor?.release();
    this.editor = null;
    if (pendingWrite) await pendingWrite;
  }

  // ---------------------------------------------------------------- stored comments

  loadSets() {
    const read = (key) => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "null");
      } catch {
        return null;
      }
    };
    const stored = read("review.sets");
    if (Array.isArray(stored?.sets)) return stored.sets;
    const old = read("review.drafts");
    const sets =
      old && typeof old === "object" && !Array.isArray(old)
        ? migrate(old, Date.now(), newKey)
        : [];
    if (old) {
      localStorage.setItem("review.sets", JSON.stringify({ sets }));
      localStorage.removeItem("review.drafts");
    }
    return sets;
  }

  persist() {
    localStorage.setItem("review.sets", JSON.stringify({ sets: this.sets }));
  }

  mine() {
    return this.root ? findSet(this.sets, this.tab, this.on, this.root) : undefined;
  }

  comments() {
    return this.mine()?.comments ?? [];
  }

  entry() {
    let set = this.mine();
    if (!set) {
      set = newSet(this.tab, this.on, this.root, newKey());
      Object.assign(set, this.tabs().get(this.tab) ?? {});
      this.sets.push(set);
    }
    return set;
  }

  keepNote() {
    if (!this.root) return;
    const text = this.note.value();
    if ((this.mine()?.note ?? "") === text) return;
    this.entry().note = text;
    this.persist();
  }

  tabs() {
    const out = new Map();
    for (const space of spaces()) {
      for (const tab of space.tabs) {
        out.set(tab.id, { name: tab.name, named: tab.named });
      }
    }
    return out;
  }

  reachable(on) {
    return machines().some(
      (m) => (m.name ?? null) === (on ?? null) && m.layout === "ready",
    );
  }

  cleanReplyFolder(set) {
    if (!/^[0-9a-f]{8}$/.test(set?.key ?? "")) return;
    exec("sh", ["-c", 'rm -rf -- "$1"', "review", replyFolder(set.root, set.key)], {
      on: set.on,
    }).catch(() => {});
  }

  tend() {
    const live = this.tabs();
    const tab = live.get(this.tab);
    this.names = tabNames(live);
    let changed = sweep(
      this.sets,
      (id) => live.get(id),
      (on) => this.reachable(on),
      Date.now(),
    );
    const from =
      this.root && tab
        ? adoptable(this.sets, this.tab, tab.name, tab.named, this.on, this.root)
        : null;
    if (from) {
      const set = attach(this.sets, from, this.tab, this.on, this.root);
      Object.assign(set, tab);
      this.note.set_value(set.note ?? "");
      this.status = {
        text: `This tab took over the comments of the closed tab "${tab.name}".`,
      };
      changed = true;
    }
    if (changed) this.persist();
  }

  adopt(from, cx) {
    if (!this.root || !this.sets.includes(from)) return;
    this.keepNote();
    const set = attach(this.sets, from, this.tab, this.on, this.root);
    Object.assign(set, this.tabs().get(this.tab) ?? {});
    if (!set.note) set.note = from.note ?? "";
    this.note.set_value(set.note);
    this.persist();
    cx.notify();
  }

  dropSet(set, cx) {
    const at = this.sets.indexOf(set);
    if (at < 0) return;
    this.sets.splice(at, 1);
    this.persist();
    this.cleanReplyFolder(set);
    cx.notify();
  }

  forget(set, ids) {
    if (!set || !ids.length) return;
    exec(
      "sh",
      [
        "-c",
        'cd "$1" 2>/dev/null && shift && rm -f -- "$@"',
        "review",
        replyFolder(set.root, set.key),
        ...ids.map((id) => `${id}.md`),
      ],
      { on: set.on },
    ).catch(() => {});
  }

  // ---------------------------------------------------------------- reading the folder

  location() {
    return focusedFolder();
  }

  key() {
    return JSON.stringify(this.location());
  }

  current(context) {
    return this.context === context && this.key() === context.key;
  }

  stopWatch() {
    this.watched = null;
    if (this.folderWatch) {
      this.folderWatch.cancel();
      this.folderWatch = null;
    }
  }

  watch(root, cx) {
    if (this.on || !root || this.watched?.root === root) return;
    this.stopWatch();
    const token = { root };
    this.watched = token;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === token && !this.on) {
          const task = watchFolder(root);
          this.folderWatch = task;
          const paths = await task;
          if (this.folderWatch === task) this.folderWatch = null;
          if (!paths.length || this.watched !== token || this.on) break;
          if (shown() !== false) {
            this.refresh(cx);
            this.checkReplies(cx);
          }
        }
      } catch {
        // Watch failed or exceeded OS directory limit. The 10s timer continues.
      } finally {
        if (this.watched === token) {
          this.watched = null;
          this.folderWatch = null;
        }
      }
    });
  }

  refresh(cx) {
    const { cwd, on, tab } = this.location();
    const next = this.key();
    if (next !== this.context?.key) {
      this.context = { key: next, cwd, on };
      this.loading = false;
      this.refreshQueued = false;
    }
    if (checking()) return;
    if (this.loading) {
      this.refreshQueued = true;
      return;
    }
    const context = this.context;
    this.at = Date.now();
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = cwd
          ? await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(
              () => null,
            )
          : null;
        if (!this.current(context)) return;
        const repo = top?.code === 0;
        const root = repo ? top.stdout.trim() : (cwd ?? null);
        this.place(root, on, repo, tab);
        this.tend();
        if (!root) return;
        if (repo) await this.loadChanges(context);
        if (this.mode === "files") {
          for (const path of ["", ...this.folders]) {
            if (!this.current(context)) return;
            try {
              await this.loadFolder(path, context);
            } catch (e) {
              if (!path) throw e;
              this.folders.delete(path);
              this.entries.delete(path);
            }
          }
        }
        if (!this.current(context)) return;
        this.error = null;
        this.watch(root, cx);
        if (this.open) await this.load(context).catch(() => {});
        const blocks = this.blocks;
        if (blocks) {
          cx.spawn(async (cx) => {
            await this.illustrate(blocks, cx);
          });
        }
        await this.readReplies();
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) {
          this.loading = false;
          if (this.refreshQueued) {
            this.refreshQueued = false;
            this.refresh(cx);
          }
        }
        cx.notify();
      }
    });
  }

  place(root, on, repo, tab) {
    const ctx = root ? `${on ?? ""}|${root}` : null;
    const moved = ctx !== this.ctx;
    this.repo = repo;
    if (!moved && tab === this.tab) return;
    this.keepNote();
    if (moved) {
      this.stopWatch();
      this.files = [];
      this.limited = false;
      this.hasHead = false;
      this.entries = new Map();
      this.folders = new Set();
      this.pending = new Set();
      this.treeLimited = false;
      this.shut();
      this.cancel();
      this.commitMsg.set_value("");
      this.hasCommitMsg = false;
      this.commitError = null;
      this.error = null;
    }
    this.ctx = ctx;
    this.root = root;
    this.on = on;
    this.tab = tab;
    if (this.editing || this.replying) this.cancel();
    this.status = null;
    this.unfolded = new Set();
    this.note.set_value(this.mine()?.note ?? "");
  }

  // ---------------------------------------------------------------- the agent's replies

  async readReplies() {
    if (this.sending) return;
    const set = this.mine();
    const ids = (set?.comments ?? [])
      .filter((c) => stateOf(c) !== "draft")
      .map((c) => c.id);
    if (!ids.length) return;
    const seq = this.replySeq;
    const r = await exec(
      "sh",
      ["-c", REPLIES, "review", replyFolder(set.root, set.key), ...ids],
      { on: set.on },
    ).catch(() => null);
    if (!r || r.code !== 0 || this.sending || this.replySeq !== seq) return;
    const fields = r.stdout.split("\0");
    let changed = false;
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const c = set.comments.find((c) => c.id === fields[i]);
      if (c && applyReply(c, fields[i + 1], Date.now())) changed = true;
    }
    if (changed) this.persist();
  }

  checkReplies(cx) {
    if (!this.mine() || checking()) return;
    if (this.reading) {
      this.replyQueued = true;
      return;
    }
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        await this.readReplies();
      } finally {
        this.reading = false;
        cx.notify();
        if (this.replyQueued) {
          this.replyQueued = false;
          this.checkReplies(cx);
        }
      }
    });
  }

  async loadChanges(context) {
    const root = this.root;
    const on = context.on;
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const status = await git([
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=all",
    ]);
    if (status.code !== 0) throw new Error(status.stderr);
    const head = await git(["rev-parse", "--verify", "HEAD"]);
    const stats = {};
    const results =
      head.code === 0
        ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
        : [
            await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
            await git(["diff", "--numstat", "-z", "--no-renames"]),
          ];
    for (const result of results) {
      if (result.code !== 0) throw new Error(result.stderr);
      for (const item of result.stdout.split("\0")) {
        const [a, d, ...parts] = item.split("\t");
        if (!parts.length) continue;
        const path = parts.join("\t");
        const old = stats[path] ?? { add: 0, del: 0 };
        stats[path] = {
          add: old.add + (Number(a) || 0),
          del: old.del + (Number(d) || 0),
          binary: a === "-",
        };
      }
    }
    const files = [];
    const found = status.stdout.split("\0").filter(Boolean);
    for (const item of found.slice(0, CHANGED)) {
      const xy = item.slice(0, 2);
      const path = item.slice(3);
      const fresh = xy === "??";
      const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
      const s = conflict
        ? "U"
        : xy.includes("D")
          ? "D"
          : fresh || xy.includes("A")
            ? "A"
            : "M";
      files.push({ path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) });
    }
    if (!this.current(context) || root !== this.root) return;
    this.hasHead = head.code === 0;
    this.files = files;
    this.limited = found.length > CHANGED;
  }

  async loadFolder(path, context) {
    const root = this.root;
    const found = await directory(path ? `${root}/${path}` : root, context.on);
    if (
      !this.current(context) ||
      root !== this.root ||
      (path && !this.folders.has(path))
    ) {
      return;
    }
    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, e]) => n + e.length, 0);
    const cap = Math.max(0, Math.min(PER_FOLDER, TOTAL - used));
    this.entries.set(
      path,
      found
        .slice(0, cap)
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
    );
    if (found.length > PER_FOLDER || used + found.length > TOTAL) {
      this.treeLimited = true;
    }
  }

  toggleFolder(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) {
        if (folder === path || folder.startsWith(path + "/")) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
      }
    } else {
      this.folders.add(path);
      this.fetchFolder(path, cx);
    }
    cx.notify();
  }

  fetchFolder(path, cx) {
    if (!this.root || this.entries.has(path) || this.pending.has(path)) return;
    const context = this.context;
    this.pending.add(path);
    cx.spawn(async (cx) => {
      try {
        await this.loadFolder(path, context);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        this.pending.delete(path);
        cx.notify();
      }
    });
  }

  setMode(mode, cx) {
    if (this.open) this.shut();
    this.mode = mode;
    this.seenMode = mode;
    localStorage.setItem("mode", mode);
    setShared("review-panel.mode", mode);
    if (mode === "files") this.fetchFolder("", cx);
    cx.notify();
  }

  // ---------------------------------------------------------------- auto-save editor

  flushPendingWrite() {
    if (
      !this.canEdit ||
      !this.editor ||
      !this.editorRoot ||
      !this.editorPath ||
      this.conflictDisk !== null ||
      checking()
    ) {
      return null;
    }
    const fullPath = `${this.editorRoot}/${this.editorPath}`;
    const text = this.editor.value();
    const inflight =
      this.saveTask &&
      this.saveTask.root === this.editorRoot &&
      this.saveTask.path === this.editorPath
        ? this.saveTask
        : null;
    if (inflight) {
      if (text === inflight.text) return inflight.promise;
      return inflight.promise.then(() => {
        if (!inflight.ok()) return;
        return writeTextFile(fullPath, text, inflight.text).catch(() => {});
      });
    }
    if (!this.dirty || text === this.diskText) return null;
    return writeTextFile(fullPath, text, this.diskText).catch(() => {});
  }

  onEditorChange(cx) {
    if (!this.editor || !this.canEdit) return;
    const now = this.editor.value();
    this.dirty = now !== this.diskText;
    this.saveError = null;
    this.saveTimer?.cancel();
    this.saveTimer = null;
    if (!this.dirty || this.conflictDisk !== null) {
      cx.notify();
      return;
    }
    this.saveTimer = cx.timer.after(AUTOSAVE_MS, (cx) => this.flushSave(cx));
    cx.notify();
  }

  flushSave(cx, force = false) {
    this.saveTimer?.cancel();
    this.saveTimer = null;
    if (
      !this.editor ||
      !this.canEdit ||
      !this.editorRoot ||
      !this.editorPath ||
      checking()
    ) {
      return;
    }
    if (this.conflictDisk !== null && !force) return;
    if (!force && this.editor.value() === this.diskText) {
      this.dirty = false;
      return;
    }
    cx.spawn(async (cx) => {
      await this.writeSave(force, cx);
    });
  }

  async writeSave(force, cx) {
    if (
      !this.editor ||
      !this.canEdit ||
      !this.editorRoot ||
      !this.editorPath ||
      checking()
    ) {
      return;
    }
    if (this.saving) {
      this.saveQueued = true;
      this.saveQueuedForce = Boolean(this.saveQueuedForce || force);
      return;
    }
    const text = this.editor.value();
    const root = this.editorRoot;
    const path = this.editorPath;
    const fullPath = `${root}/${path}`;
    if (!force && text === this.diskText) {
      this.dirty = false;
      return;
    }
    this.saveSeq += 1;
    this.saving = true;
    this.saveError = null;
    cx.notify();

    let wroteOk = false;
    const runWrite = (async () => {
      const expected = force ? await readTextFile(fullPath) : this.diskText;
      await writeTextFile(fullPath, text, expected);
      wroteOk = true;
    })();
    const task = {
      root,
      path,
      text,
      promise: runWrite.catch(() => {}),
      ok: () => wroteOk,
    };
    this.saveTask = task;

    try {
      await runWrite;
      this.saveSeq += 1;
      if (this.editorRoot === root && this.editorPath === path) {
        this.diskText = text;
        this.conflictDisk = null;
        this.dirty = this.editor ? this.editor.value() !== text : false;
        this.savedFlash = true;
        this.savedTimer?.cancel();
        this.savedTimer = cx.timer.after(1500, (cx) => {
          this.savedFlash = false;
          cx.notify();
        });
        if (this.open?.path === path && !this.dirty) {
          this.applyLocalText(root, path, text, cx);
        }
      }
    } catch (e) {
      this.saveSeq += 1;
      if (this.editorRoot === root && this.editorPath === path) {
        const latest = await readTextFile(fullPath).catch(() => null);
        if (latest !== null && latest !== this.diskText) {
          this.conflictDisk = latest;
        } else {
          this.saveError = `Save failed: ${String(e?.message ?? e)}`;
        }
      }
    } finally {
      if (this.saveTask === task) this.saveTask = null;
      if (this.editorRoot === root && this.editorPath === path) {
        this.saving = false;
        const queued = this.saveQueued;
        const queuedForce = this.saveQueuedForce;
        this.saveQueued = false;
        this.saveQueuedForce = false;
        cx.notify();
        if (queued && (queuedForce || (this.dirty && this.conflictDisk === null))) {
          await this.writeSave(queuedForce, cx);
        }
      } else {
        cx.notify();
      }
    }
  }

  reloadFromDisk(cx) {
    if (!this.editor || this.conflictDisk === null) return;
    const text = this.conflictDisk;
    this.saveTimer?.cancel();
    this.saveTimer = null;
    this.saveSeq += 1;
    this.diskText = text;
    this.conflictDisk = null;
    this.dirty = false;
    this.saveError = null;
    this.editor.set_value(text);
    if (this.open?.path === this.editorPath && this.editorRoot) {
      this.applyLocalText(this.editorRoot, this.editorPath, text, cx);
    }
    cx.notify();
  }

  formatMarkdownEditor(cx) {
    if (!this.editor || !this.canEdit || !this.open || !isMarkdown(this.open.path)) {
      return;
    }
    const current = this.editor.value();
    const formatted = formatMarkdown(current, 88);
    if (formatted === current) return;
    this.editor.set_value(formatted);
    this.onEditorChange(cx);
  }

  applyLocalText(root, path, text, cx) {
    this.rows = fileRows(text);
    if (isMarkdown(path) && this.mdMode === "rendered") {
      const dir = `${root}/${path}`.replace(/\/[^/]*$/, "");
      this.blocks = markdownBlocks(text, (src) => pictureFile(src, dir));
      const blocks = this.blocks;
      cx.spawn(async (cx) => {
        await this.illustrate(blocks, cx);
      });
    } else if (!isMarkdown(path)) {
      this.blocks = null;
    }
  }

  syncEditor(root, path, text, editable) {
    if (this.editor && this.editorRoot === root && this.editorPath === path) {
      if (text === this.diskText) return;
      if (
        this.saveTask &&
        this.saveTask.root === root &&
        this.saveTask.path === path &&
        text === this.saveTask.text
      ) {
        return;
      }
      if (!this.dirty && !this.saving) {
        this.diskText = text;
        this.conflictDisk = null;
        this.editor.set_value(text);
      } else if (text === this.editor.value()) {
        this.diskText = text;
        this.dirty = false;
        this.conflictDisk = null;
        this.saveTimer?.cancel();
        this.saveTimer = null;
      } else {
        this.saveTimer?.cancel();
        this.saveTimer = null;
        this.conflictDisk = text;
      }
      return;
    }
    this.editor?.release();
    const t = theme();
    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
    this.saveSeq += 1;
    this.editorFocused = false;
    this.canEdit = Boolean(editable) && !checking();
    this.diskText = text;
    this.dirty = false;
    this.saving = false;
    this.saveTask = null;
    this.saveQueued = false;
    this.saveQueuedForce = false;
    this.savedFlash = false;
    this.conflictDisk = null;
    this.saveError = null;
    this.editor = EditorState.new({
      language: LANG[ext] ?? ext,
      readonly: !this.canEdit,
      soft_wrap: isMarkdown(path),
      value: text,
      font_family: settings().font_family,
      font_size: 12,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });
    this.editor.on("focus", () => {
      this.editorFocused = true;
    });
    if (this.canEdit) {
      this.editor.on("change", (_e, cx) => this.onEditorChange(cx));
      this.editor.on("blur", (_e, cx) => {
        if (this.dirty && this.conflictDisk === null) this.flushSave(cx);
      });
    }
    this.editorRoot = root;
    this.editorPath = path;
  }

  // ---------------------------------------------------------------- the open file

  shut() {
    this.loadSeq += 1;
    this.saveTimer?.cancel();
    this.saveTimer = null;
    this.savedTimer?.cancel();
    this.savedTimer = null;
    this.flushPendingWrite();
    this.editor?.release();
    this.editor = null;
    this.editorRoot = null;
    this.editorPath = null;
    this.editorFocused = false;
    this.canEdit = false;
    this.diskText = null;
    this.dirty = false;
    this.saving = false;
    this.saveTask = null;
    this.saveQueued = false;
    this.saveQueuedForce = false;
    this.savedFlash = false;
    this.conflictDisk = null;
    this.saveError = null;
    this.open = null;
    this.rows = [];
    this.start = 0;
    this.ready = false;
    this.notice = null;
    this.anchor = null;
    this.head = null;
    this.dragging = false;
    this.jump = null;
    this.reveal = null;
    this.revealRow = null;
    this.blocks = null;
    this.anchorBlock = null;
    this.headBlock = null;
    this.commenting = false;
    this.mdMode = "rendered";
  }

  show(path, view, cx, comment) {
    this.shut();
    const target = view === "changes" ? "changes" : "files";
    if (this.mode !== target) {
      this.mode = target;
      this.seenMode = target;
      localStorage.setItem("mode", target);
      setShared("review-panel.mode", target);
    }
    this.open = { path, view: target };
    this.commenting =
      Boolean(comment) || this.comments().some((c) => c.path === path);
    this.mdMode = "rendered";
    this.jump = comment ?? "top";
    this.fetch(cx);
    cx.notify();
  }

  async illustrate(blocks, cx) {
    const paths = blocks.flatMap((b) => (b.pictures ?? []).map((p) => p.path));
    const codes = blocks
      .filter((b) => b.kind === "mermaid" && b.code.trim())
      .map((b) => b.code);
    if (paths.length) await this.pictures.draw(paths, cx);
    if (codes.length) await this.diagrams.draw(codes, cx);
  }

  fetch(cx) {
    const open = this.open;
    const context = this.context;
    const seq = this.loadSeq;
    cx.spawn(async (cx) => {
      try {
        await this.load(context);
      } catch (e) {
        if (this.open === open && this.loadSeq === seq) {
          this.rows = [];
          this.blocks = null;
          this.ready = true;
          this.notice = `Cannot show this file: ${e}`;
        }
      }
      cx.notify();
      if (this.open === open && this.loadSeq === seq && this.blocks) {
        await this.illustrate(this.blocks, cx);
      }
    });
  }

  setRaw(raw, cx) {
    if (raw === this.raw) return;
    this.raw = raw;
    localStorage.setItem("raw", raw ? "1" : "0");
    if (this.open) {
      this.loadSeq += 1;
      this.anchor = null;
      this.head = null;
      this.anchorBlock = null;
      this.headBlock = null;
      this.start = 0;
      this.ready = false;
      this.jump = "top";
      this.fetch(cx);
    }
    cx.notify();
  }

  carryEditorSelection(text) {
    let range = null;
    try {
      range = this.editor?.selected_range() ?? null;
    } catch {
      range = null;
    }
    if (
      !range ||
      !this.rows.length ||
      (range.start === range.end && !this.editorFocused)
    ) {
      return;
    }
    const { anchor, head } = editorLines(
      text,
      range.start,
      range.end,
      this.rows.length,
    );
    this.anchor = anchor;
    this.head = head;
    this.start = Math.floor(anchor / PAGE) * PAGE;
    this.select();
    this.revealRow = anchor;
    this.focus(this.draft);
  }

  setCommenting(commenting, cx) {
    if (commenting === this.commenting) return;
    if (!this.ready) {
      this.commenting = commenting;
      if (!commenting) this.cancel();
      cx.notify();
      return;
    }
    this.loadSeq += 1;
    if (commenting) {
      const liveText = this.editor?.value() ?? this.diskText ?? "";
      if (this.dirty) {
        this.rows = fileRows(liveText);
        if (this.conflictDisk === null) this.flushSave(cx);
      }
      this.commenting = true;
      this.carryEditorSelection(liveText);
    } else {
      this.commenting = false;
      this.cancel();
    }
    cx.notify();
  }

  setMdMode(mode, cx) {
    if (mode === this.mdMode || !this.open) return;
    if (!this.ready) {
      this.mdMode = mode;
      this.cancel();
      cx.notify();
      return;
    }
    this.loadSeq += 1;
    const prev = this.mdMode;
    const liveText = this.editor?.value() ?? this.diskText ?? "";
    if (prev === "edit" && this.dirty && this.conflictDisk === null) {
      this.flushSave(cx);
    }
    this.mdMode = mode;
    if (mode === "edit") {
      this.blocks = null;
      this.cancel();
    } else if (mode === "comment") {
      this.blocks = null;
      this.rows = fileRows(liveText);
      if (prev === "edit") this.carryEditorSelection(liveText);
    } else {
      this.cancel();
      this.rows = fileRows(liveText);
      const dir = `${this.root}/${this.open.path}`.replace(/\/[^/]*$/, "");
      this.blocks = markdownBlocks(
        liveText,
        this.on ? null : (src) => pictureFile(src, dir),
      );
      const blocks = this.blocks;
      cx.spawn(async (cx) => {
        await this.illustrate(blocks, cx);
      });
    }
    cx.notify();
  }

  toggleFile(path, view, cx) {
    if (this.open?.path === path && this.open.view === view) {
      this.shut();
      cx.notify();
    } else {
      this.show(path, view, cx);
    }
  }

  async load(context) {
    const open = this.open;
    const root = this.root;
    const on = context.on;
    const seq = this.loadSeq;
    if (!open || !root) return;
    const change =
      open.view === "changes"
        ? this.files.find((f) => f.path === open.path)
        : null;
    const drawn =
      isMarkdown(open.path) &&
      (open.view === "changes" ? !this.raw : this.mdMode === "rendered");
    let rows = [];
    let notice = null;
    let blocks = null;
    if (!drawn && change && !change.fresh && (this.hasHead || change.status !== "A")) {
      const args = [
        ...READ,
        "diff",
        ...(this.hasHead ? ["HEAD"] : []),
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        open.path,
      ];
      const r = await exec("git", args, { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n");
      const first = all.findIndex((l) => l.startsWith("@@"));
      if (first < 0) {
        notice = change.binary ? "Binary file changed" : "No text diff available";
      } else {
        rows = diffRows(all.slice(first));
      }
    } else {
      const readSaveSeq = this.saveSeq;
      const text = await readTextFile(`${root}/${open.path}`, { on }).catch(
        () => null,
      );
      if (text === null) {
        notice =
          "Cannot show this file (missing, binary, larger than 1 MiB, or unreadable)";
      } else if (text.includes("\0")) {
        notice = "Binary file";
      } else {
        if (
          open.view === "files" &&
          this.current(context) &&
          this.open === open &&
          this.loadSeq === seq &&
          // A save that ended during the read matters only when the editor
          // already shows this file. A file that has no editor yet needs one.
          (this.saveSeq === readSaveSeq ||
            this.editorRoot !== root ||
            this.editorPath !== open.path)
        ) {
          this.syncEditor(root, open.path, text, !on);
        }
        const live =
          open.view === "files" &&
          (this.dirty || this.saving || this.saveSeq !== readSaveSeq) &&
          this.editorRoot === root &&
          this.editorPath === open.path &&
          this.editor
            ? this.editor.value()
            : text;
        rows = fileRows(live);
        const drawnNow =
          isMarkdown(open.path) &&
          (open.view === "changes" ? !this.raw : this.mdMode === "rendered");
        if (drawnNow) {
          const dir = `${root}/${open.path}`.replace(/\/[^/]*$/, "");
          blocks = markdownBlocks(
            live,
            on ? null : (src) => pictureFile(src, dir),
          );
        } else if (change) {
          for (const row of rows) row.kind = "+";
        }
      }
    }
    if (!this.current(context) || this.open !== open || this.loadSeq !== seq) {
      return;
    }
    this.setRows(rows, notice, blocks);
  }

  setRows(rows, notice, blocks = null) {
    this.notice = notice;
    this.ready = true;
    this.blocks = blocks;
    const old = this.rows;
    if (
      rows.length === old.length &&
      rows.every(
        (r, i) =>
          r.kind === old[i].kind && r.n === old[i].n && r.text === old[i].text,
      )
    ) {
      return;
    }
    this.rows = rows;
    this.anchor = null;
    this.head = null;
    this.anchorBlock = null;
    this.headBlock = null;
    this.dragging = false;
    if (this.start >= rows.length) this.start = 0;
  }

  // ---------------------------------------------------------------- selection and comments

  focus(target) {
    target.focus();
  }

  copyQuote(quote, cx) {
    if (!quote?.length) return;
    cx.write_to_clipboard(quote.join("\n"));
    this.copied = true;
    this.copiedTimer?.cancel();
    this.copiedTimer = cx.timer.after(1500, (cx) => {
      this.copied = false;
      cx.notify();
    });
    cx.notify();
  }

  press(i, e, cx) {
    cx.stop_propagation();
    if (e.modifiers?.shift && this.anchor !== null) {
      this.head = i;
    } else {
      this.anchor = i;
      this.head = i;
    }
    this.dragging = true;
    this.select();
    cx.notify();
  }

  drag(i, cx) {
    if (!this.dragging || this.head === i) return;
    this.head = i;
    this.select();
    cx.notify();
  }

  pressBlock(i, e, cx) {
    cx.stop_propagation();
    if (!(e.modifiers?.shift && this.anchorBlock !== null)) {
      this.anchorBlock = i;
    }
    this.spanBlocks(i);
    this.dragging = true;
    this.select();
    cx.notify();
  }

  dragBlock(i, cx) {
    if (!this.dragging || this.anchorBlock === null || this.headBlock === i) {
      return;
    }
    this.spanBlocks(i);
    this.select();
    cx.notify();
  }

  spanBlocks(i) {
    const a = this.blocks[this.anchorBlock];
    const b = this.blocks[i];
    this.headBlock = i;
    this.anchor = Math.min(a.from, b.from) - 1;
    this.head = Math.max(a.to, b.to) - 1;
  }

  release(cx) {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.pick) this.focus(this.draft);
    cx.notify();
  }

  select() {
    const pick = this.open
      ? selection(this.rows, this.anchor, this.head, this.open.path)
      : null;
    if (!pick) return;
    if (this.editing || this.replying) {
      this.editing = null;
      this.replying = null;
      this.draft.set_value("");
      this.hasText = false;
    }
    this.pick = { ...pick, view: this.open.view };
    this.copied = false;
    this.status = null;
  }

  cancel() {
    this.pick = null;
    this.editing = null;
    this.replying = null;
    this.anchor = null;
    this.head = null;
    this.anchorBlock = null;
    this.headBlock = null;
    this.dragging = false;
    this.copied = false;
    this.draft.set_value("");
    this.hasText = false;
  }

  save(cx) {
    const text = this.draft.value().trim();
    if (!text || !this.ctx) return;
    if (this.editing) {
      const c = this.comments().find((c) => c.id === this.editing);
      if (c) c.text = text;
    } else if (this.replying) {
      const c = this.comments().find((c) => c.id === this.replying);
      if (c) {
        c.reply = text;
        c.state = "open";
        delete c.resolvedAt;
      }
    } else if (this.pick) {
      const entry = this.entry();
      entry.seq += 1;
      entry.comments.push({ id: `c${entry.seq}`, ...this.pick, text });
    } else {
      return;
    }
    this.persist();
    this.cancel();
    this.focus(this.handle);
    cx.notify();
  }

  edit(c, cx) {
    this.pick = null;
    this.anchor = null;
    this.head = null;
    this.editing = c.id;
    this.replying = null;
    this.status = null;
    this.copied = false;
    this.draft.set_value(c.text);
    this.hasText = true;
    this.focus(this.draft);
    cx.notify();
  }

  reply(c, cx) {
    this.pick = null;
    this.anchor = null;
    this.head = null;
    this.editing = null;
    this.replying = c.id;
    this.status = null;
    this.copied = false;
    this.draft.set_value(c.reply ?? "");
    this.hasText = Boolean(c.reply);
    this.focus(this.draft);
    cx.notify();
  }

  discardReply(c, cx) {
    delete c.reply;
    this.persist();
    if (this.replying === c.id) this.cancel();
    cx.notify();
  }

  resolve(c, cx) {
    c.state = "resolved";
    c.resolvedAt = Date.now();
    delete c.reply;
    delete c.resend;
    this.persist();
    if (this.replying === c.id) this.cancel();
    cx.notify();
  }

  reopen(c, cx) {
    c.state = "open";
    c.resend = true;
    delete c.resolvedAt;
    this.persist();
    this.reply(c, cx);
  }

  remove(c, cx) {
    const set = this.mine();
    if (!set) return;
    set.comments = set.comments.filter((x) => x !== c);
    this.persist();
    this.forget(set, [c.id]);
    if (this.editing === c.id || this.replying === c.id) this.cancel();
    cx.notify();
  }

  removeResolved(cx) {
    const set = this.mine();
    if (!set) return;
    const gone = set.comments
      .filter((c) => stateOf(c) === "resolved")
      .map((c) => c.id);
    set.comments = set.comments.filter((c) => stateOf(c) !== "resolved");
    this.persist();
    this.forget(set, gone);
    cx.notify();
  }

  // ---------------------------------------------------------------- sending and committing

  target() {
    return reviewer();
  }

  send(cx) {
    const { agent } = this.target();
    const root = this.root;
    if (!agent || !root || this.sending) return;
    this.keepNote();
    const entry = this.mine();
    const items = unsent(entry?.comments ?? []);
    if (!items.length) return;
    const name = agentName(agent);
    const dir = replyFolder(root, entry.key);
    const on = this.on;
    const git = this.repo ? "git" : "plain";
    if (agent.status === "blocked") {
      this.status = {
        bad: true,
        text:
          `Not sent: ${name} is waiting for your answer. ` +
          "Answer it, then submit again. Your comments are kept.",
      };
      cx.notify();
      return;
    }
    this.sending = true;
    this.status = null;
    cx.spawn(async (cx) => {
      let sent = false;
      try {
        this.replySeq += 1;
        const filesToClear = items
          .filter((c) => stateOf(c) === "draft")
          .map((c) => `${c.id}.md`);
        const herdrDir = `${root.replace(/\/+$/, "")}/.herdr`;
        const ready = await exec(
          "sh",
          ["-c", PREPARE, "review", dir, git, herdrDir, ...filesToClear],
          { on },
        ).then(
          (r) => r.code === 0,
          () => false,
        );
        const prompt = formatReview({
          root,
          note: entry.note,
          comments: items,
          replies: ready ? dir : null,
        });
        const args = ["send", agent.address, prompt];
        const r = await exec("hc", args, { timeout: SEND_TIMEOUT }).catch((e) => {
          if (/cannot start|not found/i.test(String(e))) return hc(args);
          throw e;
        });
        if (r.code !== 0) {
          throw new Error((r.stderr || r.stdout || "hc send failed").trim());
        }
        this.replySeq += 1;
        markSent(items, Date.now());
        sent = true;
        entry.note = "";
        this.persist();
        if (this.mine() === entry) {
          this.note.set_value("");
          if (this.editing || this.replying) this.cancel();
        }
        const workingNote =
          agent.status === "working" ? " It was working when they arrived." : "";
        const replyNote = ready
          ? ""
          : " Replies were not asked for: the reply folder could not be made.";
        const countLabel = items.length === 1 ? "comment" : "comments";
        this.status = {
          text: `Sent ${items.length} ${countLabel} to ${name}.${workingNote}${replyNote}`,
        };
      } catch (e) {
        this.status = {
          bad: true,
          text:
            `Could not confirm the review was sent: ${String(e).slice(0, 300)}. ` +
            "Look at the agent before submitting again. Your comments are kept.",
        };
      } finally {
        this.sending = false;
        if (sent) this.checkReplies(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  commit(cx) {
    const message = this.commitMsg.value().trim();
    const root = this.root;
    const on = this.on;
    const ctx = this.ctx;
    if (
      !message ||
      !root ||
      !this.repo ||
      !this.files.length ||
      this.committing ||
      this.loading
    ) {
      return;
    }
    this.committing = true;
    this.commitError = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [
          ["add", "-A"],
          ["commit", "-m", message],
        ]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.ctx === ctx) {
          this.commitMsg.set_value("");
          this.hasCommitMsg = false;
          if (this.open?.view === "changes") this.shut();
        }
      } catch (e) {
        if (this.ctx === ctx) {
          this.commitError = `Commit failed: ${String(e?.message ?? e)}`;
        }
      } finally {
        this.committing = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  // ---------------------------------------------------------------- drawing

  changeRows(t, badge) {
    return this.files.map((f) => {
      const parts = f.path.split("/");
      const name = parts.pop();
      const statusColor =
        f.status === "A"
          ? t.ansi2
          : f.status === "D" || f.status === "U"
            ? t.ansi1
            : t.blocked;
      return h_flex()
        .id(`change-${f.path}`)
        .h(28)
        .flex_none()
        .px(8)
        .gap(8)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(this.open?.path === f.path, (e) => e.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleFile(f.path, "changes", cx))
        .child(
          div()
            .w(14)
            .flex_none()
            .text_size(11)
            .text_color(statusColor)
            .child(f.status),
        )
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            .child(
              div()
                .text_color(t.dim)
                .truncate()
                .child(parts.length ? parts.join("/") + "/" : ""),
            )
            .child(div().max_w(260).min_w(0).truncate().child(name)),
        )
        .when(f.add > 0, (e) =>
          e.child(
            div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`),
          ),
        )
        .when(f.del > 0, (e) =>
          e.child(
            div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`),
          ),
        )
        .when(badge.has(f.path), (e) => e.child(badge.draw(f.path)));
    });
  }

  treeRows(prefix, depth, out, t, badge, marks) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const item of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      const open = this.folders.has(path);
      const mark = marks.get(path);
      const markColor =
        mark === "A"
          ? t.ansi2
          : mark === "D" || mark === "U"
            ? t.ansi1
            : t.blocked;
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .when(!item.dir && this.open?.path === path, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) =>
            item.dir
              ? this.toggleFolder(path, cx)
              : this.toggleFile(path, "files", cx),
          )
          .child(
            item.dir
              ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`)
                  .size(12)
                  .flex_none()
                  .text_color(t.dim)
              : div().w(12).flex_none(),
          )
          .child(
            svg(`mods/files/${item.dir ? "folder" : "file"}.svg`)
              .size(14)
              .flex_none()
              .text_color(t.muted),
          )
          .child(div().flex_1().min_w(0).truncate().child(item.name))
          .when(Boolean(mark), (e) =>
            e.child(
              div().flex_none().text_size(11).text_color(markColor).child(mark),
            ),
          )
          .when(!item.dir && badge.has(path), (e) => e.child(badge.draw(path))),
      );
      if (item.dir && open) this.treeRows(path, depth + 1, out, t, badge, marks);
    }
    return out;
  }

  tag(c, t) {
    const state = stateOf(c);
    const waiting = state === "draft" || Boolean(c.reply) || Boolean(c.resend);
    const label =
      state === "draft"
        ? "not sent"
        : state === "resolved"
          ? "resolved"
          : c.reply
            ? "follow-up not sent"
            : c.resend
              ? "reopened, not sent"
              : "sent";
    const color =
      state === "resolved" ? t.ansi2 : waiting ? t.accent : t.dim;
    return div().flex_none().text_size(10.5).text_color(color).child(label);
  }

  commentRows(t, comments) {
    const sorted = sortComments(comments);
    const resolved = sorted.filter((c) => stateOf(c) === "resolved");
    const ordered = [
      ...sorted.filter((c) => stateOf(c) !== "resolved"),
      ...resolved,
    ];
    const rows = ordered.map((c) => {
      const last = c.thread?.length ? c.thread[c.thread.length - 1] : null;
      const said = c.reply
        ? `You: ${c.reply}`
        : last
          ? `${last.by === "agent" ? "Agent" : "You"}: ${last.text}`
          : c.text;
      return v_flex()
        .id(`cr-${c.id}`)
        .h(44)
        .flex_none()
        .px(8)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(this.editing === c.id || this.replying === c.id, (e) =>
          e.bg(t.selected),
        )
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.show(c.path, c.view ?? "files", cx, c.id))
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(div().flex_none().child(c.id))
            .child(div().flex_1().min_w(0).truncate().child(where(c)))
            .child(this.tag(c, t)),
        )
        .child(
          div()
            .w_full()
            .truncate()
            .when(stateOf(c) === "resolved", (e) => e.text_color(t.dim))
            .child(said.split("\n")[0]),
        );
    });
    if (resolved.length) {
      rows.push(
        div()
          .id("delete-resolved")
          .h(44)
          .flex_none()
          .px(8)
          .flex()
          .items_center()
          .text_size(11.5)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.removeResolved(cx))
          .child(`Delete ${resolved.length} resolved`),
      );
    }
    const link = (id, label, action) =>
      div()
        .id(id)
        .flex_none()
        .cursor_pointer()
        .text_color(t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => action(cx))
        .child(label);
    const days = (ms) => {
      const n = Math.floor((Date.now() - ms) / DAY);
      return n < 1 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
    };
    const closedSets = this.sets.filter(
      (s) =>
        s.closedAt &&
        s.root === this.root &&
        (s.on ?? null) === (this.on ?? null) &&
        s.comments.length,
    );
    for (const set of closedSets) {
      const first = sortComments(set.comments)[0];
      const fromLabel =
        set.named && set.name ? `closed tab "${set.name}"` : "a closed tab";
      const countLabel =
        set.comments.length === 1 ? "comment" : "comments";
      rows.push(
        v_flex()
          .id(`closed-${set.key}`)
          .h(44)
          .flex_none()
          .px(8)
          .justify_center()
          .rounded(7)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .text_size(11)
              .text_color(t.dim)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .child(
                    `From ${fromLabel} · ${set.comments.length} ${countLabel} · ` +
                      `closed ${days(set.closedAt)}`,
                  ),
              )
              .child(
                link(`attach-${set.key}`, "Attach to this tab", (cx) =>
                  this.adopt(set, cx),
                ),
              )
              .child(
                link(`drop-${set.key}`, "Delete", (cx) => this.dropSet(set, cx)),
              ),
          )
          .child(
            div()
              .w_full()
              .truncate()
              .text_color(t.dim)
              .child(`${where(first)}: ${first.text.split("\n")[0]}`),
          ),
      );
    }
    return rows;
  }

  commentBox(c, t, width, flag) {
    const state = stateOf(c);
    const resolved = state === "resolved";
    const folded = resolved && !this.unfolded.has(c.id);
    const note = flag ?? (outdated(c, this.rows) ? "these lines have changed" : null);
    const link = (id, label, action) =>
      div()
        .id(id)
        .flex_none()
        .cursor_pointer()
        .text_color(t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => action(cx))
        .child(label);
    const body = (text, color) =>
      text
        .split("\n")
        .map((line) => div().w_full().text_color(color).child(line || " "));
    const said = (who, text, color, extra) =>
      v_flex()
        .w_full()
        .gap(2)
        .pt(5)
        .border_t(1)
        .border_color(t.border)
        .child(
          h_flex()
            .gap(8)
            .text_size(10.5)
            .text_color(t.dim)
            .child(div().flex_1().child(who))
            .when(Boolean(extra), (e) => e.child(extra)),
        )
        .children(body(text, color));
    const last = c.thread?.length ? c.thread[c.thread.length - 1] : null;
    const summary = (
      last ? `${last.by === "agent" ? "Agent" : "You"}: ${last.text}` : c.text
    ).split("\n")[0];
    const activeBorder =
      this.editing === c.id || this.replying === c.id ? t.accent : t.border;

    return v_flex()
      .id(`c-${c.id}`)
      .flex_none()
      .w(width)
      .ml(this.blocks ? 16 : 44)
      .my(4)
      .p(8)
      .gap(4)
      .rounded(7)
      .border_1()
      .border_color(activeBorder)
      .bg(t.raised)
      .text_size(12)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .child(div().flex_none().child(`${c.id} · ${lines(c)}`))
          .child(this.tag(c, t))
          .child(
            div().flex_1().min_w(0).truncate().text_color(t.blocked).child(note ?? ""),
          )
          .when(state === "draft", (e) =>
            e.child(link(`edit-${c.id}`, "Edit", (cx) => this.edit(c, cx))),
          )
          .when(state === "open", (e) =>
            e
              .child(link(`reply-${c.id}`, "Reply", (cx) => this.reply(c, cx)))
              .child(
                link(`resolve-${c.id}`, "Resolve", (cx) => this.resolve(c, cx)),
              ),
          )
          .when(resolved, (e) =>
            e
              .child(
                link(`fold-${c.id}`, folded ? "Show" : "Hide", (cx) => {
                  if (folded) this.unfolded.add(c.id);
                  else this.unfolded.delete(c.id);
                  cx.notify();
                }),
              )
              .child(link(`reopen-${c.id}`, "Reopen", (cx) => this.reopen(c, cx))),
          )
          .child(link(`delete-${c.id}`, "Delete", (cx) => this.remove(c, cx))),
      )
      .when(folded, (e) =>
        e.child(div().w_full().truncate().text_color(t.dim).child(summary)),
      )
      .when(!folded, (e) =>
        e
          .children(body(c.text, t.foreground))
          .children(
            (c.thread ?? []).map((m) =>
              said(m.by === "agent" ? "Agent" : "You", m.text, t.foreground),
            ),
          )
          .when(Boolean(c.reply), (e) =>
            e.child(
              said(
                "You · not sent",
                c.reply ?? "",
                t.muted,
                link(`discard-${c.id}`, "Discard", (cx) => this.discardReply(c, cx)),
              ),
            ),
          ),
      );
  }

  openLink(url, cx) {
    if (/^(?:https?:\/\/[^/\s]|mailto:\S)/i.test(url)) {
      try {
        cx.open_url(url);
      } catch {
        // GPUI rejects malformed or unsupported schemes (`gpui-kit.d.ts`).
      }
      return;
    }
    // A malformed web or mail address is not a file.
    if (/^(?:https?|mailto):/i.test(url)) return;
    const clean = url.split("#")[0];
    if (!isMarkdown(clean) || !this.open || !this.root) return;
    let path = decodeURIComponent(
      clean.startsWith("file://") ? clean.slice(7) : clean,
    );
    if (!path.startsWith("/")) {
      const folder = this.open.path.includes("/")
        ? this.open.path.replace(/\/[^/]*$/, "/")
        : "";
      path = `${this.root}/${folder}${path}`;
    }
    const parts = [];
    for (const part of path.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    path = "/" + parts.join("/");
    if (path.startsWith(this.root + "/")) {
      this.show(path.slice(this.root.length + 1), "files", cx);
    }
  }

  drawn(t, comments, boxWidth) {
    const blocks = this.blocks;
    const out = [];
    const under = new Map();
    const lo =
      this.anchor === null ? -1 : Math.min(this.anchor, this.head) + 1;
    const hi =
      this.anchor === null ? -1 : Math.max(this.anchor, this.head) + 1;
    const room = Math.max(120, (this.size?.width ?? 360) - 34);
    const push = (c, flag) => {
      out.push(this.commentBox(c, t, boxWidth, flag));
      if (this.reveal === c.id) {
        this.scroll.scroll_to_item(out.length - 1);
        this.reveal = null;
      }
    };
    const pager = (id, label, start) =>
      div()
        .id(id)
        .w_full()
        .h(26)
        .flex_none()
        .px(12)
        .flex()
        .items_center()
        .cursor_pointer()
        .bg(t.raised)
        .text_size(11)
        .text_color(t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.start = start;
          this.anchor = null;
          this.head = null;
          this.anchorBlock = null;
          this.headBlock = null;
          this.jump = "top";
          cx.notify();
        })
        .child(label);
    const link = (url, cx) => this.openLink(url, cx);
    const note = (text) => div().w_full().text_size(11).text_color(t.dim).child(text);

    if (this.notice) {
      out.push(
        div()
          .flex_none()
          .px(12)
          .py(8)
          .text_size(11)
          .text_color(t.dim)
          .child(this.notice),
      );
    }
    for (const c of comments.filter((c) => c.path === this.open.path)) {
      const at = c.removed ? -1 : blockFor(blocks, c.to);
      if (at < 0) push(c, "not on a line shown here");
      else under.set(at, [...(under.get(at) ?? []), c]);
    }
    const end = this.start + PAGE;
    if (this.start > 0) {
      out.push(
        pager(
          "page-up",
          `↑ Lines ${Math.max(1, this.start - PAGE + 1)} to ${this.start}`,
          Math.max(0, this.start - PAGE),
        ),
      );
    }
    blocks.forEach((b, i) => {
      if (b.from - 1 < this.start || b.from - 1 >= end) return;
      const picked = hi >= b.from && lo <= b.to;
      const rawShown = b.shown ?? b.text;
      const text = () => {
        const shownText = bareFences(rawShown);
        return TextView.markdown(
          `review-md-${i}-${textKey(shownText)}`,
          shownText,
        ).on_link_click(link);
      };
      const picture =
        b.kind === "mermaid" ? this.diagrams.get(b.code) : undefined;
      const scale = picture?.path ? Math.min(1, room / picture.width) : 1;
      const body = picture?.path
        ? [
            image(picture.path)
              .w(Math.round(picture.width * scale))
              .h(Math.round(picture.height * scale))
              .flex_none(),
          ]
        : picture?.pending
          ? [note("Drawing diagram…"), text()]
          : picture?.error
            ? [text(), note(`Diagram not drawn: ${picture.error}`)]
            : rawShown.trim()
              ? [text()]
              : [];
      if (b.pictures) {
        body.push(
          h_flex()
            .w_full()
            .flex_wrap()
            .items_end()
            .gap(8)
            .children(
              b.pictures.map((item) => {
                const p = this.pictures.get(item.path);
                if (!p || p.pending) return div();
                if (p.error) {
                  return note(`Picture not shown: ${item.src}. ${p.error}`);
                }
                const width = Math.max(
                  1,
                  Math.round(Math.min(item.width ?? p.width, room)),
                );
                const height = Math.max(
                  1,
                  Math.round((width * p.height) / p.width),
                );
                return image(`${PICTURES}/${p.file}`)
                  .w(width)
                  .h(height)
                  .flex_none();
              }),
            ),
        );
      }
      out.push(
        v_flex()
          .id(`block-${i}`)
          .w_full()
          .flex_none()
          .gap(4)
          .py(3)
          .px(16)
          .text_size(13)
          .cursor_pointer()
          .when(picked, (e) => e.bg(t.selected))
          .when(!picked, (e) => e.hover((s) => s.bg(t.hover)))
          .on_mouse_down("left", (e, cx) => this.pressBlock(i, e, cx))
          .on_mouse_move((_e, cx) => this.dragBlock(i, cx))
          .children(body),
      );
      for (const c of under.get(i) ?? []) push(c);
    });
    if (blocks.some((b) => b.from - 1 >= end)) {
      const lastLine = Math.min(this.rows.length, end + PAGE);
      out.push(
        pager(
          "page-down",
          `↓ Lines ${end + 1} to ${lastLine} of ${this.rows.length}`,
          end,
        ),
      );
    }
    this.reveal = null;
    return out;
  }

  code(t, comments, mono, boxWidth, cx) {
    const mine = comments.filter((c) => c.path === this.open.path);
    const under = new Map();
    const out = [];
    const lo = this.anchor === null ? -1 : Math.min(this.anchor, this.head);
    const hi = this.anchor === null ? -1 : Math.max(this.anchor, this.head);
    const end = Math.min(this.rows.length, this.start + PAGE);
    const ext = this.open.path.includes(".")
      ? this.open.path.split(".").pop().toLowerCase()
      : "";
    const palette = {
      comment: t.dim,
      string: t.ansi2,
      keyword: t.ansi5,
      fn: t.ansi4,
      type: t.ansi3,
      number: t.ansi1,
      const: t.ansi6,
    };
    let width = 300;
    let tokBudget = TOK_SLICE;
    let moreToColor = false;
    for (let i = this.start; i < end; i++) {
      const row = this.rows[i];
      row.show ??= untab(row.text.slice(0, 2000)).slice(0, 2000) || " ";
      if (isLine(row) && !row.spans) {
        if (tokBudget > 0) {
          tokBudget -= 1;
          row.spans = tokenizeLine(row.show, ext).map(([s, k]) => [
            s.replace(/ /g, "\u00a0"),
            k,
          ]);
        } else {
          moreToColor = true;
        }
      }
      width = Math.max(width, (row.show.length + 1) * 7 + 70);
    }
    let budget = tokBudget < TOK_SLICE ? FIRST_BUDGET : SPAN_BUDGET;
    if (moreToColor && !this.coloring && cx) {
      this.coloring = true;
      cx.spawn(async (cx) => {
        await cx.sleep(0);
        this.coloring = false;
        cx.notify();
      });
    }
    const push = (c, flag) => {
      out.push(this.commentBox(c, t, boxWidth, flag));
      if (this.reveal === c.id) {
        this.scroll.scroll_to_item(out.length - 1);
        this.reveal = null;
      }
    };
    const pager = (id, label, start) =>
      div()
        .id(id)
        .w_full()
        .min_w(width)
        .h(26)
        .flex_none()
        .px(12)
        .flex()
        .items_center()
        .cursor_pointer()
        .bg(t.raised)
        .text_color(t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.start = start;
          this.anchor = null;
          this.head = null;
          this.jump = "top";
          cx.notify();
        })
        .child(label);

    if (this.notice) {
      out.push(div().flex_none().px(12).py(8).text_color(t.dim).child(this.notice));
    }
    for (const c of mine) {
      const at = locate(c, this.rows);
      if (at < 0) push(c, this.rows.length ? "not on a line shown here" : null);
      else under.set(at, [...(under.get(at) ?? []), c]);
    }
    if (this.start > 0) {
      out.push(
        pager(
          "page-up",
          `↑ Rows ${Math.max(1, this.start - PAGE + 1)} to ${this.start}`,
          Math.max(0, this.start - PAGE),
        ),
      );
    }
    for (let i = this.start; i < end; i++) {
      const row = this.rows[i];
      if (row.kind === "@") {
        out.push(
          div()
            .w_full()
            .min_w(width)
            .h(20)
            .flex_none()
            .px(12)
            .truncate()
            .font_family(mono)
            .bg(t.raised)
            .text_color(t.dim)
            .child(row.show),
        );
      } else if (!isLine(row)) {
        out.push(
          div()
            .w_full()
            .min_w(width)
            .h(20)
            .flex_none()
            .px(12)
            .truncate()
            .font_family(mono)
            .text_color(t.dim)
            .child(row.show),
        );
      } else {
        const picked = i >= lo && i <= hi;
        const spans = row.spans;
        const colored =
          spans && (spans.length > 1 || spans[0][1]) && budget >= spans.length;
        if (colored) budget -= spans.length;
        const signColor =
          row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim;
        const r = h_flex()
          .id(`line-${i}`)
          .w_full()
          .min_w(width)
          .h(20)
          .flex_none()
          .whitespace_nowrap()
          .font_family(mono)
          .cursor_pointer()
          .when(picked, (e) => e.bg(t.selected))
          .when(!picked && row.kind === "+", (e) => e.bg(t.ansi2 + "18"))
          .when(!picked && row.kind === "-", (e) => e.bg(t.ansi1 + "18"))
          .when(!picked, (e) => e.hover((s) => s.bg(t.hover)))
          .on_mouse_down("left", (e, cx) => this.press(i, e, cx))
          .on_mouse_move((_e, cx) => this.drag(i, cx))
          .child(
            div()
              .w(36)
              .mr(8)
              .flex_none()
              .text_right()
              .text_color(under.has(i) ? t.accent : t.dim)
              .child(String(row.n)),
          )
          .child(
            div()
              .w(8)
              .mr(8)
              .flex_none()
              .text_color(signColor)
              .child(row.kind === " " ? "" : row.kind),
          );
        if (colored) {
          for (let j = 0; j < spans.length; j++) {
            const [s, k] = spans[j];
            r.child(
              k
                ? div().flex_none().text_color(palette[k]).child(s)
                : div().flex_none().child(s),
            );
          }
        } else {
          r.child(div().flex_1().min_w(0).truncate().child(row.show));
        }
        out.push(r);
        if (this.revealRow === i) {
          this.scroll.scroll_to_item(out.length - 1);
          this.revealRow = null;
        }
      }
      for (const c of under.get(i) ?? []) push(c);
    }
    if (end < this.rows.length) {
      const lastRow = Math.min(this.rows.length, end + PAGE);
      out.push(
        pager(
          "page-down",
          `↓ Rows ${end + 1} to ${lastRow} of ${this.rows.length}`,
          end,
        ),
      );
    }
    this.reveal = null;
    this.revealRow = null;
    return out;
  }

  emptyListMessage(hasRows) {
    if (hasRows) return null;
    if (this.mode === "comments") {
      return "No comments. Open a file or diff, select lines, and write one.";
    }
    if (!this.root) return this.loading ? "Loading…" : "No folder";
    if (this.error) return this.error;
    if (this.mode === "changes") {
      if (!this.repo) return "Not a git repository. Use Files.";
      return this.loading ? "Loading changes…" : "No uncommitted changes";
    }
    return this.loading || this.pending.has("") ? "Loading files…" : "No files";
  }

  render(cx) {
    const wanted = shared("review-panel.mode");
    if (wanted !== this.seenMode) {
      this.seenMode = wanted;
      if (MODES.includes(wanted) && wanted !== this.mode) {
        if (this.open) this.shut();
        this.mode = wanted;
        localStorage.setItem("mode", wanted);
      }
    }

    const tabsNow = this.tabs();
    const names = tabNames(tabsNow);
    const needFiles =
      this.mode === "files" &&
      this.root &&
      !this.entries.has("") &&
      !this.pending.has("");
    const stale = !this.loading && Date.now() - (this.at ?? 0) > STALE;
    if (
      shown() !== false &&
      (this.key() !== this.context?.key || names !== this.names || needFiles || stale)
    ) {
      this.refresh(cx);
    }

    const t = theme();
    const comments = this.comments();
    const { agent, hint } = this.target();
    const mono = settings().font_family ?? "JetBrains Mono";
    const stop = (_e, cx) => cx.stop_propagation();
    const tabsContent = findNode(layout(), "tabs")?.content;
    const externalBar =
      tabsContent?.mod === "review-panel" && tabsContent?.props?.role === "tabs";

    if (this.jump && this.open && this.ready) {
      if (this.jump === "top") {
        this.scroll.scroll_to_item(0);
      } else {
        const c = comments.find((c) => c.id === this.jump);
        const at = c ? locate(c, this.rows) : -1;
        if (at >= 0) this.start = Math.floor(at / PAGE) * PAGE;
        this.reveal = c?.id ?? null;
      }
      this.jump = null;
    }

    const pulse = agents()
      .map((a) => `${a.address}:${a.status}`)
      .join(" ");
    if (pulse !== this.pulse) {
      this.pulse = pulse;
      if (shown() !== false) this.checkReplies(cx);
    }
    const here = tabsNow.get(this.tab);
    const tabName = !here ? "" : here.named ? here.name : `tab ${here.name}`;

    const counts = new Map();
    const live = comments.filter((c) => stateOf(c) !== "resolved");
    const pending = unsent(comments).length;
    for (const c of live) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    const badge = {
      has: (path) => counts.has(path),
      draw: (path) =>
        div()
          .flex_none()
          .h(16)
          .min_w(16)
          .px(4)
          .flex()
          .items_center()
          .justify_center()
          .rounded(8)
          .bg(t.accent)
          .text_color(t.accent_foreground)
          .text_size(10)
          .child(String(counts.get(path))),
    };
    const marks = new Map(this.files.map((f) => [f.path, f.status]));
    const listRows =
      this.mode === "changes"
        ? this.changeRows(t, badge)
        : this.mode === "files"
          ? this.treeRows("", 0, [], t, badge, marks)
          : this.commentRows(t, comments);
    const empty = this.emptyListMessage(listRows.length > 0);
    const limit =
      this.mode === "changes" && this.limited
        ? "Showing the first 1,000 changed files"
        : this.mode === "files" && this.treeLimited
          ? "File list limited to 500 entries per folder and 5,000 total"
          : null;

    const pill = (id, label, active, action) =>
      div()
        .id(id)
        .h(22)
        .px(8)
        .flex_none()
        .flex()
        .items_center()
        .rounded(5)
        .text_size(11.5)
        .cursor_pointer()
        .bg(active ? t.selected : t.background)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => action(cx))
        .child(label);
    const button = (id, label, enabled, action) =>
      div()
        .id(id)
        .h(30)
        .px(12)
        .flex_none()
        .flex()
        .items_center()
        .rounded(8)
        .text_size(12)
        .bg(enabled ? t.solid : t.raised)
        .text_color(enabled ? t.solid_foreground : t.dim)
        .when(enabled, (e) => e.cursor_pointer())
        .on_click((_e, cx) => {
          if (enabled) action(cx);
        })
        .child(label);

    const openMd = Boolean(this.open) && isMarkdown(this.open.path);
    const openFilesMd = openMd && this.open.view === "files" && !this.notice;
    const openChangesMd = openMd && this.open.view === "changes";
    const canToggleCode =
      Boolean(this.open) &&
      this.open.view === "files" &&
      !openMd &&
      !this.notice;
    const inEditor =
      (canToggleCode && !this.commenting) ||
      (openFilesMd && this.mdMode === "edit");
    const canFormatMd =
      openFilesMd &&
      this.mdMode === "edit" &&
      !this.on &&
      this.canEdit &&
      Boolean(this.editor);
    const editLabel = this.on ? "Read" : "Edit";
    const fileCount = this.open ? (counts.get(this.open.path) ?? 0) : 0;
    const commentLabel = fileCount ? `Comment ${fileCount}` : "Comment";
    const saveState =
      !inEditor || !this.canEdit
        ? ""
        : this.saving
          ? "Saving…"
          : this.conflictDisk !== null
            ? "Conflict"
            : this.dirty
              ? "Edited"
              : this.savedFlash
                ? "Saved"
                : "";

    const title = externalBar
      ? this.mode === "files"
        ? "Files"
        : this.mode === "changes"
          ? "Changes"
          : "Comments"
      : "Review";
    const subtitle = this.open
      ? this.open.path
      : this.mode === "files"
        ? (this.root?.split(/[\\/]/).pop() ?? "")
        : this.mode === "comments"
          ? tabName
          : "";
    const add = this.files.reduce((n, f) => n + f.add, 0);
    const del = this.files.reduce((n, f) => n + f.del, 0);

    const writing =
      this.editing || this.replying
        ? comments.find((c) => c.id === (this.editing ?? this.replying))
        : this.pick;
    const canSend = Boolean(agent) && pending > 0 && !this.sending;
    const agentState =
      agent?.status === "working"
        ? " · working"
        : agent?.status === "blocked"
          ? " · waiting for you"
          : "";
    const to = agent ? `To ${agentName(agent)}${agentState}` : hint;
    const showSubmit =
      pending > 0 ||
      Boolean(this.status) ||
      (this.mode === "comments" && !this.open);
    const showCommit =
      this.mode === "changes" &&
      this.repo &&
      (this.files.length > 0 || Boolean(this.commitError) || this.committing);
    const canCommit = Boolean(
      this.hasCommitMsg &&
        this.root &&
        this.files.length &&
        !this.committing &&
        !this.loading,
    );

    const header = h_flex()
      .h(42)
      .flex_none()
      .px(14)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .when(Boolean(this.open), (e) =>
        e.child(
          div()
            .id("review-back")
            .w(20)
            .flex_none()
            .cursor_pointer()
            .text_color(t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              this.shut();
              cx.notify();
            })
            .child("←"),
        ),
      )
      .child(div().flex_none().font_semibold().child(title))
      .when(!this.open && externalBar && this.mode === "changes", (e) =>
        e.child(
          div()
            .flex_none()
            .px(5)
            .py(1)
            .rounded(4)
            .border_1()
            .border_color(t.border)
            .text_size(10)
            .text_color(t.muted)
            .child(`${this.files.length} files`),
        ),
      )
      .when(
        !this.open && externalBar && this.mode === "comments" && live.length > 0,
        (e) =>
          e.child(
            div()
              .flex_none()
              .px(5)
              .py(1)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .text_size(10)
              .text_color(t.muted)
              .child(`${live.length} open`),
          ),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(12)
          .text_color(t.dim)
          .when(!this.open && this.mode === "files", (e) => e.text_right())
          .child(subtitle),
      )
      .when(Boolean(saveState), (e) =>
        e.child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(this.conflictDisk !== null ? t.blocked : t.dim)
            .child(saveState),
        ),
      )
      .when(
        !this.open && externalBar && this.mode === "changes" && (add > 0 || del > 0),
        (e) =>
          e
            .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`))
            .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`)),
      )
      .when(!this.open && !externalBar, (e) =>
        e.child(
          h_flex()
            .flex_none()
            .gap(2)
            .p(2)
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .child(
              pill("mode-files", "Files", this.mode === "files", (cx) =>
                this.setMode("files", cx),
              ),
            )
            .child(
              pill("mode-changes", "Changes", this.mode === "changes", (cx) =>
                this.setMode("changes", cx),
              ),
            )
            .child(
              pill(
                "mode-comments",
                live.length ? `Comments ${live.length}` : "Comments",
                this.mode === "comments",
                (cx) => this.setMode("comments", cx),
              ),
            ),
        ),
      )
      .when(openChangesMd, (e) =>
        e.child(
          h_flex()
            .flex_none()
            .gap(2)
            .p(2)
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .child(
              pill("shape-rendered", "Preview", !this.raw, (cx) =>
                this.setRaw(false, cx),
              ),
            )
            .child(
              pill("shape-raw", "Diff", this.raw, (cx) => this.setRaw(true, cx)),
            ),
        ),
      )
      .when(canFormatMd, (e) =>
        e.child(
          div()
            .id("md-format")
            .h(26)
            .px(8)
            .flex_none()
            .flex()
            .items_center()
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .text_size(11.5)
            .cursor_pointer()
            .text_color(t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.formatMarkdownEditor(cx))
            .child("Format"),
        ),
      )
      .when(openFilesMd, (e) =>
        e.child(
          h_flex()
            .flex_none()
            .gap(2)
            .p(2)
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .child(
              pill("md-rendered", "Preview", this.mdMode === "rendered", (cx) =>
                this.setMdMode("rendered", cx),
              ),
            )
            .child(
              pill("md-edit", editLabel, this.mdMode === "edit", (cx) =>
                this.setMdMode("edit", cx),
              ),
            )
            .child(
              pill("md-comment", commentLabel, this.mdMode === "comment", (cx) =>
                this.setMdMode("comment", cx),
              ),
            ),
        ),
      )
      .when(canToggleCode, (e) =>
        e.child(
          h_flex()
            .flex_none()
            .gap(2)
            .p(2)
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .child(
              pill("code-edit", editLabel, !this.commenting, (cx) =>
                this.setCommenting(false, cx),
              ),
            )
            .child(
              pill("code-comment", commentLabel, this.commenting, (cx) =>
                this.setCommenting(true, cx),
              ),
            ),
        ),
      );

    return v_flex()
      .id("review")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => this.release(cx))
      .on_hover((over, cx) => {
        if (!over && this.dragging) {
          this.dragging = false;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        const mod = Boolean(e.modifiers?.platform || e.modifiers?.control);
        const key = (e.key ?? "").toLowerCase();
        if (mod && key === "s" && inEditor && this.canEdit) {
          cx.stop_propagation();
          this.flushSave(cx);
          return;
        }
        if (mod && key === "c" && !inEditor && writing?.quote?.length && !this.hasText) {
          cx.stop_propagation();
          this.copyQuote(writing.quote, cx);
          return;
        }
        if (key === "escape") {
          this.typingCommit = false;
          this.focus(this.handle);
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(header)
      .when(!this.open, (e) =>
        e.child(
          div()
            .flex_1()
            .min_h(0)
            .relative()
            .child(
              v_flex()
                .id("review-list")
                .absolute()
                .inset_0()
                .overflow_y_scroll()
                .p(6)
                .children(listRows)
                .when(Boolean(empty), (e) =>
                  e.child(div().p(8).text_size(12).text_color(t.dim).child(empty)),
                )
                .when(Boolean(limit), (e) =>
                  e.child(div().p(8).text_size(11).text_color(t.dim).child(limit)),
                ),
            )
            .child(Scrollbar.vertical("review-list").absolute().inset_0()),
        ),
      )
      .when(Boolean(this.open) && inEditor && this.conflictDisk !== null, (e) =>
        e.child(
          h_flex()
            .flex_none()
            .px(14)
            .py(6)
            .gap(10)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .text_size(11.5)
            .child(
              div()
                .flex_1()
                .text_color(t.blocked)
                .child("File changed on disk while you were editing."),
            )
            .child(
              div()
                .id("conflict-overwrite")
                .flex_none()
                .cursor_pointer()
                .text_color(t.muted)
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => this.flushSave(cx, true))
                .child("Overwrite"),
            )
            .child(
              div()
                .id("conflict-reload")
                .flex_none()
                .cursor_pointer()
                .text_color(t.muted)
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => this.reloadFromDisk(cx))
                .child("Reload"),
            ),
        ),
      )
      .when(Boolean(this.open) && inEditor && Boolean(this.saveError), (e) =>
        e.child(
          div()
            .flex_none()
            .px(14)
            .py(6)
            .border_b(1)
            .border_color(t.border)
            .text_size(11.5)
            .text_color(t.ansi1)
            .child(this.saveError),
        ),
      )
      .when(Boolean(this.open) && inEditor, (e) =>
        e.child(
          !this.ready || !this.editor
            ? div()
                .flex_1()
                .min_h(0)
                .px(12)
                .py(8)
                .text_size(12)
                .text_color(t.dim)
                .child("Loading…")
            : Editor.new(this.editor).flex_1().min_h(0),
        ),
      )
      .when(Boolean(this.open) && !inEditor, (e) => {
        const drawnBoxW = Math.max(180, (this.size?.width ?? 360) - 34);
        const codeBoxW = Math.max(180, (this.size?.width ?? 360) - 72);
        return e.child(
          div()
            .flex_1()
            .min_h(0)
            .relative()
            .text_size(11)
            .child(
              v_flex()
                .id("review-code")
                .absolute()
                .inset_0()
                .overflow_scroll()
                .track_scroll(this.scroll)
                .children(
                  !this.ready
                    ? [div().flex_none().px(12).py(8).text_color(t.dim).child("Loading…")]
                    : this.blocks
                      ? this.drawn(t, comments, drawnBoxW)
                      : this.code(t, comments, mono, codeBoxW, cx),
                ),
            )
            .when(this.ready, (e) =>
              e.child(Scrollbar.new("review-code").absolute().inset_0()),
            ),
        );
      })
      .when(Boolean(writing), (e) => {
        const draftHeading = this.editing
          ? `Edit ${writing.id} on`
          : this.replying
            ? `Follow-up to ${writing.id} on`
            : "Comment on";
        const draftHint = this.replying
          ? "Goes out with the next review"
          : "Cmd-Enter adds it · Copy or Cmd-C copies lines";
        const saveLabel = this.editing
          ? "Save"
          : this.replying
            ? "Save follow-up"
            : "Add comment";
        return e.child(
          v_flex()
            .flex_none()
            .p(10)
            .gap(6)
            .border_t(1)
            .border_color(t.border)
            .child(
              h_flex()
                .gap(10)
                .items_center()
                .text_size(11)
                .text_color(t.muted)
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .child(`${draftHeading} ${where(writing)}`),
                )
                .when(Boolean(writing.quote?.length), (e) =>
                  e.child(
                    div()
                      .id("draft-copy")
                      .flex_none()
                      .cursor_pointer()
                      .text_color(this.copied ? t.ansi2 : t.muted)
                      .hover((s) => s.text_color(t.foreground))
                      .on_click((_e, cx) => this.copyQuote(writing.quote, cx))
                      .child(this.copied ? "Copied" : "Copy"),
                  ),
                )
                .child(
                  div()
                    .id("draft-cancel")
                    .flex_none()
                    .cursor_pointer()
                    .hover((s) => s.text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.cancel();
                      cx.notify();
                    })
                    .child("Cancel"),
                ),
            )
            .child(
              div()
                .id("draft")
                .w_full()
                .p(8)
                .rounded(8)
                .border_1()
                .border_color(t.border)
                .cursor_text()
                .on_mouse_down("left", stop)
                .child(
                  Textarea.new(this.draft)
                    .w_full()
                    .h(72)
                    .text_size(12)
                    .text_color(t.foreground),
                ),
            )
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(div().flex_1().text_size(11).text_color(t.dim).child(draftHint))
                .child(
                  button("draft-save", saveLabel, this.hasText, (cx) =>
                    this.save(cx),
                  ),
                ),
            ),
        );
      })
      .when(showSubmit, (e) => {
        const submitLabel = this.sending
          ? "Sending…"
          : pending
            ? `Submit review (${pending})`
            : "Submit review";
        return e.child(
          v_flex()
            .flex_none()
            .p(10)
            .gap(8)
            .border_t(1)
            .border_color(t.border)
            .when(Boolean(this.status), (e) =>
              e.child(
                div()
                  .w_full()
                  .text_size(11)
                  .text_color(this.status.bad ? t.ansi1 : t.muted)
                  .child(this.status.text),
              ),
            )
            .when(pending > 0, (e) =>
              e.child(
                div()
                  .id("note")
                  .w_full()
                  .h(30)
                  .px(10)
                  .flex()
                  .items_center()
                  .rounded(8)
                  .border_1()
                  .border_color(t.border)
                  .cursor_text()
                  .on_mouse_down("left", stop)
                  .child(
                    Input.new(this.note)
                      .h_full()
                      .text_size(12)
                      .text_color(t.foreground),
                  ),
              ),
            )
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11)
                    .text_color(t.muted)
                    .child(to),
                )
                .child(button("submit", submitLabel, canSend, (cx) => this.send(cx))),
            ),
        );
      })
      .when(showCommit, (e) =>
        e.child(
          v_flex()
            .flex_none()
            .p(10)
            .gap(6)
            .border_t(1)
            .border_color(t.border)
            .when(Boolean(this.commitError), (e) =>
              e.child(
                div()
                  .w_full()
                  .text_size(11)
                  .text_color(t.ansi1)
                  .child(this.commitError),
              ),
            )
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  div()
                    .id("commit-message")
                    .flex_1()
                    .min_w(0)
                    .h(30)
                    .px(10)
                    .flex()
                    .items_center()
                    .rounded(8)
                    .border_1()
                    .border_color(this.typingCommit ? t.accent : t.border)
                    .cursor_text()
                    .on_mouse_down("left", stop)
                    .child(
                      Input.new(this.commitMsg)
                        .h_full()
                        .text_size(12)
                        .text_color(t.foreground),
                    ),
                )
                .child(
                  button(
                    "commit",
                    this.committing ? "Committing…" : "Commit",
                    canCommit,
                    (cx) => this.commit(cx),
                  ),
                ),
            ),
        ),
      );
  }
}
