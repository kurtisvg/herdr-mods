// Session rename: renames each tab after the agent conversation running in it.
// This mod draws nothing.
//
// A title comes from one of two sources:
//   - The terminal's status report (OSC 7501), which this file reads every second.
//     `REPORT_TITLE` says, per agent CLI, how to take the title from a report.
//   - `sessions.py`, which `lookup.js` runs on each machine every 15 seconds. It
//     also supplies the conversation ID, and it is the only source for a terminal
//     whose report carries no title.
//
// A mod runs only where a layout places it. Place this mod as a floating block,
// which stays hidden while its view renders nothing (see README.md).
//
// Shared state on this computer under shared("session-rename.sessions"):
//   { "<terminal address>": {
//       harness, id, title, applied, pid, reported, resolved, gone?
//   } }
//   - harness: agent CLI identifier (defaults to "jetski" for older stored entries)
//   - id: active conversation ID, or null until `sessions.py` supplies it
//   - title: conversation title, kept while the report carries none
//   - applied: last title that this mod applied to the tab
//   - pid: foreground agent PID that showed the conversation
//   - reported: last title that the report gave for this conversation, or null
//   - resolved: last title that `sessions.py` gave for this conversation, or null
//   - gone: timestamp (ms) when the terminal was first seen missing
//
// When Herdr's mods/session-rename is a symlink to this folder, Herdr does not
// detect edits behind the link automatically. Run `./plugin.sh reload session-rename`
// after changing a file.

import { View, div } from "gpui-kit";
import { terminals, panes, spaces, run, shared, setShared, checking } from "herdr";
import { Lookup } from "./lookup.js";

const MOD = "session-rename";
const SESSIONS = "session-rename.sessions";
const FORGET_AFTER = 7 * 86400000;

// The default reader for a status report. It suits an agent CLI that puts the
// conversation title in `msg` while it works. In the other states `msg` holds
// other text, such as the agent's final reply, so the reader returns nothing.
const titleWhileWorking = (report) => (report.state === "working" ? report.msg : null);

// How to take the conversation title from a status report, keyed by the report's
// `app`. This mod ignores reports from an app that has no entry.
//   - harness: the name that the CLI's resolver in `sessions.py` returns. The agent
//     CLI chooses its `app` value, so the two names can differ.
//   - read: a reader that returns the title, or nothing when the report carries
//     no title. It must return the same text as the resolver in `sessions.py`.
//
// To add another status-report reader, first read `terminals()[i].report`
// while the CLI runs. Check its `app` value, which field holds the conversation
// title, and in which states. Then add an entry here. Use `titleWhileWorking`
// when it fits. Otherwise write a reader.
const REPORT_TITLE = new Map([
  ["jetski", { harness: "jetski", read: titleWhileWorking }],
  ["pi", { harness: "pi", read: (report) =>
    ["working", "done"].includes(report.state) ? report.msg : null }],
  ["fast-agent", { harness: "fast-agent", read: (report) => report.title }],
]);

// Returns the harness and the title that a terminal's status report carries now.
// Returns null when the report carries no title.
function reported(term) {
  const source = REPORT_TITLE.get(term.report?.app);
  const title = source?.read(term.report);
  if (typeof title !== "string" || !title.trim()) return null;
  return { harness: source.harness, title: title.trim() };
}

