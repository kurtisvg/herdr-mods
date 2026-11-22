// Standalone markdown viewer for a split pane or dedicated tab.
// Props: `{ role?: "viewer", file?: "/absolute/path.md", on?: "<machine>" }`.
// Prompts for a path when `file` is omitted, watches local folders for edits,
// and polls remote files.

import { div } from "gpui-kit";
import {
  v_flex,
  h_flex,
  InputState,
  Input,
  EditorState,
  Editor,
} from "gpui-base";
import {
  props,
  readTextFile,
  theme,
  settings,
  spaces,
  checking,
  watchFolder,
} from "herdr";
import {
  isMarkdown,
  editorLanguage,
  resolveLink,
  lineRangeOffsets,
  watchDir,
  watchBatchMatches,
} from "./model.js";
import { MarkdownDoc } from "./doc.js";
import { Pictures } from "./pictures.js";
import { Diagrams } from "./diagrams.js";

const POLL_MS = 3000;

export class Viewer {
  init(_props, cx) {
    this.pictures = new Pictures();
    this.diagrams = new Diagrams();
    this.doc = new MarkdownDoc("mv", this.pictures, this.diagrams);
    this.history = [];
    this.editor = null;
    this.text = null;
    this.lines = null;
    this.size = null;
    this.watched = null;
    this.folderWatch = null;
    this.pollTimer = null;
    this.reloadQueued = false;
    this.input = InputState.new({ placeholder: "/path/to/file.md" });
    this.input.on("submit", (_e, cx) => {
      const path = this.input.value().trim();
      if (path) this.open(path, this.on, cx);
    });
    if (checking()) return;

    const p = props() ?? {};
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem("viewer.open") ?? "null");
    } catch {
      saved = null;
    }
    const here = spaces().find((s) => s.active)?.machine ?? null;
    if (p.file) this.open(p.file, p.on ?? null, cx, true);
    else if (saved?.file) this.open(saved.file, saved.on ?? null, cx, true);
    else this.on = here;
  }

  close() {
    this.stopWatch();
    this.editor?.release();
    this.editor = null;
  }

  stopWatch() {
    this.watched = null;
    if (this.folderWatch) {
      this.folderWatch.cancel();
      this.folderWatch = null;
    }
    if (this.pollTimer) {
      this.pollTimer.cancel();
      this.pollTimer = null;
    }
  }

  watch(cx) {
    this.stopWatch();
    if (!this.file) return;
    if (this.on) {
      this.pollTimer = cx.timer.every(POLL_MS, (cx) => this.load(cx));
      return;
    }

    const dir = watchDir(this.file);
    if (!dir) return;
    const token = {};
    this.watched = token;

    cx.spawn(async (cx) => {
      try {
        while (this.watched === token) {
          const task = watchFolder(dir);
          this.folderWatch = task;
          const paths = await task;
          if (this.folderWatch === task) this.folderWatch = null;
          if (!paths.length || this.watched !== token) break;
          if (watchBatchMatches(paths, dir, [this.file, ...this.doc.paths()])) {
            this.load(cx);
          }
        }
      } catch {
        // Watch failed (e.g. Linux directory limit); fall back to polling.
        if (this.watched === token) {
          this.pollTimer = cx.timer.every(POLL_MS, (cx) => this.load(cx));
        }
      } finally {
        if (this.watched === token) {
          this.watched = null;
          this.folderWatch = null;
        }
      }
    });
  }

  show(file, on, cx, lines = null) {
    this.editor?.release();
    this.editor = null;
    this.text = null;
    this.lines = lines;
    this.file = file;
    this.on = on ?? null;
    this.error = null;
    this.reloadQueued = false;
    this.doc = new MarkdownDoc("mv", this.pictures, this.diagrams, file, this.on);
    this.watch(cx);
    this.load(cx);
    cx.notify();
  }

  open(file, on, cx, first, lines = null) {
    if (!first && this.file) {
      this.history.push({ file: this.file, on: this.on });
    }
    if (!props()?.file) {
      localStorage.setItem(
        "viewer.open",
        JSON.stringify({ file, on: on ?? null }),
      );
    }
    this.show(file, on, cx, lines);
  }

  back(cx) {
    const last = this.history.pop();
    if (!last) return;
    this.show(last.file, last.on, cx);
  }

  syncEditor(file, text) {
    if (text.includes("\0")) {
      this.error = "Binary file.";
      return;
    }
    this.error = null;
    if (!this.editor) {
      const t = theme();
      this.editor = EditorState.new({
        language: editorLanguage(file),
        readonly: true,
        soft_wrap: false,
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
    } else if (text !== this.text) {
      this.editor.set_value(text);
    }
    this.text = text;
    if (this.lines) {
      const range = lineRangeOffsets(text, this.lines.from, this.lines.to);
      this.editor.set_selected_range(range);
      this.lines = null;
    }
  }

  load(cx) {
    const file = this.file;
    const on = this.on;
    const doc = this.doc;
    if (!file) return;
    if (this.loading) {
      this.reloadQueued = true;
      return;
    }
    this.loading = true;
    this.reloadQueued = false;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on });
        if (this.doc !== doc) return;
        if (text === null) {
          if (doc.text === null && this.text === null) {
            this.error = "This file isn't there.";
          }
          return;
        }
        if (!isMarkdown(file)) {
          this.syncEditor(file, text);
          return;
        }
        this.error = null;
        if (!doc.set(text)) {
          await doc.refresh(cx);
          return;
        }
        cx.notify();
        await doc.draw(cx);
      } catch (e) {
        if (this.doc === doc && doc.text === null && this.text === null) {
          this.error = `Cannot read this file: ${String(e?.message ?? e)}`;
        }
      } finally {
        this.loading = false;
        cx.notify();
        if (this.doc !== doc || this.reloadQueued) {
          this.reloadQueued = false;
          this.load(cx);
        }
      }
    });
  }

  link(url, cx) {
    if (/^(?:https?:\/\/[^/\s]|mailto:\S)/i.test(url)) {
      try {
        cx.open_url(url);
      } catch {
        // GPUI rejects malformed or unsupported schemes (`gpui-kit.d.ts`).
      }
      return;
    }
    const target = resolveLink(url, this.file);
    if (!target || target.path === this.file) return;
    this.open(target.path, this.on, cx, false, target.lines);
  }

  render(cx) {
    if (!checking() && this.doc.consumeThemeRedraw()) {
      cx.spawn((cx) => this.doc.draw(cx));
    }
    const t = theme();
    const name = this.file?.split("/").pop() ?? "Markdown";
    const pending = this.doc.pending();
    const folder = this.file
      ? `${this.on ? this.on + ":" : ""}${this.file.replace(/\/[^/]*$/, "")}`
      : "";
    const header = h_flex()
      .h(38)
      .flex_none()
      .px(14)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .text_size(12.5)
      .when(this.history.length > 0, (el) =>
        el.child(
          div()
            .id("mv-back")
            .px(4)
            .cursor_pointer()
            .text_color(t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.back(cx))
            .child("←"),
        ),
      )
      .child(div().font_semibold().flex_none().child(name))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .text_color(t.dim)
          .child(folder),
      )
      .when(pending > 0, (el) =>
        el.child(
          div()
            .flex_none()
            .text_size(11.5)
            .text_color(t.muted)
            .child(
              pending === 1
                ? "Drawing 1 diagram…"
                : `Drawing ${pending} diagrams…`,
            ),
        ),
      );

    let body;
    if (!this.file) {
      body = v_flex()
        .flex_1()
        .min_h(0)
        .p(28)
        .gap(10)
        .text_size(13)
        .child(
          div()
            .text_color(t.muted)
            .child("Type the path of a markdown file and press Enter."),
        )
        .child(
          Input.new(this.input)
            .h(34)
            .px(10)
            .rounded(8)
            .border_1()
            .border_color(t.input)
            .bg(t.surface)
            .text_size(12.8)
            .text_color(t.foreground),
        )
        .when(Boolean(this.on), (el) =>
          el.child(
            div()
              .text_size(11.5)
              .text_color(t.dim)
              .child(`The path is read on ${this.on}.`),
          ),
        );
    } else if (this.error) {
      body = div()
        .flex_1()
        .min_h(0)
        .p(28)
        .text_size(13)
        .text_color(t.blocked)
        .child(this.error);
    } else if (this.editor) {
      body = Editor.new(this.editor).flex_1().min_h(0);
    } else if (this.doc.text === null) {
      body = div()
        .flex_1()
        .min_h(0)
        .p(28)
        .text_size(13)
        .text_color(t.dim)
        .child("Loading…");
    } else {
      body = this.doc.element(t, this.size?.width, (url, cx) =>
        this.link(url, cx),
      );
    }
    return v_flex()
      .id("review-viewer")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .child(header)
      .child(body);
  }
}
