# Report which agent conversation each terminal displays, along with its title.
#
# Both session-rename and session-resume run this script on each machine via
# `python3 -c <script> <json>`. Keep both copies in sync so each mod works standalone.
#
# Input (argv[1]):
#   {
#     "<address>": {
#       "pid": <int>, "program": <str|null>, "argv": <list|null>,
#       "cwd": <str|null>, "app": <str|null>, "title": <str|null>
#     }
#   }
#   (Also accepts legacy {"<address>": <int pid>} entries.)
# Output (stdout):
#   {"<address>": {"harness": "<name>", "id": "<id>" | null, "title": "..."}, ...}
#   Terminals whose foreground process matches no registered harness are omitted.
#   A null ID can still carry a title. Resolvers may also supply home, target, and cwd for recovery.
#
# Requires Python 3.9+ and uses only the standard library.

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

UUID = rb"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# Jetski log entries that name the active conversation. Before the first message,
# the conversation ID is empty.
JETSKI_SHOWN = re.compile(
    rb"(?:Streaming conversation"
    rb"|\(RerenderAll\) for conversation"
    rb"|user message to conversation) ("
    + UUID
    + rb")?[ \r\n(]"
)
JETSKI_LOG = re.compile(r"/cli/log/[^/]+\.log$")
CHUNK = 512 * 1024
OVERLAP = 512
MAX_SCAN = 64 * 1024 * 1024


def open_files_linux(pids):
    """Map each PID to its open files, as `{path: opened for writing}`."""
    files_by_pid = {}
    for pid in pids:
        base = f"/proc/{pid}/fd"
        try:
            names = os.listdir(base)
        except OSError:
            continue

        files = {}
        for name in names:
            try:
                target = os.readlink(os.path.join(base, name))
            except OSError:
                continue
            if not target.startswith("/"):
                continue
            files[target] = files.get(target, False) or fd_writes_linux(pid, name)
        files_by_pid[pid] = files

    return files_by_pid


def fd_writes_linux(pid, fd):
    """Return whether a process opened a file descriptor for writing."""
    try:
        with open(f"/proc/{pid}/fdinfo/{fd}") as info:
            for line in info:
                if line.startswith("flags:"):
                    return int(line.split()[1], 8) & os.O_ACCMODE != os.O_RDONLY
    except (OSError, ValueError, IndexError):
        pass
    return False


