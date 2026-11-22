// Interactive Mermaid diagram viewport with GitHub-style zoom/pan controls
// and an expandable lightbox overlay (`openOverlay`).

import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { openOverlay, closeOverlay, props, theme } from "herdr";
import {
  DEFAULT_VIEW,
  ZOOM_STEP,
  PAN_STEP,
  computeDiagramLayout,
  zoomBy,
  zoomAtPoint,
  panBy,
  isDefaultView,
  formatZoom,
} from "./diagram.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function controlButton(id, label, t, onClick, opts = {}) {
  return div()
    .id(id)
    .h(22)
    .min_w(opts.minWidth ?? 22)
    .px(opts.px ?? 4)
    .flex()
    .items_center()
    .justify_center()
    .rounded(4)
    .cursor_pointer()
    .text_size(opts.textSize ?? 11.5)
    .text_color(opts.accent ? t.accent : t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .child(label);
}

function barDivider(t) {
  return div().w(1).h(14).mx(2).bg(t.border).flex_none();
}

function renderRefreshingBadge(t) {
  return h_flex()
    .absolute()
    .left(8)
    .top(8)
    .px(8)
    .py(3)
    .gap(6)
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(t.border)
    .bg(t.popover ?? t.chrome)
    .text_size(11)
    .text_color(t.muted)
    .child(div().w(10).frames(SPINNER, 90))
    .child("Updating…");
}

function renderControls({
  id,
  t,
  zoom,
  modified,
  expandable,
  diagram,
  title,
  onPan,
  onZoom,
  onReset,
}) {
  return h_flex()
    .id(`${id}-controls`)
    .absolute()
    .right(8)
    .bottom(8)
    .p(2)
    .gap(1)
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(t.border)
    .bg(t.popover ?? t.chrome)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .child(controlButton(`${id}-pan-left`, "←", t, (_e, cx) => onPan(PAN_STEP, 0, cx)))
    .child(controlButton(`${id}-pan-up`, "↑", t, (_e, cx) => onPan(0, PAN_STEP, cx)))
    .child(controlButton(`${id}-pan-down`, "↓", t, (_e, cx) => onPan(0, -PAN_STEP, cx)))
    .child(controlButton(`${id}-pan-right`, "→", t, (_e, cx) => onPan(-PAN_STEP, 0, cx)))
    .child(barDivider(t))
    .child(controlButton(`${id}-zoom-out`, "−", t, (_e, cx) => onZoom(1 / ZOOM_STEP, cx)))
    .child(
      controlButton(`${id}-zoom-reset`, formatZoom(zoom), t, onReset, {
        minWidth: 42,
        px: 5,
        textSize: 11,
        accent: modified,
      }),
    )
    .child(controlButton(`${id}-zoom-in`, "+", t, (_e, cx) => onZoom(ZOOM_STEP, cx)))
    .when(expandable, (el) =>
      el.child(barDivider(t)).child(
        controlButton(`${id}-expand`, "⤢", t, () => {
          openOverlay({
            mod: "review-panel",
            kind: "dialog",
            width: 0.92,
            height: 0.9,
            props: {
              role: "diagram",
              path: diagram.path,
              width: diagram.width,
              height: diagram.height,
              title,
            },
          });
        }),
      ),
    );
}

// Tracks per-diagram zoom/pan state and active pointer drag across renders.
export class DiagramViews {
  constructor() {
    this.views = new Map(); // key -> { zoom, x, y }
    this.drag = null; // { key, startX, startY, originX, originY }
  }

  stateOf(key) {
    return this.views.get(key) ?? DEFAULT_VIEW;
  }

  apply(key, next, diagram, viewport, opts) {
    const layout = computeDiagramLayout(diagram, viewport, next, opts);
    const clamped = { zoom: layout.zoom, x: layout.x, y: layout.y };
    if (isDefaultView(clamped)) this.views.delete(key);
    else this.views.set(key, clamped);
  }

  zoom(key, factor, point, diagram, viewport, opts) {
    const next = zoomBy(this.stateOf(key), factor, point, viewport);
    this.apply(key, next, diagram, viewport, opts);
  }

