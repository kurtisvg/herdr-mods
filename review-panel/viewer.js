// Standalone markdown viewer for a split pane or dedicated tab.
// Props: `{ role?: "viewer", file?: "/absolute/path.md", on?: "<machine>" }`.
// Prompts for a path when `file` is omitted, and polls so external edits appear.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, readTextFile, theme, spaces, checking } from "herdr";
import { isMarkdown } from "./model.js";
import { MarkdownDoc } from "./doc.js";
import { Pictures } from "./pictures.js";
import { Diagrams } from "./diagrams.js";

export class Viewer {
  init(_props, cx) {
    this.pictures = new Pictures();
    this.diagrams = new Diagrams();
    this.doc = new MarkdownDoc("mv", this.pictures, this.diagrams);
    this.history = [];
    this.size = null;
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

    cx.timer.every(3000, (cx) => this.poll(cx));
  }

  show(file, on) {
    this.file = file;
    this.on = on ?? null;
    this.error = null;
    this.polled = 0;
    this.doc = new MarkdownDoc("mv", this.pictures, this.diagrams, file, this.on);
  }

  open(file, on, cx, first) {
    if (!first && this.file) {
      this.history.push({ file: this.file, on: this.on });
    }
    this.show(file, on);
    if (!props()?.file) {
      localStorage.setItem(
        "viewer.open",
        JSON.stringify({ file, on: this.on }),
      );
    }
    this.load(cx);
    cx.notify();
  }

  back(cx) {
    const last = this.history.pop();
    if (!last) return;
    this.show(last.file, last.on);
    this.load(cx);
    cx.notify();
  }

  load(cx) {
    const file = this.file;
    const on = this.on;
    const doc = this.doc;
    if (!file || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on });
        if (this.doc !== doc) return;
        if (text === null) {
          if (doc.text === null) this.error = "This file isn't there.";
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
        if (this.doc === doc && doc.text === null) {
          this.error = `Cannot read this file: ${String(e?.message ?? e)}`;
        }
      } finally {
        this.loading = false;
        cx.notify();
        if (this.doc !== doc) this.load(cx);
      }
    });
  }

  poll(cx) {
    if (!this.file) return;
    this.polled = (this.polled ?? 0) + 1;
    if (this.on && this.polled % 3 !== 0) return;
    this.load(cx);
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
    // A malformed web or mail address is not a file.
    if (/^(?:https?|mailto):/i.test(url)) return;
    const clean = url.split("#")[0];
    if (!isMarkdown(clean) || !this.file) return;
    let path = decodeURIComponent(
      clean.startsWith("file://") ? clean.slice(7) : clean,
    );
    if (!path.startsWith("/")) {
      path = `${this.file.replace(/\/[^/]*$/, "")}/${path}`;
    }
    this.open(path, this.on, cx);
  }

  render() {
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
