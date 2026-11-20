// Session resume: offers to resume agent conversations after a restart replaces their
// terminals with new shells. The mod renders nothing until it finds a lost conversation
// to resume, when it shows a "Resume N conversations" button. The mod registers
// Jetski today. Add other agent CLIs in `sessions.py` (`HARNESSES`) and `HARNESSES`
// below.
//
// Herdr runs a mod only where the active layout places it. Add this mod as a floating
// block so it stays hidden while empty (see README.md).
//
// State stored in `shared("session-resume.sessions")` on this computer:
//   { "<terminal address>": { harness, id, title, tab, pid, shell, cwd, cmd, gone? } }
//   - harness: registered CLI key (defaults to "jetski" on older stored entries)
//   - id, title: the resumable conversation ID and title
//   - tab: the tab ID where the conversation ran
//   - pid: the foreground agent PID that displayed the conversation
//   - shell: the terminal's shell PID then (a new PID means Herdr replaced the shell)
//   - cwd, cmd: the working folder and `argv[0]` of the agent process
//   - gone: timestamp (ms) when the terminal first disappeared, if currently missing
//
// When `mods/session-resume` is a symlink, Herdr does not watch edits through the link.
// Run `./plugin.sh reload session-resume` after editing a file.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  terminals,
  panes,
  hc,
  shared,
  setShared,
  notify,
  theme,
  nextCommand,
  checking,
} from "herdr";
import { Lookup, machineOf } from "./lookup.js";

const MOD = "session-resume";
const SESSIONS = "session-resume.sessions";

// Registered agent CLIs that this mod can resume.
// Each entry defines the default executable name and `resumeArgs(id)` returning
// CLI arguments (`resumeCommand` shell-quotes every argument).
// For example:
//   claude: { command: "claude", resumeArgs: (id) => ["--resume", id] }
//   codex: { command: "codex", resumeArgs: (id) => ["resume", id] }
const HARNESSES = {
  jetski: {
    command: "jetski",
    resumeArgs: (id) => ["--conversation", id],
  },
};

// Command that starts an agent CLI on each machine name ("" means this computer).
// A string sets the Jetski command for that machine. An object maps harness keys
// (such as `{ jetski: "jetski-cli", claude: "claude" }`) to machine commands.
// Unlisted harnesses reuse the original absolute executable path unless it is a
// temporary path or runtime interpreter. Otherwise, they run `HARNESSES[name].command`.
const LAUNCH = { "kvg-herdr": "jetski-cli" };

const FORGET_AFTER = 7 * 86400000;
const RESUME_GRACE = 30000;

const quote = (text) =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;

const isTemporaryPath = (path) =>
  /^\/(tmp|var\/tmp|private\/tmp|private\/var)\//.test(path);

const isInterpreterPath = (path) =>
  /\/(env|node(js)?|python(\d+(\.\d+)*)?|pypy(\d+(\.\d+)*)?|bun|deno|ruby|perl)$/i.test(
    path,
  );

const harnessOf = (entry) => entry?.harness || "jetski";
const sessionKey = (entry) => `${harnessOf(entry)}:${entry.id}`;

function selectLauncher(address, entry, harnessName) {
  const machineLaunch = LAUNCH[machineOf(address) ?? ""];
  if (typeof machineLaunch === "string") {
    if (harnessName === "jetski") return machineLaunch;
  } else if (machineLaunch?.[harnessName] != null) {
    return machineLaunch[harnessName];
  }

  if (
    entry.cmd?.startsWith("/") &&
    !isTemporaryPath(entry.cmd) &&
    !isInterpreterPath(entry.cmd)
  ) {
    return quote(entry.cmd);
  }
  return quote(HARNESSES[harnessName].command);
}

// Build the shell command that resumes a conversation in its working folder.
function resumeCommand(address, entry) {
  const harnessName = harnessOf(entry);
  const harness = HARNESSES[harnessName];
  if (!harness) {
    throw new Error(`Unsupported agent harness: ${harnessName}`);
  }
  const launcher = selectLauncher(address, entry, harnessName);
  const args = harness.resumeArgs(String(entry.id)).map((arg) => quote(String(arg)));
  const cdPrefix = entry.cwd ? `cd ${quote(entry.cwd)} && ` : "";
  return `${cdPrefix}${launcher}${args.length ? ` ${args.join(" ")}` : ""}`;
}

