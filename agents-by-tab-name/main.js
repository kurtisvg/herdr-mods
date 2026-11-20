// Herdr does not detect edits made through a symlink in mods/agents-by-tab-name.
// Run `./plugin.sh reload agents-by-tab-name` after changing a file here.

// Renders the agents list in Priority or Grouped by space view.
// Each parent agent takes the urgency of its most urgent sub-agent.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  agents,
  closeOverlay,
  focused,
  layout,
  openOverlay,
  panes,
  props,
  run,
  setAgentOrder,
  setShared,
  shared,
  spaces,
  terminals,
  theme,
  window,
} from "herdr";

const RAIL_THRESHOLD_PX = 160;
const DEFAULT_SIDEBAR_PX = 268;
const MACOS_RAIL_PX = 76;
const DEFAULT_RAIL_PX = 44;
const STALE_ENTRY_MAX_AGE_MS = 30 * 86400000;

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];

function findLayoutNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findLayoutNode(child, id);
    if (found) return found;
  }
  return null;
}

function sidebarWidth() {
  return findLayoutNode(layout(), "sidebar")?.size?.px;
}

// Rail mode follows the sidebar's pixel width rather than a flag because
// dragging the sidebar edge can narrow it too.
function isSidebarNarrow() {
  return (sidebarWidth() ?? Infinity) < RAIL_THRESHOLD_PX;
}

// Collapses the sidebar to its rail (wide enough on macOS for window traffic
// lights), or restores its previous width.
function toggleSidebar() {
  const width = sidebarWidth();
  const collapsed = (width ?? Infinity) < RAIL_THRESHOLD_PX;
  if (!collapsed) setShared("sidebar.width", width);
  // Older mods still read `sidebar.collapsed` instead of checking width.
  setShared("sidebar.collapsed", !collapsed);

  const railPx = window()?.platform === "macos" ? MACOS_RAIL_PX : DEFAULT_RAIL_PX;
  const nextPx = collapsed ? (shared("sidebar.width") ?? DEFAULT_SIDEBAR_PX) : railPx;
  run("layout.resize", { id: "sidebar", px: nextPx });
}

// Strips leading status glyphs or spinners ("✦  Working", "⠋ - Thinking") and
// Codex's blinking "[ ! ] " or "[ . ] " prefix, while keeping a leading bracket
// or quote such as "[web] login".
function cleanTitle(raw) {
  return (raw ?? "")
    .replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "")
    .replace(/^\[ [!.] \] /, "")
    .trim();
}

function leadPanes(allPanes) {
  const leads = new Map();
  for (const pane of allPanes) {
    if (!pane.terminal) continue;

    const current = leads.get(pane.tab);
    if (!current) {
      leads.set(pane.tab, pane);
      continue;
    }
    if (current.program?.agent) continue;

    // Prefer an agent pane, then a focused terminal, then the first terminal.
    if (pane.program?.agent || (!current.focused && pane.focused)) {
      leads.set(pane.tab, pane);
    }
  }
  return leads;
}

function tellingTitle(entry) {
  const programName = entry?.program?.name;
  const live = cleanTitle(entry?.title);
  if (!live) return null;

  // `cleanTitle` strips `~` and `/`, so check for paths after removing only
  // non-path status glyphs.
  const withoutGlyph = (entry?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "");
  const isPath = /^[~/]|^[A-Za-z]:\\/.test(withoutGlyph);
  const id = entry?.terminal ?? entry?.address;
  if (isPath || live === id || live === programName) return null;
  if (live.includes("@") || live.toLowerCase() === entry?.program?.key) {
    return null;
  }
  return live;
}

// Matches the tab bar for single-agent tabs: a custom-named tab keeps its name,
// while an unnamed or program-named tab uses a telling live title when present.
// When several agents share an unnamed or program-named tab, `many` uses each
// agent's own title instead of the tab's lead pane.
function tabLabel(tab, agent, lead, many) {
  const source = many ? agent : (lead ?? agent);
  const programName = source?.program?.name ?? agent?.program?.name;
  const live = tellingTitle(source);
  if (!tab) {
    return live || programName || agent?.title || agent?.address || "Terminal";
  }
  const base = tab.named ? tab.name : (programName ?? "Terminal");
  return (tab.name === programName || !tab.named) && live ? live : base;
}

