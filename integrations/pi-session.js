// Load this extension with Pi's -e option or copy it to the Pi extensions directory.
// Set HERDR_SESSION_LOOKUP to the absolute path of either mod's sessions.py.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi) {
  const mods = join(process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app"), "mods");
  const lookup = process.env.HERDR_SESSION_LOOKUP
    ?? ["session-rename", "session-resume"].map((mod) => join(mods, mod, "sessions.py")).find(existsSync);
  if (!lookup) return;

  const publish = (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const session = ctx.sessionManager;
    spawnSync("python3", [lookup, "--report", "pi"], {
      input: JSON.stringify({
        session_id: session.getSessionId(),
        transcript_path: session.getSessionFile(),
        title: session.getSessionName(),
        cwd: session.getCwd(),
      }),
      timeout: 2000,
      stdio: ["pipe", "ignore", "ignore"],
    });
  };
  pi.on("session_start", publish);
  pi.on("session_info_changed", publish);
  pi.on("agent_end", publish);
}
