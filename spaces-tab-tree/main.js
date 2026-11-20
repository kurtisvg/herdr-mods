// If Herdr's mods/spaces-tab-tree is a link to this folder, Herdr does not
// notice edits made through the link. Run `./plugin.sh reload spaces-tab-tree`
// after changing a file.

// This mod renders workspace spaces with each space's tabs listed underneath
// it. Spaces keep stable colored avatars, nest worktrees under their main
// checkout with repo-colored badges, and group by machine once more than one
// machine is known. The mod also publishes worktree metadata under
// `spaces.worktrees` for `agents-by-tab-name`.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import {
  spaces,
  machines,
  panes,
  run,
  openOverlay,
  exec,
  hc,
  theme,
  shared,
  setShared,
  watchFolder,
  window,
  layout,
  checking,
} from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar uses its width rather than a flag because dragging its edge also narrows it.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Return the live folder of the space's first terminal, or the space's initial folder.
// Callers pass `panes()` once because each host read copies every pane.
function place(space, allPanes) {
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  return allPanes.find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder;
}

const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
// Keep a floor on the space name and git tail so short names like "api" stay
// readable next to long branch names.
const SIDE_MIN = 48;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (space, allPanes) =>
  JSON.stringify([space.machine ?? null, place(space, allPanes)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Poll visible repos at this interval while the window is active to catch edits
// or commits made outside Herdr.
const FALLBACK = 60000;
// Limit concurrent git checks (two git processes per place) so hundreds of
// spaces cannot exhaust macOS Dock file descriptors (256) or a core's 16 exec slots.
const AT_ONCE = 6;

// Wait for both runs to settle before releasing a concurrency slot.
async function both(first, second) {
  const done = await Promise.allSettled([first, second]);
  const failed = done.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((result) => result.value);
}

// Shared avatar palette across mods: one strong color per hue in both light and dark themes.
const MARK = {
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
};

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readStoredSet(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function readReconnecting() {
  try {
    const parsed = plainObject(
      JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}"),
    );
    if (!parsed) return {};
    const kept = {};
    for (const [name, state] of Object.entries(parsed)) {
      if (!plainObject(state) || !plainObject(state.machine)) continue;
      if (typeof state.machine.name !== "string") continue;
      kept[name] = { ...state, busy: false };
    }
    return kept;
  } catch {
    return {};
  }
}

function sameWorktrees(next, prev) {
  const current = plainObject(prev);
  if (!current) return false;
  const nextKeys = Object.keys(next);
  if (nextKeys.length !== Object.keys(current).length) return false;
  return nextKeys.every((id) => {
    const a = next[id];
    const b = plainObject(current[id]);
    return (
      Boolean(b) && a.repo === b.repo && a.branch === b.branch && a.color === b.color
    );
  });
}

// Drop leading status glyphs/spinners and Codex's "[ ! ] " / "[ . ] " prefix,
// stopping at opening brackets or quotes so titles like "[web] login" keep them.
const clean = (title) =>
  (title ?? "")
    .replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "")
    .replace(/^\[ [!.] \] /, "")
    .trim();

function leadPanes(allPanes) {
  const leads = new Map();
  for (const pane of allPanes) {
    if (!pane.terminal) continue;
    const current = leads.get(pane.tab);
    // Prefer the first agent pane in the tab, else the first focused terminal,
    // else the first terminal.
    const takesLead =
      !current ||
      (!current.program?.agent &&
        (pane.program?.agent || (!current.focused && pane.focused)));
    if (takesLead) leads.set(pane.tab, pane);
  }
  return leads;
}

// Match the label logic in mods/tabs/main.js and mods/agents-by-tab-name/main.js.
function tabLabel(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;

  const live = clean(lead.title);
  // clean() strips leading ~ and /, so test for a path after stripping only status glyphs.
  const withoutGlyph = (lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "");
  const isPath = /^[~/]|^[A-Za-z]:\\/.test(withoutGlyph);
  const telling =
    live &&
    live !== lead.terminal &&
    live !== prog &&
    !isPath &&
    !live.includes("@") &&
    live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

function alpha(hex, hexAlpha) {
  if (typeof hex !== "string" || !hex.startsWith("#")) return hex;
  if (hex.length === 4 || hex.length === 5) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}${hexAlpha}`;
  }
  if (hex.length >= 7) return hex.slice(0, 7) + hexAlpha;
  return hex;
}

function spaceFill(id, themeColors, colorMap = plainObject(shared("space.colors")) ?? {}) {
  const raw = colorMap[id];
  const color = typeof raw === "string" ? raw : "ansi6";
  return (
    (color.startsWith("#") ? color : (MARK[color] ?? themeColors[color])) ?? MARK.ansi6
  );
}

function syncSpaceColors(allSpaces) {
  const stored = plainObject(shared("space.colors")) ?? {};
  const ids = new Set(allSpaces.map((space) => space.id));
  const kept = Object.fromEntries(
    Object.entries(stored).filter(([id, c]) => ids.has(id) && typeof c === "string"),
  );
  let changed = Object.keys(kept).length !== Object.keys(stored).length;
  const palette = Object.keys(MARK);
  for (const space of allSpaces) {
    if (kept[space.id] || space.name === "~") continue;
    const uses = (color) => Object.values(kept).filter((v) => v === color).length;
    kept[space.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed && !checking()) setShared("space.colors", kept);
}

function tabIcon(program, isCurrent, themeColors) {
  if (!program?.icon) {
    return svg("mods/workspace-chrome/terminal.svg")
      .size(13)
      .flex_none()
      .text_color(themeColors.dim);
  }
  if (program.tint) {
    return svg(program.icon)
      .size(13)
      .flex_none()
      .text_color(isCurrent ? themeColors.foreground : themeColors.muted);
  }
  return image(program.icon).size(13).flex_none();
}

function spaceAvatar(name, fill, isWt, isNestedWt) {
  if (isNestedWt) {
    return h_flex()
      .size(16)
      .flex_none()
      .rounded(4)
      .bg(alpha(fill, "26"))
      .border_1()
      .border_color(alpha(fill, "55"))
      .items_center()
      .justify_center()
      .child(svg("mods/workspace-chrome/branch.svg").size(10).text_color(fill));
  }
  if (isWt) {
    return h_flex()
      .size(18)
      .flex_none()
      .rounded(5)
      .bg(fill)
      .items_center()
      .justify_center()
      .child(svg("mods/workspace-chrome/branch.svg").size(11).text_color("#ffffff"));
  }
  return h_flex()
    .size(18)
    .flex_none()
    .rounded(5)
    .bg(fill)
    .items_center()
    .justify_center()
    .text_size(10.5)
    .font_bold()
    .text_color("#ffffff")
    .child([...(name ?? "")][0]?.toUpperCase() ?? "?");
}

function dropLine(fromIndex, toIndex, themeColors) {
  return div()
    .absolute()
    .left(0)
    .right(0)
    .h(2)
    .bg(themeColors.accent)
    .when(fromIndex < toIndex, (line) => line.bottom(0))
    .when(fromIndex > toIndex, (line) => line.top(0));
}

// Mark a rail cell prominently only when an agent in that space needs attention.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(themeColors, status) {
  return themeColors[status] ?? themeColors.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    // Map where() key to { name, branch, ahead, behind, repo, linked }, or null outside git.
    this.git = {};
    this.checked = {}; // where() -> timestamp of last git check
    this.unsure = new Set(); // where() keys whose git check failed transiently
    this.pending = new Set(); // where() keys queued for refreshGit
    this.refreshing = false;
    this.busy = {}; // pane id -> whether an agent is working or a foreground program is running
    this.ready = {}; // machine name -> whether its layout was ready on the last tick
    this.at = {}; // space id -> its where() key on the last tick
    this.watching = new Map(); // local repo path -> active FolderWatch
    // Newly created spaces wait briefly for their first git check so worktrees
    // appear directly under their repo instead of jumping after render.
    this.shown = new Set(spaces().map((space) => space.id));
    this.born = {};
    this.ordering = null;
    this.pressed = null;
    this.over = null;
    this.pressedTab = null;
    this.overTab = null;
    this.hoveredSpace = null;
    this.hoveredTab = null;
    this.copiedLogin = null;
    // Scroll position handle used to keep the active space or tab in view.
    this.scroll = ScrollHandle.new();
    // Active item's index among direct list children (headers and rows), or -1.
    this.activeAt = -1;
    this.revealed = null;
    this.revealedAt = -1;
    this.machines = [];
    this.reconnecting = readReconnecting();
    this.folded = readStoredSet("machines.folded");
    this.collapsedTabs = readStoredSet("spaces.collapsedTabs");
    if (checking()) return;

    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    // Poll lightly and refresh git only when refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const allSpaces = spaces();
    for (const space of allSpaces) {
      if (!this.shown.has(space.id)) this.born[space.id] ??= now;
    }
    const due = this.due(now, allSpaces, panes());
    if (due.size) this.refreshGit(due, cx);
    if (allSpaces.some((space) => !this.shown.has(space.id)) || this.orderingDue(now)) {
      cx.notify();
    }
  }

  // Return places whose git state could have changed: new spaces or directory
  // changes, panes whose command or agent turn just finished, machines whose
  // layout just became ready, and visible repos past the fallback interval.
  due(now, allSpaces, allPanes) {
    const at = {};
    for (const space of allSpaces) at[space.id] = where(space, allPanes);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) {
      if (!keys.has(k)) {
        delete this.git[k];
        delete this.checked[k];
        this.unsure.delete(k);
      }
    }

    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) {
      if (!repos.has(JSON.stringify([null, repo]))) {
        this.watching.delete(repo);
        pending.cancel();
      }
    }

    const due = new Set([...keys].filter((k) => !(k in this.git)));
    // Re-check when a space moved to a different folder, since cached git state may be stale.
    for (const [id, k] of Object.entries(at)) {
      if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    }
    this.at = at;

    const spaceOf = {};
    for (const space of allSpaces) {
      for (const tab of space.tabs ?? []) spaceOf[tab.id] = space;
    }
    const busy = {};
    for (const pane of allPanes) {
      if (!pane.terminal || !spaceOf[pane.tab]) continue;
      busy[pane.pane] =
        pane.status === "working" || !(pane.program?.shell || pane.program?.agent);
      if (this.busy[pane.pane] && !busy[pane.pane]) {
        for (const k of this.sameRepo(at[spaceOf[pane.tab].id], keys)) due.add(k);
      }
    }
    this.busy = busy;

    for (const machine of machines()) {
      const ready = machine.layout === "ready";
      if (ready && this.ready[machine.name] === false) {
        for (const k of keys) {
          if (JSON.parse(k)[0] === machine.name) due.add(k);
        }
      }
      this.ready[machine.name] = ready;
    }

    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        const unfolded = !this.folded.has(JSON.parse(k)[0]);
        if (asks && unfolded && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // Return `key` and every other tracked place sharing its repository, since a
  // commit in one worktree can update ahead/behind counts in another.
  sameRepo(key, keys) {
    if (!keys.has(key)) return [];
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const result = await hc(["machine", "ls", "--json"]);
        if (result.code === 0) {
          const all = JSON.parse(result.stdout).machines ?? [];
          this.machines = all.filter((machine) => !machine.temporary);
        }
      } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return (
      machine?.state === "unreachable" &&
      /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "")
    );
  }

  reconnect(machine, cx) {
    if (!plainObject(machine) || typeof machine.name !== "string") return;
    const name = machine.name;
    if (!plainObject(this.reconnecting[name])) {
      this.reconnecting[name] = { machine, removed: false };
    }
    const state = this.reconnecting[name];
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const ask = async (args) => {
          const result = await hc([...args, "--json"]);
          if (result.code !== 0) {
            let error;
            try {
              error = JSON.parse(result.stdout || result.stderr).error?.message;
            } catch {}
            throw new Error(error || result.stderr || result.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem(
            "machines.reconnecting",
            JSON.stringify(this.reconnecting),
          );
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);

        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (err) {
        state.error = String(err?.message ?? err);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // Coalesce concurrent refresh requests so each queued place is checked once per pass.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const batch = [...this.pending];
        this.pending.clear();
        let next = 0;
        const workers = Array.from(
          { length: Math.min(AT_ONCE, batch.length) },
          async () => {
            while (next < batch.length) await this.check(batch[next++], cx);
          },
        );
        await Promise.all(workers);
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // Read one place's git repository name, branch, ahead/behind counts, and worktree state.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watcher.
      // Use two separate calls because a folder name can contain a newline.
      const [topResult, commonResult] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], {
          cwd,
          on,
        }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
          cwd,
          on,
        }),
      );
      if (topResult.code !== 0 || commonResult.code !== 0) {
        // Remember only git's own "not a git repository" response as non-repo.
        // Retry any other failure later.
        const err = topResult.code !== 0 ? topResult.stderr : commonResult.stderr;
        if (/not a git repository/i.test(err)) {
          this.git[key] = null;
        } else {
          this.unsure.add(key);
          this.git[key] ??= null;
        }
        return;
      }

      // The common .git folder names the repo. A linked worktree's top differs from it.
      const top = topResult.stdout.replace(/\r?\n$/, "");
      const repo = commonResult.stdout.replace(/\r?\n$/, "");
      const [branchResult, countsResult] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec(
          "git",
          ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
          { cwd, on },
        ),
      );
      const name = repo.endsWith("/.git")
        ? base(repo.slice(0, -5))
        : base(repo).replace(/\.git$/, "");
      const [ahead, behind] =
        countsResult.code === 0
          ? countsResult.stdout.trim().split(/\s+/).map(Number)
          : [0, 0];
      this.git[key] = {
        name,
        branch:
          branchResult.code === 0
            ? branchResult.stdout.trim().replace(/^refs\/heads\//, "")
            : "(detached)",
        ahead,
        behind,
        repo: JSON.stringify([on, repo]),
        linked: repo !== `${top}/.git`,
      };
      if (!on) this.watch(repo, cx);
    } catch {
      // Keep the last known git display when a remote machine is unreachable, and retry later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(space) {
    // A popup is as tall as its items. Height is only the cap.
    openOverlay({
      mod: "menu",
      kind: "popup",
      width: 200,
      height: 260,
      props: { tab: "space", target: { id: space.id } },
    });
  }

  orderingDue(now) {
    if (!this.ordering || now - this.ordering.at < 1000) return false;
    const readyMachines = machines();
    return this.ordering.machines.every((name) =>
      readyMachines.some((machine) => machine.name === name && machine.layout === "ready"),
    );
  }

  // Return spaces in display order, nesting each linked worktree under its main checkout.
  ordered(allSpaces = spaces(), allPanes = panes()) {
    const isReady = (space) =>
      this.shown.has(space.id) ||
      where(space, allPanes) in this.git ||
      Date.now() - (this.born[space.id] ??= Date.now()) > 1500;
    for (const space of allSpaces) {
      if (!this.shown.has(space.id) && isReady(space)) this.shown.add(space.id);
    }

    const list = allSpaces.map((w, i) => ({
      w,
      i,
      g: this.git[where(w, allPanes)] ?? null,
    }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    // Track repos whose worktrees are already listed under the first matching main space.
    const placed = new Set();
    for (const r of list) {
      if (nested(r)) continue;
      const canGroup = r.g && !r.g.linked && !placed.has(r.g.repo);
      const kids = canGroup ? list.filter((k) => nested(k) && k.g.repo === r.g.repo) : [];
      out.push({ ...r, tree: null, parent: null });
      if (!kids.length) continue;
      placed.add(r.g.repo);
      kids.forEach((kid, n) => {
        out.push({ ...kid, tree: n === kids.length - 1 ? "└─" : "├─", parent: r.w });
      });
    }

    // Simulate the batch so later indexes include earlier moves. Wait briefly
    // before retrying if a sync conflict discards a move.
    const order = allSpaces.map((space) => space.id);
    const target = out.map((entry) => entry.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (!checking() && (this.ordering?.key !== key || this.orderingDue(Date.now()))) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter((entry) => this.shown.has(entry.w.id));
  }

  // Publish worktree metadata so agents-by-tab-name can mark worktree agents with
  // their repository, branch, and color.
  syncWorktrees(rows, themeColors, colorMap) {
    if (checking()) return;
    const worktrees = {};
    for (const entry of rows) {
      if (!entry.g?.linked) continue;
      const ownerId = entry.parent ? entry.parent.id : entry.w.id;
      const color = spaceFill(ownerId, themeColors, colorMap);
      worktrees[entry.w.id] = {
        repo: entry.parent?.name || entry.g.name,
        branch: entry.g.branch || entry.w.name,
        color,
      };
    }
    if (!sameWorktrees(worktrees, shared("spaces.worktrees") ?? {})) {
      setShared("spaces.worktrees", worktrees);
    }
  }

  tabStatus(themeColors, status) {
    if (status === "working") {
      return svg("mods/workspace-chrome/spinner.svg")
        .size(11)
        .flex_none()
        .text_color(themeColors.working)
        .spin(900);
    }
    if (status === "blocked") {
      return div().size(6).mx(2).flex_none().rounded(3).bg(themeColors.blocked);
    }
    if (status === "done") {
      return div().size(6).mx(2).flex_none().rounded(3).bg(themeColors.done);
    }
    if (status === "idle") {
      return div()
        .size(6)
        .mx(2)
        .flex_none()
        .rounded(3)
        .border(1.5)
        .border_color(themeColors.idle ?? themeColors.dim);
    }
    return null;
  }

  tabRow(entry, tab, lead, themeColors, colorMap) {
    const { w: space, tree, parent } = entry;
    const isCurrent = space.active && tab.active;
    const name = tabLabel(tab, lead);
    const ownerId = tree && parent ? parent.id : space.id;
    const fill = spaceFill(ownerId, themeColors, colorMap);
    const statusEl = this.tabStatus(themeColors, tab.status);
    const hovered = this.hoveredTab === tab.id;
    const pic = tabIcon(lead?.program, isCurrent, themeColors);
    const tabs = space.tabs ?? [];
    const tabIdx = tabs.findIndex((c) => c.id === tab.id);
    const fromTabIdx =
      this.pressedTab?.space === space.id
        ? tabs.findIndex((c) => c.id === this.pressedTab.id)
        : -1;
    const draggingThis = this.pressedTab?.id === tab.id && this.overTab !== tab.id;
    const dropHere =
      this.pressedTab !== null &&
      this.pressedTab.space === space.id &&
      this.overTab === tab.id &&
      this.pressedTab.id !== tab.id &&
      fromTabIdx !== -1 &&
      tabIdx !== -1;

    const pill = h_flex()
      .id(`sp-tab-pill-${tab.id}`)
      .relative()
      .flex_1()
      .min_w(0)
      .h(24)
      .px(7)
      .gap(7)
      .rounded(6)
      .items_center()
      .cursor_pointer()
      .when(isCurrent, (el) => el.bg(themeColors.selected))
      .when(!isCurrent, (el) => el.hover((s) => s.bg(themeColors.hover)))
      .when(draggingThis, (el) => el.opacity(0.5))
      .when(dropHere, (el) => el.child(dropLine(fromTabIdx, tabIdx, themeColors)))
      .on_hover((isOn, cx) => {
        if (isOn) this.hoveredTab = tab.id;
        else if (this.hoveredTab === tab.id) this.hoveredTab = null;
        cx.notify();
      })
      .on_mouse_down("left", (event, cx) => {
        cx.stop_propagation();
        if (event.click_count === 2) {
          this.pressedTab = null;
          this.overTab = null;
          run("tab.rename", { id: tab.id });
          return;
        }
        this.pressed = null;
        this.over = null;
        this.pressedTab = { id: tab.id, space: space.id };
        this.overTab = tab.id;
        cx.notify();
      })
      .on_mouse_move((_e, cx) => {
        // Dragging a space over a tab row targets that tab's space.
        if (this.pressed !== null) {
          const source = spaces().find((s) => s.id === this.pressed);
          const sameMachine = (source?.machine ?? null) === (space.machine ?? null);
          const over = source && sameMachine ? space.id : null;
          if (this.over !== over) {
            this.over = over;
            cx.notify();
          }
          return;
        }
        if (!this.pressedTab) return;
        const over = this.pressedTab.space === space.id ? tab.id : null;
        if (this.overTab !== over) {
          this.overTab = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        // Dropping a space onto another space's tab moves the space to that position.
        if (this.pressed !== null) {
          const fromSpace = this.pressed;
          const overSpace = this.over;
          this.pressed = null;
          this.over = null;
          this.pressedTab = null;
          this.overTab = null;
          if (overSpace === space.id && fromSpace !== space.id) {
            const index = spaces().findIndex((s) => s.id === space.id);
            if (index !== -1) run("space.move", { id: fromSpace, index: index + 1 });
          }
          cx.notify();
          return;
        }
        const from = this.pressedTab;
        const over = this.overTab;
        this.pressedTab = null;
        this.overTab = null;
        if (from && from.space === space.id && over === tab.id && from.id !== tab.id) {
          const idx = (space.tabs ?? []).findIndex((c) => c.id === tab.id);
          if (idx !== -1) run("tab.move", { id: from.id, index: idx + 1 });
        } else if (from?.id === tab.id) {
          run("tab.select", { id: tab.id });
        }
        cx.notify();
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
      .child(pic)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(12.5)
          .text_color(isCurrent ? themeColors.foreground : themeColors.muted)
          .child(tab.zoomed ? `${name} Z` : name),
      )
      .when(hovered, (el) =>
        el.child(
          div()
            .id(`sp-tab-close-${tab.id}`)
            .flex_none()
            .p(2)
            .rounded(4)
            .text_color(themeColors.dim)
            .hover((s) => s.bg(themeColors.hover).text_color(themeColors.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              cx.stop_propagation();
              run("tab.close", { id: tab.id });
            })
            .child(svg("mods/pane/close.svg").size(11)),
        ),
      )
      .when(Boolean(statusEl), (el) => el.child(statusEl));

    return h_flex()
      .id(`sp-tab-${tab.id}`)
      .flex_none()
      .h(25)
      .pl(16)
      .items_center()
      .when(!tree, (el) =>
        el.child(
          div()
            .w(1)
            .h_full()
            .mr(8)
            .flex_none()
            .bg(entry.g?.linked ? alpha(fill, "66") : themeColors.border),
        ),
      )
      .when(Boolean(tree), (el) =>
        el
          .child(
            div()
              .w(1)
              .h_full()
              .mr(21)
              .flex_none()
              .when(tree === "├─", (line) => line.bg(themeColors.border)),
          )
          .child(div().w(1.5).h_full().mr(7).flex_none().bg(alpha(fill, "66"))),
      )
      .child(pill);
  }

  machineSection(machineName, startOffset, sectionContext) {
    const { rows, collapsed, themeColors, drawList, isLoading, loadingRow } =
      sectionContext;
    const mine = rows.filter((entry) => (entry.w.machine ?? null) === machineName);
    const repair = this.reconnecting[machineName];
    const machine =
      this.machines.find((item) => item.name === machineName) ?? repair?.machine;
    const connected = !machineName || machine?.state === "connected";
    const rebuilt = this.rebuilt(machine) || Boolean(repair);
    const login =
      machine?.state === "needs_login" ? `hc machine login ${machineName}` : null;
    const folded = this.folded.has(machineName);
    const stateLabel = (machine?.state ?? "asleep").replace(/_/g, " ");
    const railTip = login
      ? `${machineName} needs a login: run ${login}. Click for Copy.`
      : machineName
        ? `${machineName} · ${connected ? "connected" : stateLabel}`
        : "This computer";
    const icon = svg(
      `mods/workspace-chrome/${machineName ? "server" : "monitor"}.svg`,
    )
      .size(13)
      .flex_none();
    const badge = div()
      .absolute()
      .right(-3)
      .bottom(-2)
      .size(6)
      .rounded(3)
      .border_1()
      .border_color(themeColors.chrome)
      .bg(connected ? themeColors.ansi2 : themeColors.dim);

    const head = h_flex()
      .id(`machine-${machineName ?? "local"}`)
      .h(26)
      .flex_none()
      .px(collapsed ? 0 : 8)
      .gap(7)
      .items_center()
      .text_size(11)
      .text_color(themeColors.dim)
      .when(collapsed, (el) =>
        el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(railTip),
      )
      .cursor_pointer()
      .hover((s) => s.bg(themeColors.hover))
      .on_click((_e, cx) => {
        if (collapsed && login) {
          run("app.settings", { section: "machines" });
          return;
        }
        if (folded) this.folded.delete(machineName);
        else this.folded.add(machineName);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      .when(machine?.keeps_running_after_logout === false, (el) =>
        el.child(
          div()
            .id(`machine-logout-${machineName}`)
            .flex_none()
            .text_color(themeColors.blocked)
            .tooltip("Agents stop when you disconnect. Click for the fix.")
            .on_click((_e, cx) => {
              cx.stop_propagation();
              openOverlay({ mod: "machine-add", kind: "dialog", width: 560 });
            })
            .child("⚠"),
        ),
      )
      .when(!collapsed, (el) => el.child(icon))
      .when(collapsed, (el) =>
        el.child(
          div()
            .relative()
            .flex_none()
            .child(icon)
            .when(Boolean(machineName), (c) => c.child(badge)),
        ),
      )
      .when(!collapsed, (el) =>
        el
          .child(div().flex_1().truncate().child(machineName ?? "This computer"))
          .when(!connected && !rebuilt && !login, (c) =>
            c.child(div().flex_none().child(stateLabel)),
          )
          .when(rebuilt, (c) =>
            c.child(
              h_flex()
                .flex_none()
                .gap(3)
                .items_center()
                .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
                .child(
                  div()
                    .id(`machine-connect-${machineName}`)
                    .text_color(repair?.error ? themeColors.blocked : themeColors.muted)
                    .hover((s) => s.text_color(themeColors.foreground))
                    .tooltip(
                      repair?.error ||
                        "This machine was rebuilt or replaced. Click to connect to the new one.",
                    )
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.reconnect(machine, cx);
                    })
                    .child(repair?.busy ? "Connecting…" : "Connect"),
                ),
            ),
          )
          .when(connected, (c) =>
            c.child(
              div()
                .id(`machine-add-${machineName ?? "local"}`)
                .flex_none()
                .px(4)
                .rounded(4)
                .hover((s) =>
                  s.bg(themeColors.hover).text_color(themeColors.foreground),
                )
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  run("space.new", { machine: machineName ?? "" });
                })
                .child("+"),
            ),
          )
          .child(
            div()
              .size(6)
              .rounded(3)
              .flex_none()
              .bg(connected ? themeColors.ansi2 : themeColors.dim),
          )
          .child(
            svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`)
              .size(11)
              .flex_none(),
          ),
      );

    if (!collapsed && rebuilt) return [head];

    const cell = collapsed ? railCell : (el) => el;
    const guidance =
      !collapsed && login
        ? [
            v_flex()
              .px(8)
              .pb(6)
              .gap(3)
              .flex_none()
              .child(
                div()
                  .text_size(11)
                  .text_color(themeColors.blocked)
                  .child("needs a login: run"),
              )
              .child(
                h_flex()
                  .gap(5)
                  .items_center()
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .tooltip(login)
                      .text_size(11)
                      .text_color(themeColors.muted)
                      .child(login),
                  )
                  .child(
                    div()
                      .id(`machine-login-copy-${machineName}`)
                      .flex_none()
                      .px(5)
                      .py(2)
                      .rounded(4)
                      .text_size(11)
                      .text_color(themeColors.foreground)
                      .bg(themeColors.raised)
                      .cursor_pointer()
                      .hover((s) => s.bg(themeColors.hover))
                      .on_click((_e, cx) => {
                        cx.stop_propagation();
                        cx.write_to_clipboard(login);
                        this.copiedLogin = login;
                        cx.notify();
                      })
                      .child(this.copiedLogin === login ? "Copied" : "Copy"),
                  ),
              ),
          ]
        : [];

    const bodyStart = startOffset + 1 + guidance.length;
    let body = [];
    if (!folded) {
      if (mine.length) {
        body = drawList(mine, bodyStart);
      } else if (isLoading(machineName)) {
        body = [loadingRow(machineName)];
      } else {
        const empty = h_flex()
          .id(`machine-new-${machineName ?? "local"}`)
          .h(28)
          .flex_none()
          .px(collapsed ? 0 : 8)
          .gap(7)
          .items_center()
          .rounded(7)
          .text_size(12)
          .text_color(themeColors.dim)
          .hover((s) => s.bg(themeColors.hover).text_color(themeColors.foreground))
          .on_click(() => run("space.new", { machine: machineName ?? "" }))
          .when(collapsed, (el) =>
            el
              .w(RAIL_CELL)
              .rounded(6)
              .justify_center()
              .tooltip(`New space on ${machineName ?? "this computer"}`)
              .child(
                h_flex()
                  .size(18)
                  .rounded(5)
                  .border_1()
                  .border_color(themeColors.dim)
                  .items_center()
                  .justify_center()
                  .child(svg("mods/workspace-chrome/plus.svg").size(10)),
              ),
          )
          .when(!collapsed, (el) =>
            el
              .child(svg("mods/workspace-chrome/plus.svg").size(12))
              .child("New space there"),
          );
        body = [cell(empty)];
      }
    }
    return [cell(head), ...guidance, ...body];
  }

  // Build list children, adding machine headers once any remote machine is known.
  grouped(themeColors, collapsed, allSpaces, allPanes) {
    const rows = this.ordered(allSpaces, allPanes);
    const colorMap = plainObject(shared("space.colors")) ?? {};
    this.syncWorktrees(rows, themeColors, colorMap);
    const leads = leadPanes(allPanes);

    const drawSpace = (entry, offset) => {
      if (collapsed) {
        if (entry.w.active) this.activeAt = offset;
        return [this.compact(entry, themeColors)];
      }
      const tabs = entry.w.tabs ?? [];
      const showTabs = tabs.length > 0 && !this.collapsedTabs.has(entry.w.id);
      if (entry.w.active) {
        const ti = showTabs ? tabs.findIndex((c) => c.active) : -1;
        this.activeAt = offset + (ti >= 0 ? 1 + ti : 0);
      }
      const tabRows = showTabs
        ? tabs.map((tab) =>
            this.tabRow(entry, tab, leads.get(tab.id), themeColors, colorMap),
          )
        : [];
      return [this.row(entry, themeColors, colorMap), ...tabRows];
    };

    const drawList = (items, startOffset) => {
      const out = [];
      for (const entry of items) {
        out.push(...drawSpace(entry, startOffset + out.length));
      }
      return out;
    };

    // Track the active item's index among direct list children so ScrollHandle
    // accounts for machine headers, login prompts, and loading rows.
    this.activeAt = -1;
    const remote = [
      ...new Set([
        ...rows.map((entry) => entry.w.machine).filter(Boolean),
        ...this.machines.map((machine) => machine.name),
        ...Object.keys(this.reconnecting),
      ]),
    ].sort();
    const isLoading = (machineName) => {
      const state = machines().find((item) => item.name === machineName)?.layout;
      const awaitingLayout =
        !state &&
        this.machines.some(
          (item) => item.name === machineName && item.state === "connected",
        );
      const hasHidden = allSpaces.some(
        (space) =>
          (space.machine ?? null) === machineName && !this.shown.has(space.id),
      );
      return state === "loading" || awaitingLayout || hasHidden;
    };
    const loadingRow = (machineName) =>
      h_flex()
        .id(`machine-loading-${machineName ?? "local"}`)
        .h(28)
        .flex_none()
        .px(collapsed ? 0 : 8)
        .items_center()
        .when(collapsed, (el) => el.justify_center())
        .text_size(12)
        .text_color(themeColors.dim)
        .child(collapsed ? "…" : "Loading…");

    if (!remote.length) {
      if (isLoading(null) && !rows.length) return [loadingRow(null)];
      return drawList(rows, 0);
    }

    const out = [];
    for (const machineName of [null, ...remote]) {
      const section = this.machineSection(machineName, out.length, {
        rows,
        collapsed,
        themeColors,
        drawList,
        isLoading,
        loadingRow,
      });
      out.push(...section);
    }
    return out;
  }

  // Render unusual git details after a space's name ("herdr · spike ↑2 ↓1").
  // Omit the repo or branch when the space name already matches it, and omit
  // main and master. When space is tight, the name and git tail shrink proportionally.
  gitTail(gitInfo, tree, name, themeColors) {
    const raw = gitInfo.branch ?? "detached";
    const same = (value) => value.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(gitInfo.name) ? "" : gitInfo.name;
    const whereText = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(whereText ? SIDE_MIN : 0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(themeColors.dim)
      .when(Boolean(whereText), (el) =>
        el.child(div().min_w(0).truncate().child(whereText)),
      )
      .when(gitInfo.ahead > 0, (el) =>
        el.child(
          div()
            .flex_none()
            .text_color(themeColors.ansi2)
            .child(`\u2191${gitInfo.ahead}`),
        ),
      )
      .when(gitInfo.behind > 0, (el) =>
        el.child(
          div()
            .flex_none()
            .text_color(themeColors.ansi1)
            .child(`\u2193${gitInfo.behind}`),
        ),
      );
  }

  row(entry, themeColors, colorMap) {
    const { w: space, i, g: gitInfo, tree, parent } = entry;
    const isActive = space.active;
    const isNestedWt = Boolean(tree);
    const isWt = isNestedWt || Boolean(gitInfo?.linked);
    const tabs = space.tabs ?? [];
    const foldedTabs = this.collapsedTabs.has(space.id);
    const hovered = this.hoveredSpace === space.id;
    const fromIndex =
      this.pressed === null ? -1 : spaces().findIndex((s) => s.id === this.pressed);
    const dropHere =
      this.pressed !== null &&
      this.over === space.id &&
      this.pressed !== space.id &&
      fromIndex !== -1;
    const ownerId = isNestedWt && parent ? parent.id : space.id;
    const fill = spaceFill(ownerId, themeColors, colorMap);
    const highlightRow = isActive && (foldedTabs || tabs.length === 0);
    const stop = (_e, cx) => cx.stop_propagation();
    const toggleTabs = (_e, cx) => {
      cx.stop_propagation();
      if (foldedTabs) this.collapsedTabs.delete(space.id);
      else this.collapsedTabs.add(space.id);
      localStorage.setItem(
        "spaces.collapsedTabs",
        JSON.stringify([...this.collapsedTabs]),
      );
      cx.notify();
    };
    const avatar = spaceAvatar(space.name, fill, isWt, isNestedWt);
    const hasUrgentStatus =
      space.status === "working" ||
      space.status === "blocked" ||
      space.status === "done";
    const collapsedStatus =
      foldedTabs && hasUrgentStatus
        ? this.tabStatus(themeColors, space.status)
        : null;

    const pill = v_flex()
      .id(`space-pill-${space.id}`)
      .relative()
      .flex_1()
      .min_w(0)
      .px(isNestedWt ? 6 : 8)
      .h(rowHeight({ tree }))
      .justify_center()
      .rounded(isNestedWt ? 7 : 8)
      .cursor_pointer()
      .when(highlightRow, (el) => el.bg(themeColors.selected))
      .when(!highlightRow, (el) => el.hover((s) => s.bg(themeColors.hover)))
      .when(this.pressed === space.id && this.over !== space.id, (el) => el.opacity(0.5))
      .when(dropHere, (el) => el.child(dropLine(fromIndex, i, themeColors)))
      .on_hover((isOn, cx) => {
        if (isOn) this.hoveredSpace = space.id;
        else if (this.hoveredSpace === space.id) this.hoveredSpace = null;
        cx.notify();
      })
      .on_mouse_down("left", () => {
        this.pressed = space.id;
        this.over = space.id;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed === null) return;
        const source = spaces().find((s) => s.id === this.pressed);
        const sameMachine = (source?.machine ?? null) === (space.machine ?? null);
        const over = source && sameMachine ? space.id : null;
        if (this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        this.pressedTab = null;
        this.overTab = null;
        if (from !== null && over === space.id && from !== space.id) {
          const index = spaces().findIndex((s) => s.id === space.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === space.id) {
          run("space.select", { id: space.id });
        }
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(space))
      .child(
        h_flex()
          .gap(isNestedWt ? 7 : 9)
          .items_center()
          .child(avatar)
          .child(
            div()
              .flex_initial()
              .min_w(SIDE_MIN)
              .truncate()
              .when(isNestedWt, (el) => el.text_size(12.5).font_medium())
              .when(isActive && !isNestedWt, (el) => el.font_medium())
              .text_color(
                isActive || !isNestedWt
                  ? themeColors.foreground
                  : themeColors.muted,
              )
              .child(space.name),
          )
          .child(
            gitInfo
              ? this.gitTail(gitInfo, tree, space.name, themeColors)
              : div().flex_1(),
          )
          .when(hovered, (el) =>
            el.child(
              div()
                .id(`space-new-tab-${space.id}`)
                .flex_none()
                .p(2)
                .rounded(4)
                .text_color(themeColors.dim)
                .tooltip("New tab")
                .hover((s) =>
                  s.bg(themeColors.hover).text_color(themeColors.foreground),
                )
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  run("tab.new", { space: space.id });
                })
                .child(svg("mods/workspace-chrome/plus.svg").size(11)),
            ),
          )
          .when(Boolean(collapsedStatus), (el) => el.child(collapsedStatus))
          .when(tabs.length > 0 && (hovered || foldedTabs), (el) =>
            el.child(
              h_flex()
                .id(`space-fold-${space.id}`)
                .flex_none()
                .px(2)
                .h(18)
                .gap(2)
                .rounded(4)
                .items_center()
                .text_size(10.5)
                .text_color(themeColors.dim)
                .hover((s) =>
                  s.bg(themeColors.hover).text_color(themeColors.foreground),
                )
                .on_mouse_down("left", stop)
                .on_click(toggleTabs)
                .when(foldedTabs, (c) => c.child(String(tabs.length)))
                .child(
                  svg(
                    `mods/workspace-chrome/chevron-${foldedTabs ? "right" : "down"}.svg`,
                  )
                    .size(11)
                    .flex_none(),
                ),
            ),
          ),
      );

    if (!isNestedWt) {
      return h_flex().id(`space-${space.id}`).flex_none().mt(2).items_center().child(pill);
    }
    return h_flex()
      .id(`space-${space.id}`)
      .flex_none()
      .pl(16)
      .h(rowHeight({ tree }) + 2)
      .items_center()
      .child(div().w(1).h_full().mr(8).flex_none().bg(themeColors.border))
      .child(h_flex().flex_1().min_w(0).pt(2).items_center().child(pill));
  }

  compact({ w: space, i }, themeColors) {
    return railCell(
      h_flex()
        .id(`space-${space.id}`)
        .relative()
        .w(RAIL_CELL)
        .h(26)
        .rounded(6)
        .justify_center()
        .items_center()
        .when(space.active, (el) => el.bg(themeColors.selected))
        .when(!space.active, (el) => el.hover((s) => s.bg(themeColors.hover)))
        .on_click(() => run("space.select", { id: space.id }))
        .child(
          div()
            .text_color(space.active ? themeColors.foreground : themeColors.muted)
            .child(String(i + 1)),
        )
        .child(
          div()
            .absolute()
            .right(5)
            .text_color(tone(themeColors, space.status))
            .child(glyph(space.status)),
        ),
    );
  }

  render() {
    const themeColors = theme();
    const collapsed = narrow();
    const allSpaces = spaces();
    const allPanes = panes();
    syncSpaceColors(allSpaces);
    const list = this.grouped(themeColors, collapsed, allSpaces, allPanes);

    // Scroll the active space or tab into view when it or its position changes.
    // A row already visible stays put.
    const activeSpace = allSpaces.find((space) => space.active);
    const activeTab = activeSpace?.tabs?.find((tab) => tab.active);
    const active = `${activeSpace?.id ?? ""}:${activeTab?.id ?? ""}`;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(themeColors.chrome)
      .text_size(13)
      .child(
        h_flex()
          .h(31)
          .pl(16)
          .pr(10)
          .items_center()
          .justify_between()
          .text_size(11.5)
          .text_color(themeColors.dim)
          .when(collapsed, (el) => el.pl(0).pr(0).justify_center())
          .when(!collapsed, (el) => el.child("Spaces"))
          .child(
            div()
              .id("space-new")
              .size(26)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .hover((s) =>
                s.bg(themeColors.hover).text_color(themeColors.foreground),
              )
              .on_click(() => run("space.new"))
              .child(svg("mods/workspace-chrome/plus.svg").size(14)),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .px(collapsed ? 0 : 8)
          .pb(14)
          .overflow_y_scrollbar()
          .mode("always")
          .track_scroll(this.scroll)
          // Another mod growing above, or the window resizing, can push the active row out.
          .on_size_change((_size, cx) => {
            if (this.activeAt >= 0) {
              this.scroll.scroll_to_item(this.activeAt);
              cx.notify();
            }
          })
          .on_mouse_up("left", (_e, cx) => {
            this.pressed = null;
            this.over = null;
            this.pressedTab = null;
            this.overTab = null;
            cx.notify();
          })
          .children(list),
      );
  }
}
