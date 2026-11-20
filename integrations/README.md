# Session reporting for coding agents

`session-rename` and `session-resume` share the same detection code. For Claude Code,
set up the reporter on each machine where the agent runs. Either mod's `sessions.py`
works as the reporter. Use an absolute path to the installed copy on that
machine. The reporter stores session metadata in
`~/.cache/herdr-mods/sessions`, keyed by process ID and checked against the
process start time.

## Codex

The mods read the terminal title Codex publishes by default. No Codex hook
or configuration change is required. The title must include both the thread
name and the project name. Recovery requires a unique thread with that name
in the terminal's working directory. Ambiguous matches can still name the
tab. On Linux the mods use the process's `CODEX_HOME` if set. On other
platforms they look in `~/.codex`.

## Claude Code

Add this entry to the `hooks` object's `SessionStart` array. Merge it into
existing hooks in `~/.claude/settings.json`.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 '/absolute/path/to/session-rename/sessions.py' --report claude"
          }
        ]
      }
    ]
  }
}
```

Claude Code titles come from title entries in the session transcript.
A title can appear after the session ID is available for recovery.

## Pi

The mods read the session name from Pi's default terminal title. No
extension is required. Recovery requires one saved session with that name
in the session directory for that working directory. An explicit session
file must belong to that directory for name-based recovery. Duplicate
names and ephemeral sessions can
still name the tab.

For exact recovery when names are ambiguous or a session file lives outside
the configured session directory, you can optionally load
[pi-session.js](pi-session.js). Copy it into `~/.pi/agent/extensions/` or
run `pi -e /absolute/path/to/pi-session.js`. On a remote machine without the
Herdr app, set `HERDR_SESSION_LOOKUP` to the path of either mod's
`sessions.py` on that machine.

## fast-agent and Jetski

Both are detected automatically from their open files. The fast-agent
adapter uses the session owner lock and requires a version that exposes
that lock (verified against 0.10.60). Resume uses `fast-agent go` with the
recorded session home and ID. If you use a custom launcher or need other
startup options, configure the launcher executable for that machine and
provider in `session-resume/main.js`.