  pan(key, dx, dy, diagram, viewport, opts) {
    const next = panBy(this.stateOf(key), dx, dy);
    this.apply(key, next, diagram, viewport, opts);
  }

  reset(key) {
    this.views.delete(key);
    if (this.drag?.key === key) this.drag = null;
  }

  // Renders a Mermaid diagram inside a clipped interactive viewport with
  // drag-to-pan, pinch/wheel zoom, floating controls, and optional lightbox.
  renderCard({
    id,
    key,
    diagram,
    theme: t,
    width,
    height,
    fitHeight = false,
    expandable = true,
    title = "Mermaid Diagram",
  }) {
    const opts = { fitHeight };
    const state = this.stateOf(key);
    const layout = computeDiagramLayout(diagram, { width, height }, state, opts);
    const viewport = {
      width: layout.viewportWidth,
      height: layout.viewportHeight,
      center: layout.center,
    };
    const dragging = this.drag?.key === key;
    const modified = !isDefaultView(state);

    const controls = renderControls({
      id,
      t,
      zoom: layout.zoom,
      modified,
      expandable,
      diagram,
      title,
      onPan: (dx, dy, cx) => {
        this.pan(key, dx, dy, diagram, viewport, opts);
        cx.notify();
      },
      onZoom: (factor, cx) => {
        this.zoom(key, factor, layout.center, diagram, viewport, opts);
        cx.notify();
      },
      onReset: (_e, cx) => {
        this.reset(key);
        cx.notify();
      },
    });

    return div()
      .id(`${id}-canvas`)
      .relative()
      .overflow_hidden()
      .bg(t.surface)
      .when(fitHeight, (el) => el.flex_1().min_h(0).w_full())
      .when(!fitHeight, (el) =>
        el
          .w(viewport.width)
          .h(viewport.height)
          .flex_none()
          .rounded(8)
          .border_1()
          .border_color(t.border),
      )
      .when(dragging, (el) => el.cursor_grabbing())
      .when(!dragging, (el) => el.cursor_grab())
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count === 2) {
          if (isDefaultView(this.stateOf(key))) {
            const next = zoomAtPoint(
              this.stateOf(key),
              1.75,
              e.local_position ?? layout.center,
              viewport,
            );
            this.apply(key, next, diagram, viewport, opts);
          } else {
            this.reset(key);
          }
          this.drag = null;
          cx.notify();
          return;
        }
        this.drag = {
          key,
          startX: e.position.x,
          startY: e.position.y,
          originX: layout.x,
          originY: layout.y,
        };
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (this.drag?.key !== key) return;
        cx.stop_propagation();
        const next = {
          zoom: this.stateOf(key).zoom,
          x: this.drag.originX + (e.position.x - this.drag.startX),
          y: this.drag.originY + (e.position.y - this.drag.startY),
        };
        this.apply(key, next, diagram, viewport, opts);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag?.key !== key) return;
        this.drag = null;
        cx.stop_propagation();
        cx.notify();
      })
      .on_hover((hovered, cx) => {
        // Cancel active drags on leave so releasing outside the canvas never sticks.
        if (!hovered && this.drag?.key === key) {
          this.drag = null;
          cx.notify();
        }
      })
      .on_pinch((e, cx) => {
        cx.stop_propagation();
        const factor = Math.max(0.5, Math.min(2, 1 + e.delta));
        this.zoom(key, factor, e.local_position ?? layout.center, diagram, viewport, opts);
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform) {
          cx.stop_propagation();
          const factor = Math.max(0.5, Math.min(2, Math.exp(e.delta.y * 0.004)));
          this.zoom(key, factor, e.local_position ?? layout.center, diagram, viewport, opts);
          cx.notify();
          return;
        }
        if (fitHeight) {
          cx.stop_propagation();
          this.pan(key, e.delta.x, e.delta.y, diagram, viewport, opts);
          cx.notify();
          return;
        }
        // Leave plain wheel events unhandled on inline cards so document scrolling stays natural.
        if (e.modifiers.shift && !isDefaultView(this.stateOf(key))) {
          cx.stop_propagation();
          this.pan(key, e.delta.x, e.delta.y, diagram, viewport, opts);
          cx.notify();
        }
      })
      .child(
        image(diagram.path)
          .absolute()
          .left(Math.round(layout.left))
          .top(Math.round(layout.top))
          .w(Math.round(layout.width))
          .h(Math.round(layout.height)),
      )
      .when(Boolean(diagram.refreshing), (el) => el.child(renderRefreshingBadge(t)))
      .child(controls);
  }
}

