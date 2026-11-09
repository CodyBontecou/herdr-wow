#!/bin/bash
# Install or update Herdr for World of Warcraft from this checkout: ./install.sh.
# The legacy installation paths and t3code-wow alias are retained for upgrades.
#
# Run the same command again to update. From a clone, ./install.sh installs that copy.
# Options (after `bash -s --` when piping): --wow "/path/to/World of Warcraft" --slots N --no-service
#
# Copies the bridge and addon to the existing ~/.local/share/t3code-wow location,
# installs herdr-wow plus its t3code-wow alias, and runs setup. Herdr is the default
# for new installs; the optional T3 backend creates its scoped session when selected.
set -euo pipefail

repo="${HERDR_WOW_REPO:-CodyBontecou/herdr-wow}"
ref="${HERDR_WOW_REF:-${T3CODE_WOW_REF:-main}}"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/t3code-wow"
bin="$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1; then
  echo "Herdr for World of Warcraft needs Node.js 22 or newer. Install Node, then run this installer again." >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then
  echo "Herdr for World of Warcraft needs Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

if [[ ${XDG_SESSION_TYPE:-} == "wayland" ]] && ! command -v grim >/dev/null 2>&1; then
  echo "Note: install grim so the bridge can see the game (pacman -S grim)." >&2
fi

# Install from this checkout, or download the latest version when piped from curl.
src=""
here="${BASH_SOURCE[0]:-}"
if [[ -n $here && -f $here ]]; then
  here="$(cd "$(dirname "$here")" && pwd)"
  if [[ -d "$here/bridge" && -d "$here/addon" ]]; then
    src="$here"
  fi
fi
if [[ -z $src ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading Herdr for World of Warcraft ($ref)…"
  url="${HERDR_WOW_TARBALL:-${T3CODE_WOW_TARBALL:-https://codeload.github.com/$repo/tar.gz/$ref}}"
  if ! curl -fsSL "$url" | tar -xz -C "$tmp" --strip-components=1; then
    echo "Couldn't download $url." >&2
    exit 1
  fi
  src="$tmp"
fi

mkdir -p "$dest" "$bin"
rm -rf "$dest/bridge.new" "$dest/addon.new"
cp -r "$src/bridge" "$dest/bridge.new"
cp -r "$src/addon" "$dest/addon.new"
rm -rf "$dest/bridge" "$dest/addon"
mv "$dest/bridge.new" "$dest/bridge"
mv "$dest/addon.new" "$dest/addon"
chmod +x "$dest/bridge/bin/t3code-wow.js"
ln -sf "$dest/bridge/bin/t3code-wow.js" "$bin/herdr-wow"
ln -sf "$dest/bridge/bin/t3code-wow.js" "$bin/t3code-wow"

# When piped from curl, stdin is this script; give the guided setup the keyboard.
if [[ ! -t 0 ]] && (: </dev/tty) 2>/dev/null; then
  node "$dest/bridge/bin/t3code-wow.js" install "$@" </dev/tty
else
  node "$dest/bridge/bin/t3code-wow.js" install "$@"
fi
