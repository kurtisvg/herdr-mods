# Report which agent conversation each terminal displays, along with its title.
#
# Both session-rename and session-resume run this script on each machine via
# `python3 -c <script> <json>`. Keep both copies in sync so each mod works standalone.
#
# Input (argv[1]):
#   {
#     "<address>": {
#       "pid": <int>, "program": <str|null>, "argv": <list|null>, "cwd": <str|null>
#     }
#   }
#   (Also accepts legacy {"<address>": <int pid>} entries.)
# Output (stdout):
#   {"<address>": {"harness": "<name>", "id": "<id>" | null, "title": "..."}, ...}
#   Terminals whose foreground process matches no registered harness are omitted.
#   `id` is null when a harness is running without an active conversation on screen.
#
# Requires Python 3.9+ and uses only the standard library.

import json
import os
import re
import sqlite3
import subprocess
import sys

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


# Ordered list of harness resolvers. Each resolver receives `proc` and `db_cache`
# (for `get_db()`). `proc` holds `pid`, `program`, `argv`, `cwd`, the paths of its
# open `files`, and the subset `written` that it opened for writing. A resolver
# returns either `None` (not this harness) or
# `{"harness": "<name>", "id": <str | None>, "title": <str>}`.
#
# The callers send every foreground program that is not a shell, so a resolver must
# return `None` unless it is sure that the process is its agent CLI.
# Add resolvers here for other CLIs (Claude Code, Codex, Pi, or fast-agent).
HARNESSES = [
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
            }
            continue

        pid = parse_pid(info)
        if pid:
            processes[address] = {
                "pid": pid,
                "program": None,
                "argv": [],
                "cwd": None,
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


main()
