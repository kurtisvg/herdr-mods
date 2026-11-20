# session-rename

Automatically names each Herdr tab after the agent conversation running in it. Reads the terminal status report (OSC 7501) first for ~1-second updates and falls back to `sessions.py` when the report has no title. Manual tab renames stay until the conversation's title changes, and sub-agent terminals take their parent conversation's title.

**Supported harnesses:** Jetski.

![A tab named after the conversation running in it](images/tab-name.png)

## Install

1. Make sure each tracked machine has Jetski and `python3` (3.9+) for the fallback lookup, plus the Herdr desktop app (tested with 0.1.16) locally (`lsof` is used on macOS where it is built in, and is not needed on Linux):

   ```sh
   python3 --version    # 3.9 or later
   ```

2. Link `session-rename` into Herdr's mods folder (`~/.config/herdr-app/mods`):

   ```sh
   ./plugin.sh link session-rename
   ```

   Keep this repo in place because Herdr's mods folder stores a symlink to it.

3. Add the mod as a floating block in your custom layout (it draws nothing and stays hidden). If you don't have a custom layout yet, clone `main`:

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
   ```

   In `~/.config/herdr-app/layouts/my-layout.json`, add this to a node's `floating` list (for example `"id": "sidebar-lists"`):

   ```json
   "floating": [
     { "id": "session-rename", "content": { "mod": "session-rename" }, "edge": "bottom", "align": "center" }
   ]
   ```

4. Check that Herdr loads the mod without errors:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/session-rename    # prints "check passed"
   ```

## Notes

- Jetski's status report currently includes the title only for resumed conversations with a saved title or after `/rename`; new auto-titled conversations rely on `sessions.py` (machines without `python3` only get reported titles).
- To add another agent CLI (such as Claude Code, Codex, Pi, or `fast-agent`), add a resolver to `HARNESSES` in `sessions.py` and optionally a status-report reader to `REPORT_TITLE` in `main.js`.
- Herdr does not watch files behind symlinks. Run `./plugin.sh reload session-rename` after editing files or pulling updates.