// Sub-agents without a pane are absent from `agents()`, so fall back to the
// core terminal status and treat "error" as "blocked". Sub-agents never show
// as "done" because they report to their parent, whose own "done" notifies
// the user.
function kidStatus(terminal, listed) {
  const status = listed.get(terminal.address) ?? terminal.status;
  if (status === "error") return "blocked";
  if (status === "done") return "idle";
  return status;
}

function currentSort() {
  const selected = shared("agents.sort");
  return SORTS.find((sort) => sort.id === selected) ?? SORTS[0];
}

function mostUrgentStatus(statuses) {
  let top = null;
  for (const status of statuses) {
    if ((RANK[status] ?? 0) > (RANK[top] ?? 0)) top = status;
  }
  return top;
}

// Remote addresses start with `<machine>/` (for example, `vps/t7`).
function machineOf(address) {
  return address.includes("/") ? address.split("/")[0] : null;
}

function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// Draws an agent's icon from Herdr's program table as a tinted glyph or image.
function programIcon(program, size, color) {
  if (!program?.icon) return null;
  if (program.tint) {
    return svg(program.icon).size(size).flex_none().text_color(color);
  }
  return image(program.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;

    this.folded = new Set();
    this.hovered = null;
    this.listed = new Map();

    // Keep each agent's last state and change timestamp (ms) across restarts.
    try {
      this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    } catch {
      this.changed = {};
    }
    if (
      !this.changed ||
      typeof this.changed !== "object" ||
      Array.isArray(this.changed)
    ) {
      this.changed = {};
    }

    try {
      this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    } catch {
      this.pendingPins = [];
    }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    if (!this.pendingPins.length) localStorage.removeItem("pins");

    this.migratingPins = new Set();
    cx.timer.every(30000, (timerCx) => timerCx.notify());
  }

  // Records when each agent's state changes. "done" and "idle" count as the
  // same state because viewing a finished agent turns "done" into "idle"
  // without the agent doing new work.
  track(list, now) {
    let dirty = false;
    for (const agent of list) {
      const s = agent.status === "done" ? "idle" : agent.status;
      if (this.changed[agent.address]?.s === s) continue;
      this.changed[agent.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;

    // Prune unlisted entries only after 30 days because `agents()` can be
    // empty briefly after startup.
    const listed = new Set(list.map((agent) => agent.address));
    for (const [address, entry] of Object.entries(this.changed)) {
      if (!listed.has(address) && now - entry.at > STALE_ENTRY_MAX_AGE_MS) {
        delete this.changed[address];
      }
    }
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keeps offline pins until their terminal reconnects, and keeps each pin
  // pending until core echoes the label so a failed write cannot drop it.
  migratePins(allTerminals) {
    if (this.pendingPins.length === 0) return;

    const liveTerminals = new Map(
      allTerminals
        .filter((terminal) => terminal.state === "live")
        .map((terminal) => [terminal.address, terminal]),
    );
    const pending = this.pendingPins.filter((address) => {
      const terminal = liveTerminals.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });

    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) {
      localStorage.setItem("pins", JSON.stringify(pending));
    } else {
      localStorage.removeItem("pins");
    }
  }

  since(agent) {
    return this.changed[agent.address]?.at ?? 0;
  }

  rank(agent) {
    return RANK[agent.status] ?? 0;
  }

  toggleFold(id, cx) {
    if (this.folded.has(id)) {
      this.folded.delete(id);
    } else {
      this.folded.add(id);
    }
    cx.notify();
  }

  sortMenu(colors) {
    const activeId = currentSort().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(colors.popover)
      .text_size(12.8)
      .child(
        div()
          .px(8)
          .pt(4)
          .pb(6)
          .text_size(11)
          .text_color(colors.dim)
          .child("Sort agents"),
      )
      .children(
        SORTS.map((sort) =>
          h_flex()
            .id(`sort-${sort.id}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(colors.foreground)
            .hover((style) => style.bg(colors.hover))
            .on_click(() => {
              setShared("agents.sort", sort.id);
              closeOverlay(props().overlay);
            })
            .child(
              svg(`mods/workspace-chrome/${sort.icon}.svg`)
                .size(14)
                .flex_none()
                .text_color(colors.muted),
            )
            .child(div().flex_1().child(sort.label))
            .when(sort.id === activeId, (item) =>
              item.child(
                svg("mods/workspace-chrome/check.svg")
                  .size(14)
                  .flex_none()
                  .text_color(colors.foreground),
              ),
            ),
        ),
      );
  }

  // Collects live sub-agents of `parentAddress` depth-first, with tree
  // connectors in front of each row.
  tree(allTerminals, parentAddress, lead = []) {
    const kids = allTerminals.filter(
      (terminal) =>
        terminal.parent === parentAddress && terminal.state === "live",
    );
    return kids.flatMap((terminal, i) => {
      const isLast = i === kids.length - 1;
      return [
        { terminal, lines: [...lead, isLast ? "└" : "├"] },
        ...this.tree(allTerminals, terminal.address, [
          ...lead,
          isLast ? "" : "│",
        ]),
      ];
    });
  }

  subRow(colors, node, shownAddress, compact) {
    const { terminal, lines } = node;
    const status = kidStatus(terminal, this.listed);
    const iconEl = programIcon(terminal.program, 14, colors.foreground);
    const isShown = terminal.address === shownAddress;
    const name =
      terminal.name ||
      terminal.template ||
      terminal.program?.name ||
      terminal.address;

    return h_flex()
      .id(`sub-${terminal.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(isShown, (row) => row.bg(colors.raised))
      .hover((style) => style.bg(colors.hover))
      .on_click(() => {
        if (this.listed.has(terminal.address)) {
          run("pane.focus", { terminal: terminal.address });
        } else {
          run("terminal.peek", { terminal: terminal.address });
        }
      })
      .children(
        lines.map((segment) =>
          div()
            .self_start()
            .mt(-4)
            .w(9)
            .h(17)
            .mr(4)
            .flex_none()
            .when(Boolean(segment), (line) =>
              line.border_l(1.5).border_color(colors.input),
            )
            .when(segment === "└" || segment === "├", (line) =>
              line.border_b(1.5).rounded_bl(6),
            ),
        ),
      )
      .when(Boolean(iconEl), (row) => row.child(div().mr(8).child(iconEl)))
      .child(
        div()
          .flex_1()
          .truncate()
          .text_color(isShown ? colors.foreground : colors.muted)
          .child(name),
      )
      .child(this.statusBadge(colors, status, compact));
  }

  // `compact` renders "!" for blocked rows under a header that already reads
  // "Needs you".
  statusBadge(colors, status, compact = false) {
    if (status === "working") {
      return svg("mods/workspace-chrome/spinner.svg")
        .size(12)
        .mx(1)
        .flex_none()
        .text_color(colors.working)
        .spin(900);
    }
    if (status === "blocked" && compact) {
      return div()
        .size(14)
        .flex_none()
        .rounded(4)
        .bg(colors.blocked + "26")
        .text_size(10.5)
        .font_bold()
        .text_color(colors.blocked)
        .flex()
        .items_center()
        .justify_center()
        .child("!");
    }
    if (status === "blocked") {
      return div()
        .flex_none()
        .px(6)
        .h(18)
        .rounded(5)
        .bg(colors.blocked + "26")
        .text_size(10.5)
        .font_semibold()
        .text_color(colors.blocked)
        .flex()
        .items_center()
        .child("Needs you");
    }
    // Idle shows a ring. Done shows a filled dot.
    if (status === "idle") {
      return div()
        .size(7)
        .mx(3)
        .flex_none()
        .rounded(4)
        .border(1.5)
        .border_color(colors.idle ?? colors.dim);
    }
    const color = colors[status] ?? colors.dim;
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(4)
      .bg(status === "done" ? color : colors.dim + "00");
  }

  // Shows the sub-agent fold chevron and, when folded, the count tinted by the
  // most urgent sub-agent.
  foldButton(colors, agent, subs) {
    const subStatuses = subs.map((node) => kidStatus(node.terminal, this.listed));
    const topStatus = mostUrgentStatus(subStatuses);
    const isOpen = !this.folded.has(agent.address);

    return div()
      .id(`fold-${agent.address}`)
      .h(18)
      .px(3)
      .gap(3)
      .flex()
      .flex_none()
      .items_center()
      .rounded(4)
      .text_size(11)
      .text_color(isOpen ? colors.dim : (colors[topStatus] ?? colors.dim))
      .cursor_pointer()
      .hover((style) => style.bg(colors.hover).text_color(colors.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleFold(agent.address, cx);
      })
      .child(
        svg(`mods/workspace-chrome/chevron-${isOpen ? "down" : "right"}.svg`)
          .size(11)
          .flex_none(),
      )
      .when(!isOpen, (button) => button.child(String(subs.length)));
  }

  pinButton(colors, agent) {
    const isPinned = agent.pinned;
    const iconPath = `mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`;
    return div()
      .id(`pin-${agent.address}`)
      .flex_none()
      .p(2)
      .rounded(4)
      .text_color(colors.dim)
      .cursor_pointer()
      .hover((style) => style.bg(colors.hover).text_color(colors.foreground))
      .tooltip(isPinned ? "Unpin" : "Pin to the top")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run("terminal.pin", { terminal: agent.address, pinned: !isPinned });
        // Pinning moves the row out from under the pointer without a hover-out.
        this.hovered = null;
        cx.notify();
      })
      .child(svg(iconPath).size(13));
  }

  subtitle(colors, agent, extra, worktree, machine, full) {
    if (worktree) {
      const repo =
        worktree.repo && worktree.repo !== agent.space_name
          ? worktree.repo
          : null;
      const lead = [extra, repo].filter(Boolean).join(" \u00b7 ");
      const tail = [agent.space_name || worktree.branch, machine]
        .filter(Boolean)
        .join(" \u00b7 ");

      return h_flex()
        .w_full()
        .min_w(0)
        .items_center()
        .gap(4)
        .text_size(11)
        .line_height(1.2)
        .text_color(colors.dim)
        .when(Boolean(lead), (row) =>
          row.child(div().min_w(0).truncate().child(lead)),
        )
        .child(
          svg("mods/workspace-chrome/branch.svg")
            .size(10)
            .flex_none()
            .text_color(worktree.color ?? colors.accent),
        )
        .child(div().flex_1().min_w(0).truncate().child(tail));
    }

    const parts = full ? [extra, agent.space_name, machine] : [extra];
    const text = parts.filter(Boolean).join(" \u00b7 ");
    return div()
      .w_full()
      .min_w(0)
      .truncate()
      .text_size(11)
      .line_height(1.2)
      .text_color(colors.dim)
      .child(text);
  }

  collapsedRow(colors, agent, index) {
    return h_flex()
      .id(`ag-${agent.address}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .gap(4)
      .hover((style) => style.bg(colors.hover))
      .on_click(() => run("pane.focus", { pane: agent.pane }))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .whitespace_nowrap()
          .text_right()
          .text_color(colors.muted)
          .child(String(index + 1)),
      )
      .child(
        h_flex()
          .w(14)
          .flex_none()
          .items_center()
          .justify_center()
          .child(this.statusBadge(colors, agent.status, true)),
      );
  }

  agentRow(colors, agent, subs, viewState) {
    const { byPriority, labels, now, tabCounts, worktrees } = viewState;
    const iconEl = programIcon(agent.program, 16, colors.foreground);
    const machine = machineOf(agent.address);
    const changedAt = this.since(agent);
    const isIdle = agent.status === "idle" && !agent.focused;
    const isPinned = agent.pinned;
    const isHovered = this.hovered === agent.address;
    const full = byPriority || isPinned;

    const name = labels.get(agent.address);
    const ownTitle = tabCounts.get(agent.tab) > 1 ? tellingTitle(agent) : null;
    const extra = ownTitle && ownTitle !== name ? ownTitle : null;
    const worktree = full ? worktrees[agent.space] : null;
    const hasSubtitle = Boolean(
      extra || (full && (agent.space_name || machine || worktree)),
    );

    return h_flex()
      .id(`ag-${agent.address}`)
      .px(8)
      .when(hasSubtitle, (row) => row.py(3))
      .when(!hasSubtitle, (row) => row.h(28))
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .when(agent.focused, (row) => row.bg(colors.selected))
      .cursor_pointer()
      .hover((style) => style.bg(colors.hover))
      .on_hover((hovered, cx) => {
        if (hovered) this.hovered = agent.address;
        else if (this.hovered === agent.address) this.hovered = null;
        cx.notify();
      })
      .on_click(() => run("pane.focus", { pane: agent.pane }))
      .when(Boolean(iconEl), (row) =>
        row.child(
          div()
            .id(`agent-fold-${agent.address}`)
            .when(subs.length > 0, (iconWrap) =>
              iconWrap.on_click((_e, cx) => {
                cx.stop_propagation();
                this.toggleFold(agent.address, cx);
              }),
            )
            .child(iconEl),
        ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(0)
          .child(
            h_flex()
              .w_full()
              .min_w(0)
              .min_h(17)
              .items_center()
              .gap(6)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(14)
                  .font_medium()
                  .line_height(1.2)
                  .text_color(isIdle ? colors.muted : colors.foreground)
                  .child(name),
              )
              .when(subs.length > 0, (line) =>
                line.child(this.foldButton(colors, agent, subs)),
              )
              .when(isHovered, (line) =>
                line.child(this.pinButton(colors, agent)),
              )
              .when(!isHovered && Boolean(changedAt), (line) =>
                line.child(
                  div()
                    .flex_none()
                    .text_size(11)
                    .text_color(colors.dim)
                    .child(duration(now - changedAt)),
                ),
              )
              .child(
                this.statusBadge(colors, agent.status, byPriority && !isPinned),
              ),
          )
          .when(hasSubtitle, (body) =>
            body.child(
              this.subtitle(colors, agent, extra, worktree, machine, full),
            ),
          ),
      );
  }

  // Builds consecutive groups in list order: spaces in Grouped by space view,
  // or urgency sections in Priority view. Agents of the same space are already
  // adjacent in `agents()`.
  buildGroups(pinned, rest, byPriority, rankOf, worktrees) {
    const groups = pinned.length
      ? [
          {
            id: "pinned",
            label: "Pinned",
            machine: null,
            worktree: null,
            status: null,
            members: pinned,
          },
        ]
      : [];

    for (const agent of rest) {
      const rank = rankOf(agent) || RANK.idle;
      const id = byPriority ? `sec-${rank}` : `sp-${agent.space}`;
      if (groups.at(-1)?.id === id) {
        groups.at(-1).members.push(agent);
        continue;
      }

      const worktree = byPriority ? null : (worktrees[agent.space] ?? null);
      const spaceName = agent.space_name || "";
      const spaceLabel =
        worktree?.repo && worktree.repo !== agent.space_name
          ? `${worktree.repo} / ${agent.space_name}`
          : spaceName;
      groups.push({
        id,
        label: byPriority ? SECTION[rank] : spaceLabel,
        machine: byPriority ? null : machineOf(agent.address),
        worktree,
        status: byPriority ? SECTION_STATUS[rank] : null,
        members: [agent],
      });
    }
    return groups;
  }

  // Renders a foldable group header. When folded, it shows the member count and
  // most urgent status.
  groupHeader(colors, group, byPriority) {
    const isOpen = !this.folded.has(group.id);
    const topStatus = mostUrgentStatus(
      group.members.map((agent) => agent.status),
    );

    return h_flex()
      .id(group.id)
      .px(8)
      .pt(6)
      .h(26)
      .flex_none()
      .gap(5)
      .items_center()
      .text_size(11)
      .font_medium()
      .cursor_pointer()
      .hover((style) => style.text_color(colors.foreground))
      .on_click((_e, cx) => this.toggleFold(group.id, cx))
      .when(Boolean(group.worktree), (row) =>
        row.child(
          svg("mods/workspace-chrome/branch.svg")
            .size(11)
            .flex_none()
            .text_color(group.worktree.color ?? colors.accent),
        ),
      )
      .child(
        div()
          .min_w(0)
          .truncate()
          .text_color(colors[group.status] ?? colors.dim)
          .child(group.label),
      )
      .when(Boolean(group.machine), (row) =>
        row.child(
          div()
            .flex_none()
            .text_size(10)
            .text_color(colors.dim)
            .child(`\u00b7 ${group.machine}`),
        ),
      )
      .when(byPriority || !isOpen, (row) =>
        row.child(
          div().text_color(colors.dim).child(String(group.members.length)),
        ),
      )
      .child(div().flex_1())
      .when(!isOpen, (row) =>
        row
          .when(
            !byPriority && Boolean(topStatus) && topStatus !== "idle",
            (foldedRow) =>
              foldedRow.child(this.statusBadge(colors, topStatus, true)),
          )
          .child(
            svg("mods/workspace-chrome/chevron-right.svg")
              .size(11)
              .flex_none()
              .text_color(colors.dim),
          ),
      );
  }

  headerBar(colors, sort) {
    return h_flex()
      .px(16)
      .h(41)
      .pt(14)
      .pb(5)
      .flex_none()
      .items_center()
      .justify_between()
      .child(div().text_size(11.5).font_medium().text_color(colors.dim).child("Agents"))
      .child(
        div()
          .id("ag-sort")
          .text_size(11)
          .text_color(colors.dim)
          .hover((style) => style.text_color(colors.foreground))
          .on_click(() =>
            openOverlay({
              mod: "agents-by-tab-name",
              kind: "popup",
              width: 200,
              height: 140,
              props: { sortMenu: true },
            }),
          )
          .tooltip(`Sort agents: ${sort.label}`)
          .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
      );
  }

  render() {
    const colors = theme();
    if (props()?.sortMenu) return this.sortMenu(colors);

    const collapsed = isSidebarNarrow();
    const sort = currentSort();
    const byPriority = sort.id === "priority";
    const shownAddress = focused()?.agent;
    const now = Date.now();

    let list = agents();
    this.listed = new Map(list.map((agent) => [agent.address, agent.status]));
    const allTerminals = terminals();
    this.migratePins(allTerminals);
    this.track(list, now);

    // Cache each agent's live sub-agent tree once per render. A kept sub-agent
    // (one with a pane) also appears in `agents()`, so hide its top-level row
    // when a parent's tree already displays it unless it is pinned.
    const trees = new Map(
      list.map((agent) => [agent.address, this.tree(allTerminals, agent.address)]),
    );
    const nested = new Set(
      collapsed
        ? []
        : list.flatMap((agent) =>
            (trees.get(agent.address) ?? []).map((node) => node.terminal.address),
          ),
    );
    list = list.filter((agent) => agent.pinned || !nested.has(agent.address));

    const tabCounts = new Map();
    for (const agent of list) {
      tabCounts.set(agent.tab, (tabCounts.get(agent.tab) ?? 0) + 1);
    }

    const urgency = new Map(
      list.map((agent) => {
        const subRanks = (trees.get(agent.address) ?? []).map(
          (node) => RANK[kidStatus(node.terminal, this.listed)] ?? 0,
        );
        return [agent.address, Math.max(this.rank(agent), ...subRanks)];
      }),
    );
    const rankOf = (agent) => urgency.get(agent.address);
    if (byPriority) {
      list = [...list].sort(
        (x, y) =>
          rankOf(y) - rankOf(x) ||
          this.since(y) - this.since(x) ||
          y.seq - x.seq,
      );
    }

    const pinned = list.filter((agent) => agent.pinned);
    const rest = list.filter((agent) => !agent.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((agent) => agent.address));

    let rows;
    if (collapsed) {
      rows = list.map((agent, i) => this.collapsedRow(colors, agent, i));
    } else {
      // Read host snapshots once because each host call copies the full list.
      const leads = leadPanes(panes());
      const tabs = new Map(
        spaces()
          .flatMap((space) => space.tabs)
          .map((tab) => [tab.id, tab]),
      );
      const rawWorktrees = shared("spaces.worktrees");
      const worktrees =
        rawWorktrees &&
        typeof rawWorktrees === "object" &&
        !Array.isArray(rawWorktrees)
          ? rawWorktrees
          : {};
      const labels = new Map(
        list.map((agent) => {
          const tab = tabs.get(agent.tab);
          const many = tabCounts.get(agent.tab) > 1;
          return [agent.address, tabLabel(tab, agent, leads.get(agent.tab), many)];
        }),
      );

      const viewState = { byPriority, labels, now, tabCounts, worktrees };
      const rowsForAgent = (agent) => {
        const subs = trees.get(agent.address) ?? [];
        const mainRow = this.agentRow(colors, agent, subs, viewState);
        if (this.folded.has(agent.address)) return [mainRow];
        return [
          mainRow,
          ...subs.map((node) =>
            this.subRow(colors, node, shownAddress, byPriority),
          ),
        ];
      };

      const groups = this.buildGroups(pinned, rest, byPriority, rankOf, worktrees);
      rows = groups.flatMap((group) => [
        this.groupHeader(colors, group, byPriority),
        ...(this.folded.has(group.id)
          ? []
          : group.members.flatMap(rowsForAgent)),
      ]);
    }

    const emptyNotice =
      "No agent status yet. Agents show up here when they report their " +
      "status. Older versions and agents inside tmux may not.";

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(colors.chrome)
      .border_t(1)
      .border_color(colors.border)
      .text_size(13)
      .when(!collapsed, (panel) => panel.child(this.headerBar(colors, sort)))
      .when(list.length === 0 && !collapsed, (panel) =>
        panel.child(
          div().px(12).text_size(12).text_color(colors.dim).child(emptyNotice),
        ),
      )
      .child(
        v_flex()
          .id("ag-list")
          .flex_1()
          .min_h(0)
          .px(collapsed ? 0 : 8)
          .overflow_y_scrollbar()
          .mode("always")
          .children(rows),
      )
      .when(collapsed, (panel) =>
        panel.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(colors.dim)
                .hover((style) => style.text_color(colors.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