// Updates the stored session entries from the status reports and from the
// results of `sessions.py` in `found`. Returns the updated map.
//
// The two sources can disagree, and a script result can be several seconds old.
// These rules give the report priority and keep a tab name stable:
//   - Each source changes the title only when its own title changes. A source
//     that repeats a title does not undo a newer title from the other source.
//   - The first script title for a conversation that the report already named
//     changes nothing. Later changes of the script title count, which covers a
//     `/rename` while the agent is idle.
//   - While the report carries a title, a different script title waits.
//   - `applied` survives until the title changes or `sessions.py` finds a
//     different conversation ID. An ID that arrives after the report's title
//     therefore does not rename a tab that the user named.
function update(found) {
  const now = Date.now();
  const store = { ...(shared(SESSIONS) ?? {}) };
  const live = new Map(
    terminals()
      .filter((term) => term.state === "live")
      .map((term) => [term.address, term]),
  );
  let changed = false;

  for (const [address, term] of live) {
    const titled = reported(term);
    const pid = term.foreground?.pid;
    const old = store[address];
    if (!titled || !pid) continue;
    if (old?.pid === pid && old.reported === titled.title) continue;

    const sameTitle =
      old?.title === titled.title && (old.harness ?? old.provider ?? "jetski") === titled.harness;
    store[address] = {
      harness: titled.harness,
      // A new title can belong to another conversation, so the ID is unknown.
      id: sameTitle ? old.id ?? null : null,
      title: titled.title,
      applied: sameTitle ? old.applied ?? null : null,
      pid,
      reported: titled.title,
      resolved: sameTitle ? old.resolved ?? null : null,
    };
    changed = true;
  }

  for (const [address, session] of Object.entries(found)) {
    const term = live.get(address);
    // Ignore results from a process that is no longer in the foreground.
    if (!term || term.foreground?.pid !== session.pid) continue;

    const old = store[address];
    const titled = reported(term);
    if (!session.id && !session.title) {
      // The agent CLI is running without an active conversation on screen.
      if (old?.pid === session.pid && !titled) {
        store[address] = { ...old, pid: 0 };
        changed = true;
      }
      continue;
    }

    const harness = session.harness ?? "jetski";
    // An entry without an ID came from a report. The first ID that `sessions.py`
    // finds for the same process completes it.
    const sameConversation =
      old != null &&
      (old.harness ?? old.provider ?? "jetski") === harness &&
      (session.id
        ? old.id === session.id || (old.id == null && old.pid === session.pid)
        : old.pid === session.pid && old.title === session.title);
    let title = sameConversation ? old.title : "";
    let resolved = sameConversation ? old.resolved ?? null : null;

    const scriptTitle = session.title.trim();
    const isNews = scriptTitle !== "" && scriptTitle !== resolved;
    const mustWait =
      resolved !== null && titled !== null && titled.title !== scriptTitle;
    if (isNews && !mustWait) {
      if (!title || resolved !== null) title = scriptTitle;
      resolved = scriptTitle;
    }

    const next = {
      harness,
      id: session.id,
      title,
      applied: sameConversation ? old.applied ?? null : null,
      pid: session.pid,
      reported: sameConversation ? old.reported ?? null : null,
      resolved,
    };
    if (!old || Object.keys(next).some((key) => next[key] !== old[key])) {
      store[address] = next;
      changed = true;
    }
  }

  // Keep missing terminals for 7 days. Terminals return at the same address after
  // a restart, which preserves manual tab names for an unchanged conversation.
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
  return store;
}

// Applies each conversation's title to its tab when the title is new or updated,
// or when the tab has no custom name. A manual tab name stays until the terminal
// shows a new conversation title. In a tab with multiple panes, the first pane
// with a titled foreground conversation sets the tab's name.
function renameTabs(store) {
  const front = new Map(
    terminals().map((term) => [term.address, term.foreground?.pid]),
  );
  const tabs = new Map(
    spaces()
      .flatMap((space) => space.tabs ?? [])
      .map((tab) => [tab.id, tab]),
  );
  const named = new Set();
  const next = { ...store };
  let changed = false;

  for (const pane of panes()) {
    const entry = pane.terminal ? store[pane.terminal] : null;
    if (
      !entry?.title ||
      !entry.pid ||
      entry.pid !== front.get(pane.terminal) ||
      named.has(pane.tab)
    ) {
      continue;
    }
    named.add(pane.tab);

    const tab = tabs.get(pane.tab);
    if (!tab) continue;

    if (tab.name !== entry.title) {
      if (entry.applied === entry.title && tab.named) continue;
      run("tab.rename", { id: tab.id, name: entry.title });
    }
    if (entry.applied !== entry.title) {
      next[pane.terminal] = { ...entry, applied: entry.title };
      changed = true;
    }
  }

  if (changed) setShared(SESSIONS, next);
}

export default class SessionRename extends View {
  init(_props, cx) {
    this.lookup = new Lookup(MOD);
    if (checking()) return;

    cx.timer.every(1000, (cx) => {
      // Read the status reports on every tick, so that a tab gets its name as
      // soon as the report carries the title. No script results arrive here.
      renameTabs(update({}));
      this.lookup.tick(cx, Date.now(), (found) => renameTabs(update(found)));
    });
  }

  // Render an empty element so the floating block stays hidden.
  render() {
    return div();
  }
}