// Merge lookup results from each machine into persisted session state.
function merge(found) {
  const now = Date.now();
  const store = { ...(shared(SESSIONS) ?? {}) };
  const live = new Map(
    terminals()
      .filter((term) => term.state === "live")
      .map((term) => [term.address, term]),
  );
  const paneOf = new Map(
    panes()
      .filter((pane) => pane.terminal)
      .map((pane) => [pane.terminal, pane]),
  );

  let changed = false;
  for (const [address, session] of Object.entries(found)) {
    const terminal = live.get(address);
    // Skip results for a process that is no longer in the foreground.
    // The next lookup will inspect the new foreground process.
    if (!terminal || terminal.foreground?.pid !== session.pid) continue;

    const old = store[address];
    if (!session.id) {
      // The harness is running without an active conversation on screen.
      if (old?.pid === session.pid) {
        store[address] = { ...old, pid: 0 };
        changed = true;
      }
      continue;
    }

    const harness =
      session.harness ?? (old?.id === session.id ? old?.harness : null) ?? "jetski";
    const same = old?.id === session.id && harnessOf(old) === harness;
    const next = {
      harness,
      id: session.id,
      title: session.title || (same ? old.title : "") || "",
      tab: paneOf.get(address)?.tab ?? old?.tab ?? null,
      pid: session.pid,
      shell: terminal.pid ?? old?.shell ?? null,
      cwd: terminal.foreground?.cwd ?? terminal.cwd ?? null,
      cmd: terminal.foreground?.argv?.[0] ?? null,
    };
    if (!old || Object.keys(next).some((key) => next[key] !== old[key])) {
      store[address] = next;
      changed = true;
    }
  }

  // Keep missing terminals for FORGET_AFTER because a restart restores the same address.
  for (const [address, entry] of Object.entries(store)) {
    if (live.has(address)) {
      if (entry.gone) {
        const { gone, ...rest } = entry;
        store[address] = rest;
        changed = true;
      }
    } else if (!entry.gone) {
      store[address] = { ...entry, gone: now };
      changed = true;
    } else if (now - entry.gone > FORGET_AFTER) {
      delete store[address];
      changed = true;
    }
  }

  if (changed) setShared(SESSIONS, store);
}

export default class SessionResume extends View {
  init(_props, cx) {
    this.lookup = new Lookup(MOD);
    this.resuming = new Map(); // address -> timestamp when its resume command was sent
    if (checking()) return;

    cx.timer.every(1000, (cx) => {
      const now = Date.now();
      for (const [address, startedAt] of this.resuming) {
        if (now - startedAt > RESUME_GRACE) this.resuming.delete(address);
      }
      this.lookup.tick(cx, now, merge);
    });

    // Handle `session-resume.resume_all` from a keybinding or `herdr-app do`.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "resume_all") this.resume(this.lost(), cx);
        cx.notify();
      }
    });
  }

  // Return live pane shells whose terminal was lost and replaced with a new shell PID.
  lost() {
    const allPanes = panes();
    const allTerminals = terminals();
    const store = shared(SESSIONS) ?? {};
    const byAddress = new Map(allTerminals.map((term) => [term.address, term]));

    const running = new Set();
    for (const terminal of allTerminals) {
      const entry = store[terminal.address];
      if (entry?.id && entry.pid && entry.pid === terminal.foreground?.pid) {
        running.add(sessionKey(entry));
      }
    }

    const items = [];
    for (const pane of allPanes) {
      const address = pane.terminal;
      const entry = address ? store[address] : null;
      if (!entry?.id || !HARNESSES[harnessOf(entry)]) continue;
      if (!pane.program?.shell || entry.tab !== pane.tab) continue;
      if (running.has(sessionKey(entry)) || this.resuming.has(address)) continue;

      const terminal = byAddress.get(address);
      if (!terminal || terminal.state !== "live") continue;

      if (terminal.pid && entry.shell && terminal.pid !== entry.shell) {
        items.push({ address, entry });
      }
    }
    return items;
  }

  // Send each lost conversation's resume command to its shell.
  resume(items, cx) {
    const todo = items.filter((item) => !this.resuming.has(item.address));
    if (!todo.length) return;

    const now = Date.now();
    for (const item of todo) this.resuming.set(item.address, now);
    cx.notify();

    cx.spawn(async (cx) => {
      for (const item of todo) {
        let error = null;
        try {
          const command = resumeCommand(item.address, item.entry);
          const result = await hc(["send", item.address, command]);
          if (result.code !== 0) {
            error = (result.stderr || result.stdout || "hc send failed").trim();
          }
        } catch (err) {
          error = String(err);
        }

        if (error) {
          this.resuming.delete(item.address);
          const label = item.entry.title || item.entry.id;
          notify({
            title: "Couldn't resume",
            body: `${label}: ${error}`.slice(0, 200),
            level: "error",
          });
        }
      }

      // Poll again shortly after the agent starts so stored PIDs update promptly.
      this.lookup.lookSoon(3000);
      cx.notify();
    });
  }

  render() {
    const lost = this.lost();
    // Herdr hides a floating block when its rendered element is empty.
    if (!lost.length) return div();

    const colors = theme();
    const titles = lost.map((item) => item.entry.title || "untitled").join(", ");
    const label =
      lost.length === 1
        ? "Resume 1 conversation"
        : `Resume ${lost.length} conversations`;

    return h_flex()
      .id("resume-all")
      .h(28)
      .px(10)
      .gap(7)
      .items_center()
      .whitespace_nowrap()
      .text_size(12.5)
      .font_medium()
      .text_color(colors.accent)
      .cursor_pointer()
      .hover((style) => style.bg(colors.hover))
      .tooltip(`Resume: ${titles}`.slice(0, 300))
      .on_click((_event, cx) => this.resume(lost, cx))
      .child(svg("mods/session-resume/resume.svg").size(11).flex_none())
      .child(label);
  }
}
