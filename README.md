# herdr-mods

Personal mods for [Herdr](https://herdr.dev). Each folder is one mod, with its own
`README.md` covering what it does and how to wire it into a layout.

| Mod                                                | What it does                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [agents-by-tab-name](agents-by-tab-name/README.md) | Names each agent in the agents list after its tab, with its space, worktree, and remote machine underneath.                                                                                                                                            |

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
