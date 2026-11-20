// Drop-in replacement for Herdr's shipped `files` panel.
// Preserves the lazy file tree, git marks, and read-only preview, and adds
// support for opening files published to `shared("file-links.open")`.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import {
  checking,
  exec,
  focused,
  home,
  panes,
  readTextFile,
  settings,
  shared,
  spaces,
  theme,
  watchFolder,
  window,
} from "herdr";
import {
  SHARED_OPEN,
  diskPath,
  displayPath,
  isAbsolutePath,
  isFreshRequest,
  lineToOffset,
  toPanelPath,
} from "./path.js";

const LANG = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
};

const PER_FOLDER = 500;
const TOTAL = 5000;
const MAX_PREVIEW_CHARS = 400000;

const UNIX_LIST_SCRIPT = `
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
    printf "%s\0%s\0" "$kind" "$name"
    n=$((n + 1))
    [ "$n" -gt 500 ] && break
  done
  test -d "$1"
`;

function location() {
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
  };
}

function locationKey() {
  return JSON.stringify(location());
}

async function listWindowsDirectory(path, on) {
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

async function listDirectory(path, on) {
  if (!on && window()?.platform === "windows") {
    return listWindowsDirectory(path, on);
  }
  let r;
  try {
    r = await exec("sh", ["-c", UNIX_LIST_SCRIPT, "files", path], { on });
  } catch (err) {
    if (on && String(err).includes("cannot start sh: program not found")) {
      return listWindowsDirectory(path, on);
    }
    throw err;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  }
  return out;
}

export class FilesPanel {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.context = null;
    this.root = null;
    this.on = null;
    this.file = null;
    this.fileLocal = false;
    this.fileError = null;
    this.code = null;
    this.error = null;
    this.limited = false;
    this.loading = false;
    this.watched = null;
    this.folderWatch = null;
    this.showSeq = 0;

    // A fresh request may have caused this panel to mount from hidden for the
    // first time, so leave it unseen; skip stale requests from earlier runs.
    const initial = shared(SHARED_OPEN);
    this.seenOpenId = isFreshRequest(initial) ? null : (initial?.id ?? null);
    this.pendingOpen = null;
    this.openTimer = null;

    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  stopWatch() {
    this.folderWatch?.cancel();
    this.folderWatch = null;
    this.watched = null;
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.stopWatch();
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          const handle = watchFolder(root);
          this.folderWatch = handle;
          const changed = await handle;
          if (this.folderWatch === handle) this.folderWatch = null;
          if (this.context !== context) return;
          if (changed.length && this.current(context)) this.refresh(cx);
        }
      } catch {
        if (this.context === context) {
          this.folderWatch = null;
          this.watched = null;
        }
      }
    });
  }

  current(context) {
    return this.context === context && locationKey() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await listDirectory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, list]) => n + list.length, 0);
    const limit = Math.max(0, Math.min(PER_FOLDER, TOTAL - used));
    const sorted = entries
      .slice(0, limit)
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    this.entries.set(path, sorted);
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) {
      this.limited = true;
    }
  }

  refresh(cx) {
    const { cwd, on } = location();
    const next = locationKey();
    if (next !== this.context?.key) {
      if (this.context) {
        this.saved.set(this.context.key, {
          folders: this.folders,
          file: this.file,
          fileLocal: this.fileLocal,
        });
      }
      const saved = this.saved.get(next);
      this.stopWatch();
      this.context = { key: next, cwd, on };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.show(null);
      this.error = null;
      this.limited = false;
      this.loading = false;
      if (saved?.file) {
        this.show(saved.file, cx, { local: saved.fileLocal });
      }
    }
    if (!cwd || this.loading) return;

    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], {
          cwd,
          on,
        }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec(
            "git",
            [
              "--no-optional-locks",
              "-c",
              "core.fsmonitor=false",
              "status",
              "--porcelain=v1",
              "-z",
              "--no-renames",
              "--untracked-files=all",
            ],
            { cwd, on },
          ).catch(() => null);
          if (status?.code === 0) {
            const topDir = top.stdout.trim();
            for (const entry of status.stdout
              .split("\0")
              .filter(Boolean)
              .slice(0, TOTAL)) {
              const xy = entry.slice(0, 2);
              const mark =
                xy === "??" || xy.includes("A")
                  ? "A"
                  : xy.includes("U")
                    ? "U"
                    : xy.includes("D")
                      ? "D"
                      : "M";
              marks[`${topDir}/${entry.slice(3)}`] = mark;
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (err) {
        if (this.current(context)) this.error = String(err);
      } finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) {
        if (folder === path || folder.startsWith(`${path}/`)) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context);
          } catch (err) {
            if (this.current(context)) this.error = String(err);
          } finally {
            if (this.context === context) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  openFromLink(request, cx) {
    const target = toPanelPath(request, this.root);
    if (!target) return;
    if (!isAbsolutePath(target) && target.includes("/")) {
      const parts = target.split("/").slice(0, -1);
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        this.folders.add(prefix);
      }
    }
    this.show(target, cx, {
      line: request.line,
      col: request.col,
      local: true,
    });
  }

  show(path, cx, opts = {}) {
    this.showSeq += 1;
    const seq = this.showSeq;
    this.code?.release();
    this.code = null;
    this.file = path;
    this.fileLocal = Boolean(opts.local);
    this.fileError = null;
    if (!path || !cx) return;

    const context = this.context;
    const fullPath = diskPath(this.root, path);
    const readOn = opts.local ? null : this.on;
    const line = opts.line ?? null;
    const col = opts.col ?? 1;

    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(fullPath, { on: readOn });
        if (this.showSeq !== seq || this.file !== path || !this.current(context)) {
          return;
        }
        if (text === null) {
          this.fileError = "This file is no longer available";
          return;
        }
        if (text.includes("\0")) {
          this.fileError = "Binary file · no text preview";
          return;
        }
        const t = theme();
        const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
        const value =
          text.length > MAX_PREVIEW_CHARS
            ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n… (file truncated)`
            : text;
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          value,
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
        if (line) {
          const offset = lineToOffset(value, line, col);
          this.code.set_selected_range({ start: offset, end: offset });
        }
      } catch {
        if (this.showSeq === seq && this.file === path && this.current(context)) {
          this.fileError =
            "Cannot preview this file (binary, too large, or unreadable)";
        }
      } finally {
        cx.notify();
      }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      const mark = this.marks[`${this.root}/${path}`];
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
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) =>
            entry.dir ? this.toggle(path, cx) : this.show(path, cx),
          )
          .child(
            entry.dir
              ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`)
                  .size(12)
                  .flex_none()
                  .text_color(t.dim)
              : div().w(12).flex_none(),
          )
          .child(
            svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`)
              .size(14)
              .flex_none()
              .text_color(t.muted),
          )
          .child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(
                  mark === "A"
                    ? t.ansi2
                    : mark === "D" || mark === "U"
                      ? t.ansi1
                      : t.blocked,
                )
                .child(mark),
            ),
          ),
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (!checking() && locationKey() !== this.context?.key) {
      this.refresh(cx);
    }
    if (!checking()) {
      const req = shared(SHARED_OPEN);
      if (req?.id && req.id !== this.seenOpenId && req.path) {
        this.seenOpenId = req.id;
        this.pendingOpen = req;
      }
      if (this.pendingOpen && !this.openTimer) {
        this.openTimer = cx.timer.after(0, (cx) => {
          this.openTimer = null;
          const nextReq = this.pendingOpen;
          if (!nextReq) return;
          this.pendingOpen = null;
          this.openFromLink(nextReq, cx);
        });
      }
    }

    const t = theme();
    const headerLabel = this.file
      ? displayPath(this.file, home())
      : (this.root?.split(/[\\/]/).pop() ?? "");

    return v_flex()
      .id("files")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .when(Boolean(this.file), (el) =>
            el.child(
              div()
                .id("files-back")
                .w(20)
                .cursor_pointer()
                .text_color(t.muted)
                .on_click((_e, cx) => {
                  this.show(null);
                  cx.notify();
                })
                .child("←"),
            ),
          )
          .child(div().font_semibold().child("Files"))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_size(12)
              .text_color(t.dim)
              .child(headerLabel),
          ),
      )
      .when(!this.file, (el) =>
        el.child(
          v_flex()
            .id("files-tree")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .p(6)
            .children(this.rows("", 0, [], t))
            .when(Boolean(this.error) || !this.entries.get("")?.length, (el) =>
              el.child(
                div()
                  .p(8)
                  .text_size(12)
                  .text_color(t.dim)
                  .child(
                    this.error ||
                      (this.loading
                        ? "Loading files…"
                        : this.root
                          ? "No files"
                          : "No folder"),
                  ),
              ),
            )
            .when(this.limited, (el) =>
              el.child(
                div()
                  .p(8)
                  .text_size(11)
                  .text_color(t.dim)
                  .child(
                    "File list limited to 500 entries per folder and 5,000 total",
                  ),
              ),
            ),
        ),
      )
      .when(Boolean(this.file), (el) =>
        el.child(
          this.code
            ? Editor.new(this.code).flex_1().min_h(0)
            : div()
                .p(12)
                .text_color(t.dim)
                .child(this.fileError || "Loading file…"),
        ),
      );
  }

  async close() {
    this.openTimer?.cancel();
    this.openTimer = null;
    this.stopWatch();
    this.code?.release();
    this.code = null;
  }
}
