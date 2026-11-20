// Tab bar role (`props.role === "tabs"`), adapted from Herdr 0.1.16's built-in
// `tabs` mod for the `review-panel` side panel.
//
// When the side panel holds `review-panel`, the right-hand buttons show Files,
// Changes, and Comments. They switch modes through `shared("review-panel.mode")`
// and remember each space's choice. Layouts without `review-panel` keep Herdr's
// standard `tabs` behavior.

import { div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import {
  layout,
  openOverlay,
  panes,
  run,
  setShared,
  settings,
  shared,
  spaces,
  theme,
  window,
} from "herdr";

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// Matches a review-panel block by mod name or by current or legacy block id.
function findReviewNode(node) {
  if (!node) return null;
  if (
    node.content?.mod === "review-panel" ||
    node.id === "review-panel" ||
    node.id === "review"
  ) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findReviewNode(child);
    if (found) return found;
  }
  return null;
}

// Strips leading agent status glyphs while keeping an opening bracket or quote.
function cleanTitle(title) {
  return (title ?? "")
    .replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "")
    .replace(/^\[ [!.] \] /, "")
    .trim();
}

// Unnamed tabs and tabs named after their program follow the agent's live
// title when that title carries task context. Custom tab names stay fixed.
function tabLabel(tab, lead) {
  const programName = lead?.program?.name;
  const fallback = tab.named ? tab.name : programName ?? "Terminal";
  if (!lead?.program?.agent) return fallback;

  const live = cleanTitle(lead.title);
  // cleanTitle strips a leading ~ or /, so test for paths after removing only
  // non-path prefix glyphs.
  const strippedForPath = (lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "");
  const isPath = /^[~/]|^[A-Za-z]:\\/.test(strippedForPath);
  const isInformative =
    Boolean(live) &&
    live !== lead.terminal &&
    live !== programName &&
    !isPath &&
    !live.includes("@") &&
    live.toLowerCase() !== lead.program.key;

  const usesAutoName = !tab.named || tab.name === programName;
  return usesAutoName && isInformative ? live : fallback;
}