def open_files_lsof(pids):
    """Map each PID to its open files, as `{path: opened for writing}`."""
    if not pids:
        return {}

    pid_arg = ",".join(str(pid) for pid in pids)
    output = b""
    for tool in ("lsof", "/usr/sbin/lsof"):
        try:
            output = subprocess.run(
                [tool, "-n", "-P", "-p", pid_arg, "-Fan"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=8,
            ).stdout
            break
        except OSError:
            continue
        except subprocess.SubprocessError:
            return {}

    # `lsof -F` prints one field per line. A `p` line starts a process, an `f` line
    # starts a file, `a` holds its access mode, and `n` holds its name.
    files_by_pid = {}
    files = None
    writes = False
    for line in output.decode("utf-8", "replace").splitlines():
        field, value = line[:1], line[1:]
        if field == "p":
            try:
                files = files_by_pid.setdefault(int(value), {})
            except ValueError:
                files = None
        elif field == "f":
            writes = False
        elif field == "a":
            writes = value in ("w", "u")
        elif field == "n" and files is not None and value.startswith("/"):
            files[value] = files.get(value, False) or writes

    return files_by_pid


def open_db(db_path):
    """Open a SQLite database in read-only mode.

    WAL-mode databases without `-wal` or `-shm` files beside them fail a standard
    read-only open because SQLite cannot create `-shm`. Because the database file is
    complete on its own in that state, fall back to `immutable=1`.
    """
    normalized = "/" + db_path.lstrip("/") if db_path.startswith("//") else db_path
    escaped = normalized.replace("%", "%25").replace("?", "%3f").replace("#", "%23")
    con = None
    try:
        con = sqlite3.connect(f"file:{escaped}?mode=ro", uri=True, timeout=2)
        con.execute("SELECT 1 FROM sqlite_master LIMIT 1")
        return con
    except sqlite3.Error:
        if con is not None:
            con.close()
        if os.path.exists(f"{db_path}-wal") or os.path.exists(f"{db_path}-shm"):
            raise
        return sqlite3.connect(
            f"file:{escaped}?mode=ro&immutable=1", uri=True, timeout=2
        )


def get_db(db_path, db_cache):
    """Return a cached read-only SQLite connection owned by `db_cache`, or None."""
    if db_path not in db_cache:
        try:
            db_cache[db_path] = open_db(db_path)
        except sqlite3.Error:
            db_cache[db_path] = None
    return db_cache[db_path]


def jetski_shown_conversation(log_path):
    """Return the last conversation ID shown in a Jetski log, or None if none is active."""
    try:
        size = os.path.getsize(log_path)
        with open(log_path, "rb") as log_file:
            end = size
            scanned = 0
            while end > 0 and scanned < MAX_SCAN:
                start = max(0, end - CHUNK)
                log_file.seek(start)
                data = log_file.read(min(size, end + OVERLAP) - start)
                scanned += len(data)

                last = None
                for match in JETSKI_SHOWN.finditer(data):
                    last = match
                if last is not None:
                    cid = last.group(1)
                    return cid.decode() if cid else None

                end = start
    except OSError:
        return None

    return None


def jetski_describe(db_path, cid, db_cache):
    """Resolve a Jetski conversation ID to its root conversation ID and title."""
    con = get_db(db_path, db_cache)
    if con is None:
        return cid, ""

    try:
        query = """
            SELECT title, parent_conversation_id
            FROM conversation_summaries
            WHERE conversation_id = ?
        """
        title = ""
        for _ in range(8):
            row = con.execute(query, (cid,)).fetchone()
            if row is None:
                break
            title = row[0] or ""
            parent_id = row[1]
            if not parent_id:
                break
            cid = parent_id

        return cid, title
    except sqlite3.Error:
        # Keep the conversation ID when the database is locked or unreadable.
        # A later lookup can read the title.
        return cid, ""


def resolve_jetski(proc, db_cache):
    """Detect a Jetski CLI process from its open log file and resolve its session.

    Jetski writes its log. A program that only reads the log, such as `tail`, is not
    Jetski.
    """
    log_path = next((path for path in proc["written"] if JETSKI_LOG.search(path)), None)
    if not log_path:
        return None

    cid = jetski_shown_conversation(log_path)
    if not cid:
        return {"harness": "jetski", "id": None, "title": ""}

    app_dir = log_path[: log_path.rindex("/cli/log/")]
    db_path = os.path.join(app_dir, "conversation_summaries.db")
    root_id, title = jetski_describe(db_path, cid, db_cache)
    return {"harness": "jetski", "id": root_id, "title": title}


def json_file(path):
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def json_lines(path):
    """Read recent metadata from append-only files, tolerating partial writes."""
    try:
        with path.open("rb") as f:
            size = f.seek(0, os.SEEK_END)
            start = max(0, size - 2 * CHUNK)
            f.seek(start)
            if start:
                f.readline()
            for line in reversed(f.read(2 * CHUNK).splitlines()):
                try:
                    data = json.loads(line)
                    if isinstance(data, dict):
                        yield data
                except ValueError:
                    continue
    except OSError:
        return


def process(pid):
    # lstart protects records against PID reuse. LC_ALL makes the value consistent
    # between the provider's shell and the remote lookup.
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "ppid=", "-o", "lstart=", "-o", "comm="],
            capture_output=True, text=True, timeout=2, env={**os.environ, "LC_ALL": "C"},
        )
        parent, *rest = result.stdout.strip().split(maxsplit=6)
        if len(rest) == 6:
            return int(parent), " ".join(rest[:5]), Path(rest[5]).name
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def report_path(pid):
    return Path.home() / ".cache" / "herdr-mods" / "sessions" / ("%d.json" % pid)


def result(provider, cid, title="", **metadata):
    title = " ".join(title.split())[:200] if isinstance(title, str) else ""
    return {"harness": provider, "id": cid, "title": title, **metadata}


def report_claude():
    data = json.load(sys.stdin)
    pid = os.getppid()
    while pid > 1:
        owner = process(pid)
        if owner is None:
            return
        parent, started, name = owner
        if name == "claude":
            break
        pid = parent
    else:
        return

    cid = data.get("session_id")
    if cid is not None and not isinstance(cid, str):
        return
    transcript = data.get("transcript_path")
    home = os.environ.get("CLAUDE_CONFIG_DIR")
    if home:
        home = str(Path(home).expanduser().resolve())
    cwd = data.get("cwd")
    record = result("claude", cid, data.get("title"), started=started,
                    transcript=transcript, home=home,
                    cwd=cwd if isinstance(cwd, str) and Path(cwd).is_absolute() else None)
    target = report_path(pid)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as f:
        json.dump(record, f)
    os.replace(f.name, target)


