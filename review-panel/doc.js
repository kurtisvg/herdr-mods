// Renders segmented markdown, local pictures, and Mermaid diagrams for the
// standalone pane/tab viewer (`viewer.js`).

import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { settings } from "herdr";
import { splitMarkdown, pictureFile } from "./model.js";
import { CACHE } from "./pictures.js";
import { DiagramViews } from "./diagram-view.js";

const PAGE = 920; // maximum text-column width in pixels
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function renderFrontmatterValue(value, t) {
  const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
  if (isEmpty) {
    return div().flex_1().min_w(0).text_color(t.dim).child("—");
  }
  if (!Array.isArray(value)) {
    return div().flex_1().min_w(0).text_color(t.foreground).child(value);
  }
  return h_flex()
    .flex_1()
    .min_w(0)
    .flex_wrap()
    .gap(4)
    .children(
      value.map((item) =>
        div()
          .px(6)
          .py(1)
          .rounded(4)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .text_size(11)
          .text_color(t.foreground)
          .child(item),
      ),
    );
}

function frontmatterRows(entries, t) {
  return v_flex()
    .w_full()
    .px(10)
    .py(6)
    .gap(4)
    .border_t(1)
    .border_color(t.border)
    .children(
      entries.map((entry) =>
        h_flex()
          .w_full()
          .items_start()
          .gap(10)
          .text_size(12)
          .child(
            div()
              .w(104)
              .flex_none()
              .truncate()
              .font_medium()
              .text_color(t.muted)
              .child(entry.key),
          )
          .child(renderFrontmatterValue(entry.value, t)),
      ),
    );
}

// Collapsible key/value metadata card for leading YAML frontmatter.
// Used by both `MarkdownDoc` (`doc.js`) and `Panel` (`panel.js`).
export function frontmatterCard(id, entries, open, onToggle, t) {
  const count = entries.length === 1 ? "1 field" : `${entries.length} fields`;
  const middle = open
    ? div().flex_1()
    : div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_size(11)
        .text_color(t.dim)
        .child(entries.map((e) => e.key).join(", "));

  const header = h_flex()
    .id(id)
    .w_full()
    .px(10)
    .py(6)
    .gap(6)
    .items_center()
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onToggle(cx))
    .child(
      div()
        .w(10)
        .flex_none()
        .text_size(11)
        .text_color(t.dim)
        .child(open ? "▾" : "▸"),
    )
    .child(
      div()
        .flex_none()
        .font_medium()
        .text_size(11.5)
        .text_color(t.muted)
        .child("Frontmatter"),
    )
    .child(middle)
    .child(div().flex_none().text_size(11).text_color(t.dim).child(count));

  return v_flex()
    .w_full()
    .rounded(8)
    .border_1()
    .border_color(t.border)
    .bg(t.surface)
    .overflow_hidden()
    .child(header)
    .when(open, (el) => el.child(frontmatterRows(entries, t)));
}

export class MarkdownDoc {
  constructor(name, pictures, diagrams, file = null, on = null) {
    this.name = name;
    this.pictures = pictures;
    this.diagrams = diagrams;
    this.file = file;
    this.dir =
      file && file.includes("/") ? file.replace(/\/[^/]*$/, "") || "/" : null;
    this.on = on;
    this.text = null;
    this.themeSig = null;
    this.segments = [];
    this.frontmatterOpen = true;
    this.diagramViews = new DiagramViews();
  }

  hasMermaid() {
    return this.segments.some((s) => s.kind === "mermaid" && s.code.trim());
  }

  // Updates the document text and active theme signature. Returns true when
  // segments or theme changed and a draw pass is needed.
  set(text) {
    const sig = this.diagrams.signature();
    if (text === this.text) {
      if (sig === this.themeSig) return false;
      this.themeSig = sig;
      return this.hasMermaid();
    }
    this.text = text;
    this.themeSig = sig;
    this.segments = splitMarkdown(text, (src) =>
      this.on ? null : pictureFile(src, this.dir),
    );
    return true;
  }

  // Updates `themeSig` when the active theme changed and reports whether this
  // document has Mermaid diagrams that need a redraw.
  consumeThemeRedraw() {
    if (this.text === null) return false;
    const sig = this.diagrams.signature();
    if (sig === this.themeSig) return false;
    this.themeSig = sig;
    return this.hasMermaid();
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
    this.themeSig = this.diagrams.signature();
    const codes = this.segments
      .filter((s) => s.kind === "mermaid" && s.code.trim())
      .map((s) => s.code);
    if (codes.length) await this.diagrams.draw(codes, cx);
  }

  diagram(s, slot, t, room) {
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
    const slotKey = `${this.name}:${this.on ?? ""}:${this.file ?? ""}#${slot}`;
    const d = this.diagrams.get(s.code, slotKey);
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
    if (d?.error) {
      const heading = s.open
        ? "This mermaid block is never closed"
        : "This diagram could not be drawn";
      return box()
        .border_color(t.blocked)
        .child(div().font_semibold().text_color(t.blocked).child(heading))
        .child(div().text_color(t.muted).child(d.error))
        .child(div().font_family(mono).text_size(11.5).text_color(t.muted).child(s.code));
    }
    if (!d?.path) {
      return box().child(
        h_flex()
          .gap(8)
          .items_center()
          .text_color(t.muted)
          .child(div().w(12).frames(SPINNER, 90))
          .child("Drawing diagram…"),
      );
    }

    const fileName = this.file?.split("/").pop();
    const title = fileName ? `${fileName} — Diagram ${slot + 1}` : `Diagram ${slot + 1}`;
    return h_flex()
      .w_full()
      .justify_center()
      .py(6)
      .child(
        this.diagramViews.renderCard({
          id: `${this.name}-diagram-${slot}`,
          key: `slot-${slot}`,
          diagram: d,
          theme: t,
          width: room,
          expandable: true,
          title,
        }),
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
    let diagramSlot = 0;
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
              if (s.kind === "frontmatter") {
                return frontmatterCard(
                  `${this.name}-frontmatter-${i}`,
                  s.entries,
                  this.frontmatterOpen,
                  (cx) => {
                    this.frontmatterOpen = !this.frontmatterOpen;
                    cx.notify();
                  },
                  t,
                );
              }
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
              return this.diagram(s, diagramSlot++, t, room);
            }),
          ),
      );
  }
}
