#!/usr/bin/env python3
"""Resolves a local file target and signals Herdr's `file-links` mod to open it.

Exits 0 only when the target is an existing local regular file and Herdr accepts
`herdr-app do file-links.open`. Exits nonzero otherwise so the launcher wrapper
can fall back to the real system `xdg-open`.
"""

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from urllib.parse import unquote, urlparse

SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
LINE_COL_RE = re.compile(r"^(.+):([1-9][0-9]*):([1-9][0-9]*)$")
LINE_ONLY_RE = re.compile(r"^(.+):([1-9][0-9]*)$")
FRAGMENT_LINE_RE = re.compile(r"^L?([1-9][0-9]*)(?:[C:]([1-9][0-9]*))?$", re.IGNORECASE)


def launched_by_herdr():
    """Return True when `herdr-app` is an ancestor process (or when forced)."""
    if os.environ.get("HERDR_FILE_LINKS_FORCE") == "1":
        return True
    if not os.path.isdir("/proc"):
        return True

    pid = os.getppid()
    for _ in range(8):
        if pid <= 1:
            return False
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                raw_cmd = f.read().split(b"\0", 1)[0].decode("utf-8", "replace")
            if os.path.basename(raw_cmd) == "herdr-app":
                return True
            with open(f"/proc/{pid}/stat", "r", encoding="utf-8", errors="replace") as f:
                stat = f.read()
            # Process comm sits in parentheses and may contain spaces; ppid is
            # the second field after the closing parenthesis.
            rparen = stat.rfind(")")
            if rparen < 0:
                return False
            fields = stat[rparen + 2 :].split()
            pid = int(fields[1])
        except (OSError, ValueError, IndexError):
            return False
    return False


def parse_fragment(fragment):
    if not fragment:
        return None, None
    match = FRAGMENT_LINE_RE.match(fragment.strip())
    if not match:
        return None, None
    line = int(match.group(1))
    col = int(match.group(2)) if match.group(2) else None
    return line, col


def parse_target(raw, cwd=None):
    """Parse a local file path or file:// URI into {path, realpath, line, col}."""
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None

    line = None
    col = None

    if text.lower().startswith("file://"):
        parsed = urlparse(text)
        host = (parsed.hostname or "").lower()
        if host and host not in ("localhost", os.uname().nodename.lower()):
            return None
        candidate = unquote(parsed.path)
        if not candidate:
            return None
        line, col = parse_fragment(parsed.fragment)
    elif SCHEME_RE.match(text):
        return None
    else:
        candidate = os.path.expanduser(text)

    if not os.path.isabs(candidate):
        base = cwd if cwd is not None else os.getcwd()
        candidate = os.path.join(base, candidate)

    # Check the raw path before stripping `:line:col` or `:line` so filenames
    # that literally contain colons still resolve as written.
    resolved = os.path.normpath(candidate)
    if not os.path.isfile(resolved):
        found = None
        for pattern, has_col in ((LINE_COL_RE, True), (LINE_ONLY_RE, False)):
            match = pattern.match(candidate)
            if not match:
                continue
            stripped = os.path.normpath(match.group(1))
            if os.path.isfile(stripped):
                found = (
                    stripped,
                    int(match.group(2)),
                    int(match.group(3)) if has_col else None,
                )
                break
        if found is None:
            return None
        resolved, parsed_line, parsed_col = found
        if line is None:
            line = parsed_line
            col = parsed_col

    return {
        "path": resolved,
        "realpath": os.path.realpath(resolved),
        "line": line,
        "col": col,
    }


def find_herdr_app():
    found = shutil.which("herdr-app")
    if found:
        return found
    for candidate in (
        os.path.expanduser("~/.local/bin/herdr-app"),
        os.path.expanduser("~/.local/share/herdr-app/herdr-app"),
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def write_request(app_home, target):
    data_dir = os.path.join(app_home, "data", "file-links")
    os.makedirs(data_dir, exist_ok=True)
    now_ms = int(time.time() * 1000)
    payload = {
        "id": f"{now_ms}-{secrets.token_hex(4)}",
        "path": target["path"],
        "realpath": target["realpath"],
        "line": target["line"],
        "col": target["col"],
        "at": now_ms,
    }
    dst = os.path.join(data_dir, "request.json")
    tmp = os.path.join(data_dir, f".request.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, dst)
    return payload


def main(argv):
    if len(argv) != 2:
        return 1
    if not launched_by_herdr():
        return 1

    app_home = os.environ.get("HERDR_APP_HOME") or os.path.expanduser(
        "~/.config/herdr-app"
    )
    if not os.path.exists(os.path.join(app_home, "herdr-app.sock")):
        return 1

    target = parse_target(argv[1])
    if target is None:
        return 1

    herdr_bin = find_herdr_app()
    if not herdr_bin:
        return 1

    write_request(app_home, target)
    try:
        res = subprocess.run(
            [herdr_bin, "do", "file-links.open"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return 1
    return 0 if res.returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