def process_env(pid, key):
    prefix = key.encode() + b"="
    try:
        for value in Path("/proc/%d/environ" % pid).read_bytes().split(b"\0"):
            if value.startswith(prefix):
                return os.fsdecode(value[len(prefix):])
    except OSError:
        pass
    return ""


def resolve_codex(proc, db_cache):
    if proc["app"] != "codex" and Path(proc["program"] or "").name.lower() != "codex":
        return None
    pid, title, cwd = proc["pid"], proc["title"], proc["cwd"]
    if not isinstance(title, str) or not isinstance(cwd, str):
        return None
    title = re.sub(r"^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\[ [!.] \] Action Required) ", "", title)
    name, separator, project = title.rpartition(" | ")
    if not separator or not name or not project or not Path(cwd).is_absolute():
        return result("codex", None)

    # The TUI can share an app server. Match its published name in its own
    # working directory and reject duplicates rather than choosing by recency.
    custom_home = process_env(pid, "CODEX_HOME")
    home = (Path(cwd) / custom_home).resolve() if custom_home else Path.home() / ".codex"
    databases = (p for p in home.glob("state_*.sqlite") if p.stem[6:].isdigit())
    path = max(databases, key=lambda p: int(p.stem[6:]), default=None)
    db = get_db(str(path), db_cache) if path else None
    if db is None:
        return result("codex", None, name)
    try:
        rows = db.execute(
            "SELECT id FROM threads WHERE cwd = ? AND name = ? COLLATE BINARY LIMIT 2",
            (cwd, name),
        ).fetchall()
    except sqlite3.Error:
        return result("codex", None, name)
    cid = rows[0][0] if len(rows) == 1 else None
    return result("codex", cid, name, home=str(home), cwd=cwd)


def resolve_pi(proc, _db_cache):
    if proc["app"] != "pi" and Path(proc["program"] or "").name.lower() != "pi":
        return None
    pid, title, cwd = proc["pid"], proc["title"], proc["cwd"]
    if not isinstance(title, str) or not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return result("pi", None)
    project = Path(cwd).name or cwd
    prefix, suffix = "π - ", " - " + project
    if not title.startswith(prefix) or not title.endswith(suffix):
        return result("pi", None)
    name = title[len(prefix):-len(suffix)]
    if not name:
        return result("pi", None)

    argv = proc["argv"]
    if "--no-session" in argv:
        return result("pi", None, name)
    agent_dir = process_env(pid, "PI_CODING_AGENT_DIR") or str(Path.home() / ".pi/agent")
    custom_dir = process_env(pid, "PI_CODING_AGENT_SESSION_DIR")
    for index, arg in enumerate(argv):
        if arg == "--session-dir" and index + 1 < len(argv):
            custom_dir = argv[index + 1]
        elif arg.startswith("--session-dir="):
            custom_dir = arg.split("=", 1)[1]
    if custom_dir:
        directory = Path(cwd) / Path(custom_dir).expanduser()
    else:
        encoded_cwd = re.sub(r"[/\\:]", "-", cwd.removeprefix("/"))
        directory = Path(cwd) / Path(agent_dir).expanduser() / "sessions" / ("--" + encoded_cwd + "--")

    # Opening a file directly makes Pi use that file's parent for session
    # switches. A title alone cannot link it to our configured directory.
    for index, arg in enumerate(argv):
        if arg == "--session" and index + 1 < len(argv):
            target = argv[index + 1]
        elif arg.startswith("--session="):
            target = arg.split("=", 1)[1]
        else:
            continue
        path = Path(cwd) / Path(target).expanduser()
        if path.suffix != ".jsonl" or path.resolve().parent != directory.resolve():
            return result("pi", None, name)

    match = None
    try:
        for path in directory.glob("*.jsonl"):
            with path.open("rb") as file:
                header = json.loads(file.readline())
                if not isinstance(header, dict) or header.get("type") != "session":
                    return result("pi", None, name)
                if header.get("cwd") != cwd:
                    continue
                cid = header.get("id")
                saved_name = None
                for line in file:
                    if b'"session_info"' in line:
                        try:
                            entry = json.loads(line)
                        except ValueError:
                            return result("pi", None, name)
                        if not isinstance(entry, dict):
                            return result("pi", None, name)
                        if entry.get("type") == "session_info":
                            saved_name = entry.get("name")
            if not isinstance(cid, str) or saved_name != name:
                continue
            if match is not None:
                return result("pi", None, name)
            match = result("pi", cid, name, target=str(path), cwd=cwd)
    except (OSError, ValueError):
        # An unreadable file could contain a duplicate name.
        return result("pi", None, name)
    return match or result("pi", None, name)


