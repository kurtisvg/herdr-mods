# file-links

Ctrl+clicking a local file path or `file://` link in a Herdr terminal opens it in the
right-hand **Files** panel instead of an external app. Links with a
line number (like `path.js:40` or `#L40`) jump straight to that line. Web URLs,
folders, and anything not opened from Herdr still go to the system opener as usual.

- **With [review-panel](../review-panel/README.md):** Switches to **Files**, renders
  markdown (or opens it in **Edit** mode when a line number is given), and opens code
  files in the auto-saving editor.
- **With Herdr's default Files panel:** Includes a drop-in replacement
  (`"props": { "role": "files" }`) for the built-in `files` mod.

## Install

1. Make sure you have `python3` (3.9+) and the Herdr desktop app (tested with 0.1.16):

   ```sh
   python3 --version    # 3.9 or later
   ```

2. Link `file-links` into Herdr's mods folder (`~/.config/herdr-app/mods`):

   ```sh
   ./plugin.sh link file-links
   ```

   Keep this repo in place because Herdr's mods folder stores a symlink to it. If you
   also use `review-panel`, run `./plugin.sh reload review-panel` after pulling updates.

3. Add the hidden listener as a floating block in your custom layout. If you don't have
   one yet, clone `main`:

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
   ```

   In `~/.config/herdr-app/layouts/my-layout.json`, add this to a node's `floating` list
   (for example `"id": "sidebar-lists"`):

   ```json
   "floating": [
     { "id": "file-links", "content": { "mod": "file-links" }, "edge": "bottom", "align": "center" }
   ]
   ```

   If you use `review-panel`, you're done with the layout. If you use Herdr's built-in
   `files` panel instead, swap `"id": "files"` in `"panel-body"` to use `file-links`:

   ```json
   { "id": "files", "type": "block", "content": { "mod": "file-links", "props": { "role": "files" } } }
   ```

   Save the file. Herdr reloads the layout automatically.

4. Add `file-links/bin` to the front of `PATH` in whatever script or desktop entry
   starts `herdr-app`, then restart Herdr:

   ```sh
   export PATH="$HOME/.config/herdr-app/mods/file-links/bin:$PATH"
   ```

   Put this only in Herdr's launcher, not in your shell profile. Terminals run inside
   `herdr-core`, so your shells, agents, and other apps won't see the wrapper.

5. Check that Herdr loads the mod without errors:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/file-links    # prints "check passed"
   ```

## Notes

- Linux only for now (`bin/xdg-open` wraps `xdg-open`, which is what `herdr-app` calls
  on Linux; macOS uses `open`).
- Open requests are shared under `file-links.open`, which both
  [review-panel](../review-panel/README.md) and the `role: "files"` panel listen for.
- You can test the bridge from a shell without clicking:
  `HERDR_FILE_LINKS_FORCE=1 ~/.config/herdr-app/mods/file-links/bin/xdg-open /path/to/file.md:10`.
  Tests run with `node --test file-links/test/path.test.mjs`.
- Herdr does not watch files behind symlinks. Run `./plugin.sh reload file-links` after
  editing files or pulling updates.
