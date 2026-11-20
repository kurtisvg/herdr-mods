# herdr-mods

Personal mods for [Herdr](https://herdr.dev). Each folder is one mod, with its own
`README.md` covering what it does and how to wire it into a layout.

| Mod                                                | What it does                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [spaces-tab-tree](spaces-tab-tree/README.md)       | Lists each space's tabs under the space and marks git worktrees in their repo's color.                                                                                                                                                                 |
| [agents-by-tab-name](agents-by-tab-name/README.md) | Names each agent in the agents list after its tab, with its space, worktree, and remote machine underneath.                                                                                                                                            |
| [session-rename](session-rename/README.md)         | Names each tab after the agent conversation running in it, reading status reports first and falling back to `sessions.py`.                                                                                                                             |
| [session-resume](session-resume/README.md)         | Shows a one-click Resume button to bring back agent conversations after a restart replaces their terminals with fresh shells.                                                                                                                          |
| [review-panel](review-panel/README.md)             | Puts Files, Changes, and Comments in one side panel, where you can edit files, comment on lines or rendered markdown, and send the review to an agent. Also provides an optional tab bar with top-right mode buttons and a standalone markdown viewer. |
| [file-links](file-links/README.md)                 | Opens Ctrl+clicked local file links from Herdr terminals in the right-hand Files panel (works with `review-panel` or its own drop-in `files` panel) while leaving web URLs to the system opener.                                                       |

## Install

1. Start Herdr once. From this folder, link the mods into `~/.config/herdr-app/mods`:

   ```sh
   ./plugin.sh link            # or ./plugin.sh link <mod>
   ```

2. Add the mods you want to a custom layout in `~/.config/herdr-app/layouts/`. If you
   don't have one yet, clone `main`:

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
   ```

   Each mod's `README.md` shows the layout block it needs.

Herdr doesn't pick up edits made behind symlinks on its own. Run `./plugin.sh reload`
after editing a mod or pulling changes.
