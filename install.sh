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
if ! mkdir "$dest/install.lock" 2>/dev/null; then
  echo "Another install is active. If it crashed, remove $dest/install.lock and retry." >&2
  exit 1
fi
trap 'rmdir "$dest/install.lock"; if [[ -n ${tmp:-} ]]; then rm -rf "$tmp"; fi' EXIT
mkdir -p "$dest/releases"
release="$(mktemp -d "$dest/releases/release.XXXXXX")"
cp -r "$src/bridge" "$release/bridge"
cp -r "$src/addon" "$release/addon"
# Never remove the working helper while compiling its replacement.
if [[ $(uname -s) == Darwin ]]; then
  echo "Building and checking the macOS screen-capture helper…"
  /usr/bin/xcrun swiftc -parse-as-library -O "$release/bridge/native/mac-capture.swift" -o "$release/bridge/bin/mac-capture"
  "$release/bridge/bin/mac-capture" self-test
fi
node --check "$release/bridge/bin/t3code-wow.js"
node "$release/bridge/bin/t3code-wow.js" --help >/dev/null
# Node resolves these links to a release-specific path. Existing processes keep
# their complete release (including the helper); future processes use the new one.
for name in bridge addon; do
  if [[ -d "$dest/$name" && ! -L "$dest/$name" ]]; then
    mv "$dest/$name" "$dest/$name.legacy.$(date +%s)"
  fi
  ln -s "$release/$name" "$dest/$name.next"
  node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$dest/$name.next" "$dest/$name"
done
# Old releases are deliberately retained until no old bridge can be using them.
chmod +x "$dest/bridge/bin/t3code-wow.js"
ln -sf "$dest/bridge/bin/t3code-wow.js" "$bin/herdr-wow"
ln -sf "$dest/bridge/bin/t3code-wow.js" "$bin/t3code-wow"

# When piped from curl, stdin is this script; give the guided setup the keyboard.
if [[ ! -t 0 ]] && (: </dev/tty) 2>/dev/null; then
  node "$dest/bridge/bin/t3code-wow.js" install "$@" </dev/tty
else
  node "$dest/bridge/bin/t3code-wow.js" install "$@"
fi