// Full-window dialog overlay for inspecting a Mermaid diagram up close.
export class DiagramLightbox {
  init(_p, cx) {
    this.views = new DiagramViews();
    this.size = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  onKey(e, diagram, viewport, overlayId, cx) {
    const opts = { fitHeight: true };
    const k = e.key;
    if (k === "escape") {
      if (overlayId) closeOverlay(overlayId);
      cx.stop_propagation();
      return;
    }
    if (k === "+" || k === "=") {
      this.views.zoom("lightbox", ZOOM_STEP, viewport.center, diagram, viewport, opts);
    } else if (k === "-") {
      this.views.zoom("lightbox", 1 / ZOOM_STEP, viewport.center, diagram, viewport, opts);
    } else if (k === "0") {
      this.views.reset("lightbox");
    } else if (k === "left" || k === "right" || k === "up" || k === "down") {
      const dx = k === "left" ? PAN_STEP : k === "right" ? -PAN_STEP : 0;
      const dy = k === "up" ? PAN_STEP : k === "down" ? -PAN_STEP : 0;
      this.views.pan("lightbox", dx, dy, diagram, viewport, opts);
    } else {
      return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const cfg = props() ?? {};
    const diagram = {
      path: cfg.path,
      width: Number(cfg.width) || 640,
      height: Number(cfg.height) || 400,
    };
    const title = cfg.title || "Mermaid Diagram";
    const viewW = Math.max(240, Math.round(this.size?.width ?? 900));
    const viewH = Math.max(180, Math.round(this.size?.height ?? 600));
    const viewport = {
      width: viewW,
      height: viewH,
      center: { x: viewW / 2, y: viewH / 2 },
    };

    const header = h_flex()
      .h(38)
      .flex_none()
      .px(14)
      .gap(10)
      .items_center()
      .justify_between()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .min_w(0)
          .child(div().font_semibold().text_size(12.5).truncate().child(title))
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .flex_none()
              .child(`${Math.round(diagram.width)} × ${Math.round(diagram.height)}`),
          ),
      )
      .child(
        div()
          .id("lightbox-close")
          .px(8)
          .py(3)
          .rounded(5)
          .cursor_pointer()
          .text_size(12)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (cfg.overlay) closeOverlay(cfg.overlay);
          })
          .child("Close"),
      );

    const footer = h_flex()
      .h(26)
      .flex_none()
      .px(14)
      .items_center()
      .justify_between()
      .border_t(1)
      .border_color(t.border)
      .bg(t.chrome)
      .text_size(11)
      .text_color(t.dim)
      .child(
        "Drag or scroll to pan · Pinch or Cmd+Scroll to zoom · Double-click to zoom or reset · Esc to close",
      );

    return v_flex()
      .id("review-diagram-lightbox")
      .size_full()
      .min_h(0)
      .bg(t.surface)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, diagram, viewport, cfg.overlay, cx))
      .child(header)
      .child(
        v_flex()
          .id("lightbox-stage")
          .flex_1()
          .min_h(0)
          .w_full()
          .on_size_change((size, cx) => {
            this.size = size;
            cx.notify();
          })
          .child(
            diagram.path
              ? this.views.renderCard({
                  id: "lightbox-diagram",
                  key: "lightbox",
                  diagram,
                  theme: t,
                  width: viewW,
                  height: viewH,
                  fitHeight: true,
                  expandable: false,
                  title,
                })
              : div()
                  .flex_1()
                  .flex()
                  .items_center()
                  .justify_center()
                  .text_size(13)
                  .text_color(t.muted)
                  .child("Diagram unavailable."),
          ),
      )
      .child(footer);
  }
}
