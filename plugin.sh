#!/bin/bash
# Links the mods in this folder into the Herdr app's mods folder, and tells Herdr to reload them.
#
#   ./plugin.sh link   [mod]   link each mod into Herdr's mods folder (never replaces anything)
#   ./plugin.sh reload [mod]   make Herdr reload them (needed after editing a linked mod here)
#   ./plugin.sh status [mod]   show whether each link is in place (the default)
#
# A mod is a folder here with a main.js. Copying a folder into Herdr's mods folder works too;
# linking keeps this folder the only copy.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MODS="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
action="${1:-status}"
only="${2:-}"

case "$action" in
  link | reload | status) ;;
  *) echo "usage: $0 link | reload | status [mod]" >&2; exit 2 ;;
esac

found=0
for main in "$HERE"/*/main.js; do
  [ -e "$main" ] || continue
  src="$(dirname "$main")"
  name="$(basename "$src")"
  dst="$MODS/$name"
  if [ -n "$only" ] && [ "$only" != "$name" ]; then continue; fi
  found=1

  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    state=linked
  elif [ -e "$dst" ] || [ -L "$dst" ]; then
    state=conflict
  else
    state=missing
  fi

  case "$action:$state" in
    link:linked)   echo "ok        $name" ;;
    link:missing)  mkdir -p "$MODS" && ln -s "$src" "$dst" && echo "linked    $name" ;;
    status:linked) echo "linked    $name" ;;
    # Herdr watches its own folder, not the folders links point to. Touching the
    # link itself is a change it does see, and it reloads what the link names.
    reload:linked) touch -h "$dst" && echo "reloaded  $name" ;;
    *:conflict)    echo "CONFLICT  $name: $dst exists and is not a link to this folder. Move it away, then run link." ;;
    *:missing)     echo "missing   $name (run ./plugin.sh link $name)" ;;
  esac
done

if [ "$found" = 0 ]; then
  if [ -n "$only" ]; then
    echo "no mod named '$only' here" >&2
    exit 1
  fi
  echo "no mods found here"
fi