function loadSavedPanels() {
  try {
    const parsed = JSON.parse(localStorage.getItem("panels") ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore malformed saved state and start fresh.
  }
  return {};
}

function macosTrafficLightPadding(root, sidebar, win) {
  if (
    win?.platform !== "macos" ||
    win.titlebar !== "none" ||
    win.fullscreen ||
    !root?.traffic_lights
  ) {
    return 10;
  }
  // A hidden or dragged-narrow sidebar can be narrower than the traffic lights.
  const zoom = Number(settings().zoom) || 1;
  const sidebarWidth = sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0;
  return Math.max(10, (root.traffic_lights[0] + 64) / zoom - sidebarWidth);
}

function resolvePanelState(root) {
  const panel = findNode(root, "panel");
  const body = findNode(root, "panel-body");
  const configured = shared("workspace.panels");
  const baseModes = Array.isArray(configured) ? configured : ["files", "changes"];
  const reviewNode = findReviewNode(body ?? panel);
  const hasReview = Boolean(reviewNode);
  const enabled = hasReview
    ? [...baseModes.filter((m) => m === "files" || m === "changes"), "comments"]
    : baseModes;

  const activeStackChild = body?.active ?? body?.children?.[0]?.id;
  const reviewShown =
    hasReview &&
    Boolean(panel) &&
    !panel.hidden &&
    (!body || body.type !== "stack" || activeStackChild === reviewNode.id);

  const sharedMode = shared("review-panel.mode");
  let activeMode = null;
  if (hasReview) {
    if (reviewShown) {
      activeMode = enabled.includes(sharedMode) ? sharedMode : "changes";
    }
  } else if (panel && !panel.hidden) {
    activeMode = body?.active ?? null;
  }

  const applyMode = (want) => {
    if (!want) {
      run("layout.hide", { id: "panel" });
      return;
    }
    if (hasReview) {
      setShared("review-panel.mode", want);
      if (body?.type === "stack" && body.active !== reviewNode.id) {
        run("layout.select", { stack: "panel-body", child: reviewNode.id });
      }
      if (panel?.hidden) run("layout.show", { id: "panel" });
      return;
    }
    run("layout.select", { stack: "panel-body", child: want });
    run("layout.show", { id: "panel" });
  };

  return { panel, enabled, activeMode, applyMode };
}

export class Tabs {
  init() {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = loadSavedPanels();
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  // Switches one tab per wheel notch. Trackpads and smooth-scrolling mice emit
  // many small pixel deltas per gesture. The first 20 px switches one tab, and
  // each additional 60 px switches another, at most once every 100 ms.
  wheel(event) {
    if (event.delta_lines) {
      if (event.delta_lines.y) {
        run(event.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      }
      return;
    }

    const swipe = this.swipe;
    const now = Date.now();
    // Touchpad gestures often arrive only as move events, so a pause or a
    // direction reversal starts a fresh gesture.
    const reversed = event.delta.y * swipe.acc < 0;
    if (event.touch_phase === "started" || now - swipe.at > 250 || reversed) {
      swipe.acc = 0;
      swipe.steps = 0;
    }

    swipe.at = now;
    swipe.acc += event.delta.y;
    const threshold = swipe.steps ? 60 : 20;
    if (Math.abs(swipe.acc) < threshold || now - swipe.last < 100) return;

    swipe.acc -= Math.sign(swipe.acc) * threshold;
    swipe.steps++;
    swipe.last = now;
    run(event.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // Remembers each space's side-panel mode across space switches. On startup, an
  // unseen initial space keeps the layout's panel state. Switching to another
  // unseen space later hides the panel.
  syncPanel(space, panel, activeMode, enabled, applyMode) {
    if (!space || !panel) return;

    if (space.id !== this.space) {
      const isInitialSpace = this.space === undefined;
      this.space = space.id;
      this.pending = null;

      if (!isInitialSpace || Object.hasOwn(this.panels, space.id)) {
        const raw = Object.hasOwn(this.panels, space.id)
          ? (this.panels[space.id] ?? null)
          : null;
        // Migrate the legacy "review" mode name to "comments".
        const stored =
          raw === "review" && enabled.includes("comments") ? "comments" : raw;
        const want = enabled.includes(stored) ? stored : null;
        if (want !== activeMode) {
          this.pending = { want, until: Date.now() + 1000 };
          applyMode(want);
          return;
        }
      }
    }

    // Ignore the previous space's panel state until the restore settles.
    if (this.pending) {
      if (this.pending.want !== activeMode && Date.now() < this.pending.until) {
        return;
      }
      this.pending = null;
    }

    if (
      Object.hasOwn(this.panels, space.id) &&
      this.panels[space.id] === activeMode
    ) {
      return;
    }
    this.panels[space.id] = activeMode;
    try {
      localStorage.setItem("panels", JSON.stringify(this.panels));
    } catch {
      // Ignore storage write errors so rendering still succeeds.
    }
  }

  render() {
    const palette = theme();
    const space = spaces().find((s) => s.active);
    const shown = space?.tabs ?? [];
    const activeIndex = shown.findIndex((tab) => tab.active);
    const selectedId = shown[activeIndex]?.id;
    if (selectedId !== this.selected || activeIndex !== this.selectedIndex) {
      this.selected = selectedId;
      this.selectedIndex = activeIndex;
      if (activeIndex >= 0) this.scroll.scroll_to_item(activeIndex);
    }

    const root = layout();
    const sidebar = findNode(root, "sidebar");
    const win = window();
    const lightsPadding = macosTrafficLightPadding(root, sidebar, win);
    const { panel, enabled, activeMode, applyMode } = resolvePanelState(root);
    this.syncPanel(space, panel, activeMode, enabled, applyMode);

    // Stop mouse-down propagation on interactive controls so a draggable
    // titlebar block (`window_drag: true`) does not start a window drag.
    const stop = (_e, cx) => cx.stop_propagation();

    const iconButton = (id, content, action) =>
      div()
        .id(id)
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(palette.dim)
        .hover((s) => s.bg(palette.hover).text_color(palette.foreground))
        .on_mouse_down("left", stop)
        .on_click(action)
        .child(content);

    const panelButton = (id, text, icon) => {
      const on = activeMode === id;
      return h_flex()
        .id(`panel-${id}`)
        .h(26)
        .px(8)
        .gap(5)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .bg(on ? palette.selected : palette.chrome)
        .text_color(on ? palette.foreground : palette.muted)
        .hover((s) => s.bg(palette.hover))
        .on_mouse_down("left", stop)
        .on_click(() => applyMode(on ? null : id))
        .child(svg(icon).size(14))
        .child(text);
    };

    const allPanes = panes();
    const renderTab = (tab, index) => {
      const lead =
        allPanes.find((p) => p.tab === tab.id && p.program?.agent) ??
        allPanes.find((p) => p.tab === tab.id);
      const program = lead?.program;
      const name = tabLabel(tab, lead);

      return h_flex()
        .id(`tab-${tab.id}`)
        .h(29)
        .px(10)
        .gap(7)
        .rounded(7)
        .items_center()
        .flex_none()
        .text_size(12.8)
        // A rename or status change on this or an earlier tab can push the
        // active tab out of view.
        .when(index <= activeIndex, (el) =>
          el.on_size_change((_size, cx) => {
            this.scroll.scroll_to_item(activeIndex);
            cx.notify();
          }),
        )
        .border(1)
        .border_color(tab.active ? palette.border : palette.chrome)
        .bg(tab.active ? palette.raised : palette.chrome)
        .text_color(tab.active ? palette.foreground : palette.muted)
        .hover((s) => s.bg(palette.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = index;
          if (e.click_count === 2) run("tab.rename", { id: tab.id });
        })
        .on_mouse_up("left", () => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== index && shown[from]) {
            const targetIndex = space.tabs.findIndex((x) => x.id === tab.id) + 1;
            run("tab.move", { id: shown[from].id, index: targetIndex });
          } else {
            run("tab.select", { id: tab.id });
          }
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: "menu",
            kind: "popup",
            width: 200,
            props: { tab: "tab", target: { id: tab.id, space: space.id } },
          });
        })
        .when(Boolean(program?.icon), (el) =>
          el.child(
            program.tint
              ? svg(program.icon).size(14).text_color(palette.muted)
              : image(program.icon).size(14),
          ),
        )
        .child(div().max_w(170).truncate().child(tab.zoomed ? `${name} Z` : name))
        .when(tab.status === "working", (el) =>
          el.child(
            svg("mods/workspace-chrome/spinner.svg")
              .size(12)
              .flex_none()
              .text_color(palette.working)
              .spin(900),
          ),
        )
        .when(tab.status === "blocked" || tab.status === "done", (el) =>
          el.child(div().size(6).rounded(3).bg(palette[tab.status])),
        )
        .when(tab.active, (el) =>
          el.child(
            div()
              .id(`close-${tab.id}`)
              .text_color(palette.dim)
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("tab.close", { id: tab.id });
              })
              .child(svg("mods/pane/close.svg").size(12)),
          ),
        );
    };

    return h_flex()
      .size_full()
      .min_w(0)
      .px(10)
      .pl(lightsPadding)
      .gap(3)
      .items_center()
      .bg(palette.chrome)
      .border_b(1)
      .border_color(palette.border)
      .on_mouse_up("left", () => {
        this.pressed = null;
      })
      .on_scroll_wheel((e) => this.wheel(e))
      .child(
        h_flex()
          .id("tab-scroll")
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .gap(3)
          .overflow_x_scrollbar()
          .track_scroll(this.scroll)
          .on_size_change((_size, cx) => {
            if (activeIndex >= 0) {
              this.scroll.scroll_to_item(activeIndex);
              cx.notify();
            }
          })
          .children(shown.map(renderTab)),
      )
      .child(
        iconButton("tab-new", "+", () =>
          openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }),
        ),
      )
      .when(enabled.includes("files"), (el) =>
        el.child(panelButton("files", "Files", "mods/files/file.svg")),
      )
      .when(enabled.includes("changes"), (el) =>
        el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")),
      )
      .when(enabled.includes("comments"), (el) =>
        el.child(panelButton("comments", "Comments", "mods/review-panel/review.svg")),
      )
      .when(Boolean(win?.buttons), (el) => {
        const isWindows = win.platform === "windows";
        const minGlyph = isWindows ? svg("mods/tabs/win-min.svg").size(16) : "−";
        const maxIcon = win.maximized ? "win-restore" : "win-max";
        const maxGlyph = isWindows ? svg(`mods/tabs/${maxIcon}.svg`).size(16) : "□";
        const closeGlyph = isWindows
          ? svg("mods/tabs/win-close.svg").size(16)
          : svg("mods/pane/close.svg").size(13);
        return el
          .child(iconButton("minimize", minGlyph, () => run("window.minimize")))
          .child(iconButton("maximize", maxGlyph, () => run("window.maximize")))
          .child(iconButton("close-window", closeGlyph, () => run("window.close")));
      });
  }
}
