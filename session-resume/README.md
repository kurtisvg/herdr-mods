# session-resume

Enables resume sessions when the machine running `herdr-hc` restarts. Provides a "Resume" button when resumable sessions are found. Remembers missing terminals for 7 days and skips conversations already running in another terminal.

**Supported harnesses:** Jetski

## Install

1. Make sure each tracked machine has `python3` (3.9+) (`lsof` is used on macOS where it is built in, and is not needed on Linux):

   ```sh
   python3 --version    # 3.9 or later
   ```

2. Link `session-resume` into Herdr's mods folder (`~/.config/herdr-app/mods`):

   ```sh
   ./plugin.sh link session-resume
   ```

   Keep this repo in place because Herdr's mods folder stores a symlink to it.

3. Add the mod as a floating block in your custom layout (it stays hidden until there is something to resume). If you don't have a custom layout yet, clone `main`:

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
   ```

   In `~/.config/herdr-app/layouts/my-layout.json`, add this to a node's `floating` list (for example `"id": "sidebar-lists"`):

   ```json
   "floating": [
     { "id": "session-resume", "content": { "mod": "session-resume" }, "edge": "bottom", "align": "center" }
   ]
   ```

4. Check that Herdr loads the mod without errors:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/session-resume    # prints "check passed"
   ```

5. Optional — bind a key in `~/.config/herdr-app/keys.json` to trigger resume without clicking:

   ```json
   { "global": { "<key>": "session-resume.resume_all" } }
   ```

## Notes

- Herdr does not watch files behind symlinks. Run `./plugin.sh reload session-resume` after editing files or pulling updates.
