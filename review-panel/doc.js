// Renders segmented markdown, local pictures, and Mermaid diagrams for the
// standalone pane/tab viewer (`viewer.js`).

import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { settings } from "herdr";
import { splitMarkdown, pictureFile } from "./model.js";
import { CACHE } from "./pictures.js";

const PAGE = 920; // maximum text-column width in pixels
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class MarkdownDoc {
  constructor(name, pictures, diagrams, file = null, on = null) {
    this.name = name;
    this.pictures = pictures;
    this.diagrams = diagrams;
    this.dir =
      file && file.includes("/") ? file.replace(/\/[^/]*$/, "") || "/" : null;
    this.on = on;
    this.text = null;
    this.segments = [];
  }

  // Updates the document text and theme. Returns true when segments changed.
  set(text) {
    const dark = Boolean(settings().dark);
    if (text === this.text && dark === this.dark) return false;
    this.text = text;
    this.dark = dark;
    this.segments = splitMarkdown(text, (src) =>
      this.on ? null : pictureFile(src, this.dir),
    );
    return true;
  }

  pending() {
    return this.segments.filter(
      (s) =>
        s.kind === "mermaid" && s.code.trim() && this.diagrams.get(s.code)?.pending,
    ).length;
  }

  paths() {
    const out = [];
    for (const s of this.segments) {
      if (s.kind !== "pictures") continue;
      for (const item of s.items) out.push(item.path);
    }
    return out;
  }

  async refresh(cx) {
    const paths = this.paths();
    if (paths.length) await this.pictures.draw(paths, cx);
  }

  async draw(cx) {
    await this.refresh(cx);
    const codes = this.segments
      .filter((s) => s.kind === "mermaid" && s.code.trim())
      .map((s) => s.code);
    if (codes.length) await this.diagrams.draw(codes, cx);
  }

  diagram(s, t, room) {
    const box = () =>
      v_flex()
        .w_full()
        .p(14)
        .gap(8)
        .rounded(8)
        .border_1()
        .border_color(t.border)
        .bg(t.surface)
        .text_size(12);
    const mono = settings().font_family ?? "monospace";

    if (!s.code.trim()) {
      return box()
        .border_color(t.blocked)
        .child(
          div()
            .font_semibold()
            .text_color(t.blocked)
            .child("This diagram could not be drawn"),
        )
        .child(div().text_color(t.muted).child("This mermaid block is empty."));
    }
    const d = this.diagrams.get(s.code);
    if (!d && this.diagrams.missingRenderer) {
      return box()
        .border_color(t.blocked)
        .child(
          div()
            .font_semibold()
            .text_color(t.blocked)
            .child("This diagram could not be drawn"),
        )
        .child(
          div()
            .text_color(t.muted)
            .child(
              "The mermaid renderer is not installed in mods/review-panel/renderer.",
            ),
        )
        .child(div().font_family(mono).text_size(11.5).text_color(t.muted).child(s.code));
    }
    if (!d || d.pending) {
      return box().child(
        h_flex()
          .gap(8)
          .items_center()
          .text_color(t.muted)
          .child(div().w(12).frames(SPINNER, 90))
          .child("Drawing diagram…"),
      );
    }
    if (d.error) {
      const heading = s.open
        ? "This mermaid block is never closed"
        : "This diagram could not be drawn";
      return box()
        .border_color(t.blocked)
        .child(div().font_semibold().text_color(t.blocked).child(heading))
        .child(div().text_color(t.muted).child(d.error))
        .child(div().font_family(mono).text_size(11.5).text_color(t.muted).child(s.code));
    }
    const k = Math.min(1, room / d.width);
    return h_flex()
      .w_full()
      .justify_center()
      .py(6)
      .child(
        image(d.path)
          .w(Math.round(d.width * k))
          .h(Math.round(d.height * k))
          .flex_none(),
      );
  }

  row(s, n, t, room, link) {
    return h_flex()
      .w_full()
      .flex_wrap()
      .items_end()
      .gap(8)
      .py(4)
      .children(
        s.items.map((item, j) => {
          const p = this.pictures.get(item.path);
          if (!p || p.pending) return div();
          if (p.error) {
            return div()
              .w_full()
              .px(10)
              .py(6)
              .rounded(6)
              .border_1()
              .border_color(t.border)
              .text_size(12)
              .text_color(t.muted)
              .child(`Picture not shown: ${item.src}. ${p.error}`);
          }
          const width = Math.max(1, Math.round(Math.min(item.width ?? p.width, room)));
          const height = Math.max(1, Math.round((width * p.height) / p.width));
          const el = image(`${CACHE}/${p.file}`).w(width).h(height).flex_none();
          if (!item.href) return el;
          return div()
            .id(`${this.name}-picture-${n}-${j}`)
            .flex_none()
            .cursor_pointer()
            .on_click((_e, cx) => link(item.href, cx))
            .child(el);
        }),
      );
  }

  element(t, width, link) {
    const pad = (width ?? PAGE) < 560 ? 16 : 28;
    const room = Math.max(120, Math.min(PAGE, width ?? PAGE) - pad * 2 - 12);
    return div()
      .id(`${this.name}-scroll`)
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .child(
        v_flex()
          .w_full()
          .max_w(PAGE)
          .mx_auto()
          .p(pad)
          .gap(10)
          .text_size(14)
          .children(
            this.segments.map((s, i) => {
              if (s.kind === "md") {
                return div()
                  .w_full()
                  .child(
                    TextView.markdown(`${this.name}-${i}-${s.id}`, s.text)
                      .selectable(true)
                      .on_link_click(link),
                  );
              }
              if (s.kind === "pictures") return this.row(s, i, t, room, link);
              return this.diagram(s, t, room);
            }),
          ),
      );
  }
}
