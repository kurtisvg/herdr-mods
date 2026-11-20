// Lookup polls the programs that run in terminals to find which agent conversation
// each one displays.
//
// Both session-rename and session-resume keep a copy of this file so each mod
// works standalone. When you install both mods, each mod runs its own lookup.
// Keep both copies in sync when editing this file.

import { panes, terminals, exec, readTextFile, appHome, window } from "herdr";

const stableTitle = (title) => title?.replace(
  /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\[ [!.] \] Action Required) /u,
  "",
) ?? null;

const ACTIVE_EVERY = 15000; // polling interval while the Herdr window is active
const IDLE_EVERY = 60000; // polling interval while the Herdr window is inactive

// Returns whether a terminal's foreground program can be an agent CLI. Herdr marks
// a terminal as an agent only while its program sends a status report, and an agent
// CLI can disable its report. So every program that is not a shell is a candidate,
// and the resolvers in `sessions.py` decide which candidates are agent CLIs.
const tracked = (term) => term.state === "live" && !term.program?.shell;

export const machineOf = (address) =>
  address.includes("/") ? address.split("/")[0] : null;

export class Lookup {
  // `mod` names this mod's folder under Herdr's `mods/` directory, where
  // `sessions.py` lives.
  constructor(mod) {
    this.mod = mod;
    this.busy = false;
    this.last = 0;
    this.soon = 0;
    this.key = null;
    this.script = null;
  }

  // Schedule the next lookup after `ms` milliseconds, overriding the normal interval.
  lookSoon(ms) {
    this.soon = Date.now() + ms;
  }

  // Call once per second. This method schedules a quick lookup when agent terminals
  // start, exit, or change status. Other tracked programs do not schedule one, so a
  // terminal that runs many short commands causes no extra lookups. Otherwise, this
  // method polls on the active or idle interval.
  // It passes `{ "<terminal address>": { harness, id, title, pid } }` to `use()`, with
  // `id: null` when a supported harness displays no active conversation.
  tick(cx, now, use) {
    const key = terminals()
      .filter((term) => term.state === "live" && term.program?.agent)
      .map((term) => `${term.address}:${term.foreground?.pid}:${term.status}`)
      .join(",");
    if (key !== this.key) {
      this.key = key;
      this.soon = now + 1200;
    }

    const interval = window()?.active ? ACTIVE_EVERY : IDLE_EVERY;
    const due = (this.soon && now >= this.soon) || now - this.last >= interval;
    if (!due || this.busy) return;

    this.soon = 0;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const found = await this.find();
        if (found) use(found);
      } catch (err) {
        console.log(`${this.mod}: lookup failed`, String(err));
      } finally {
        this.busy = false;
        this.last = Date.now();
        cx.notify();
      }
    });
  }

  // Run `sessions.py` on each machine that has a tracked terminal.
  // Returns null when Herdr cannot read `sessions.py`.
  async find() {
    this.script ??= await readTextFile(`${appHome()}/mods/${this.mod}/sessions.py`);
    if (!this.script) return null;

    const byMachine = new Map(); // machine -> { address: { pid, program, argv, cwd } }
    const paneTitles = new Map(panes().map((pane) => [pane.terminal, pane.title]));
    for (const terminal of terminals()) {
      const foregroundPid = terminal.foreground?.pid;
      if (!tracked(terminal) || !foregroundPid) continue;
      const machine = machineOf(terminal.address);
      if (!byMachine.has(machine)) byMachine.set(machine, {});
      byMachine.get(machine)[terminal.address] = {
        pid: foregroundPid,
        program: terminal.foreground?.name ?? terminal.program?.name ?? null,
        app: terminal.report?.app ?? null,
        title: terminal.title || paneTitles.get(terminal.address) || null,
        argv: terminal.foreground?.argv ?? null,
        cwd: terminal.foreground?.cwd ?? terminal.cwd ?? null,
      };
    }

    const found = {};
    await Promise.all(
      [...byMachine].map(async ([machine, processes]) => {
        try {
          const result = await exec(
            "python3",
            ["-c", this.script, JSON.stringify(processes)],
            { on: machine, timeout: 20000 },
          );
          if (result.code !== 0) {
            console.log(`${this.mod}:`, machine ?? "local", result.stderr.slice(-300));
            return;
          }
          const parsed = JSON.parse(result.stdout);
          for (const [address, session] of Object.entries(parsed)) {
            const pid = processes[address]?.pid;
            if (!pid) continue;
            found[address] = {
              harness: session.harness ?? "jetski",
              id: session.id ?? null,
              title: session.title ?? "",
              pid,
              terminalTitle: processes[address].title,
              home: session.home ?? null,
              target: session.target ?? null,
              cwd: session.cwd ?? null,
            };
          }
        } catch (_err) {
          // Ignore unreachable machines so existing state stays intact.
        }
      }),
    );
    const currentTitles = new Map(panes().map((pane) => [pane.terminal, pane.title]));
    for (const terminal of terminals()) {
      const session = found[terminal.address];
      if (!session || (session.harness !== "codex" && session.harness !== "pi")) continue;
      const title = terminal.title || currentTitles.get(terminal.address) || null;
      if (stableTitle(title) !== stableTitle(session.terminalTitle)) {
        delete found[terminal.address];
        this.lookSoon(1200);
      }
    }
    return found;
  }
}