def claude_title(transcript, cid):
    if not isinstance(transcript, str) or not Path(transcript).is_absolute():
        return ""
    generated = ""
    for row in json_lines(Path(transcript)):
        if row.get("sessionId") not in (None, cid):
            continue
        if row.get("type") == "custom-title" and row.get("customTitle"):
            return row["customTitle"]
        if not generated and row.get("type") == "ai-title":
            generated = row.get("aiTitle") or ""
    return generated


def resolve_report(proc, _db_cache):
    pid = proc["pid"]
    data = json_file(report_path(pid))
    if not data:
        return None
    owner = process(pid)
    if owner is None or owner[1] != data.get("started"):
        return None

    provider, cid = data.get("harness", data.get("provider")), data.get("id")
    home, transcript, cwd = data.get("home"), data.get("transcript"), data.get("cwd")
    if provider != "claude":
        return None
    if cid:
        return result("claude", cid, claude_title(transcript, cid), home=home, cwd=cwd)
    return result("claude", None)


def fast_agent(path, pid):
    lock = Path(path)
    match = re.fullmatch(r"([A-Za-z0-9_-]+)-([0-9a-f]{12})\.owner\.lock", lock.name)
    if lock.parent.name != ".locks" or match is None:
        return None
    cid, digest = match.groups()
    if hashlib.sha256(cid.encode()).hexdigest()[:12] != digest:
        return None
    owner = json_file(lock.with_suffix(".json"))
    if owner.get("pid") != pid:
        return None
    sessions = lock.parent.parent
    data = json_file(sessions / cid / "session.json")
    if not data:
        return None
    metadata = data.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    title = metadata.get("title") or metadata.get("label") or metadata.get("last_user_prompt")
    return result("fast-agent", cid, title, home=str(sessions.parent))


def resolve_fast_agent(proc, _db_cache):
    sessions = [
        session for path in proc["written"] if path.endswith(".owner.lock")
        if (session := fast_agent(path, proc["pid"])) is not None
    ]
    return sessions[0] if len(sessions) == 1 else None


# Ordered list of harness resolvers. Each resolver receives `proc` and `db_cache`
# (for `get_db()`). `proc` holds `pid`, `program`, `argv`, `cwd`, the paths of its
# open `files`, and the subset `written` that it opened for writing. A resolver
# returns either `None` (not this harness) or
# `{"harness": "<name>", "id": <str | None>, "title": <str>}`.
#
# The callers send every foreground program that is not a shell, so a resolver must
# return `None` unless it is sure that the process is its agent CLI.
HARNESSES = [
    resolve_report,
    resolve_codex,
    resolve_pi,
    resolve_fast_agent,
    resolve_jetski,
]


def parse_pid(value):
    if not value or isinstance(value, bool):
        return 0
    try:
        pid = int(value)
    except (TypeError, ValueError):
        return 0
    return pid if pid > 0 else 0


def normalize_request(raw):
    if not isinstance(raw, dict):
        return {}

    processes = {}
    for address, info in raw.items():
        if isinstance(info, dict):
            pid = parse_pid(info.get("pid"))
            if not pid:
                continue
            raw_argv = info.get("argv")
            argv = [str(arg) for arg in raw_argv] if isinstance(raw_argv, list) else []
            program = info.get("program")
            cwd = info.get("cwd")
            processes[address] = {
                "pid": pid,
                "program": program if isinstance(program, str) else None,
                "argv": argv,
                "cwd": cwd if isinstance(cwd, str) else None,
                "app": info.get("app"),
                "title": info.get("title"),
            }
            continue

        pid = parse_pid(info)
        if pid:
            processes[address] = {
                "pid": pid,
                "program": None,
                "argv": [],
                "cwd": None,
                "app": None,
                "title": None,
            }

    return processes


def main():
    raw = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    processes = normalize_request(raw)
    pids = sorted({proc["pid"] for proc in processes.values()})
    files_by_pid = (
        open_files_linux(pids)
        if os.path.isdir("/proc/self/fd")
        else open_files_lsof(pids)
    )

    results = {}
    db_cache = {}
    try:
        for address, proc in processes.items():
            files = files_by_pid.get(proc["pid"], {})
            written = [path for path, writes in files.items() if writes]
            proc_with_files = {**proc, "files": list(files), "written": written}
            for resolve in HARNESSES:
                session = resolve(proc_with_files, db_cache)
                if session is not None:
                    results[address] = session
                    break
    finally:
        for con in db_cache.values():
            if con is not None:
                con.close()

    sys.stdout.write(json.dumps(results))


if __name__ == "__main__":
    if sys.argv[1:] == ["--report", "claude"]:
        report_claude()
    else:
        main()
