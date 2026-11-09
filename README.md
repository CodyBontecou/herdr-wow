# Herdr for World of Warcraft

An unofficial [Herdr](https://herdr.dev) interface inside World of Warcraft: Forever. Browse your spaces and tabs, read agent output, reply to idle agents, and start Pi sessions without leaving the game.

**Experimental.** This fork adds native macOS capture and Herdr support to [Ryan Hughes's T3 Code addon](https://github.com/ryanrhughes/t3code-wow). The original Linux/T3 backend remains available. Native macOS transport has been exercised in game, but not every client version, sound setting, display setup or controller combination has been verified.

## What works

- **Spaces and tabs:** `/herdr` opens all spaces in the selected Herdr session. Filter by space, select a tab, or inspect individual panes in split tabs. Empty spaces remain visible.
- **Agent replies:** read terminal output and send prompts to idle Pi, Codex and Claude Code sessions. Shell tabs and other agent kinds are read-only.
- **New Pi sessions:** choose New Thread, select an allowlisted project, and start Pi in a background Herdr tab. The same session remains accessible on your desktop.
- **Tracker and notifications:** see work in progress and completion notices. Click a popup's × to dismiss it. `/herdr notifications off` disables automatic popups, sounds, chat notices and read-aloud; `on` enables them again. Individual preferences are in Settings.
- **Controller navigation:** hold both triggers and press Back/View to open the window. The window captures controller input only while open and releases it before combat lockdown.
- **Optional voice:** manual and automatic read-aloud use available game voices or a configured desktop speech backend. Dictation still needs a supported desktop backend.

Herdr transcripts currently contain terminal output, not full structured chat history. Empty viewport padding and a recognized Pi usage footer are removed. Recognized Codex and Claude Code questions have in-game terminal navigation, text-entry and submit controls. Unrecognized layouts, approvals, stop, busy follow-ups/steering, screenshots and archiving still require the desktop. See [the setup and limitations guide](docs/HERDR.md).

## Requirements

- World of Warcraft: **Forever** (1.60.x), not Retail or Classic.
- Node.js **22 or newer**.
- A running Herdr session with its CLI on PATH; tested with **Herdr 0.8.0**.
- Pi on PATH if you want to start new Pi sessions.
- On macOS: **macOS 14+**, Xcode command-line tools and Screen Recording permission for the capture helper/terminal.
- On Linux: the existing Hyprland/`grim` or X11/ImageMagick capture backend. The original supported setup was Omarchy 4.5.0 with Forever under Proton.
- Game sound enabled for fast update bells. With sound disabled, the addon falls back to slower slot polling.

T3 Code is **not required** for Herdr. To use the optional original backend instead, select `--backend t3`; it needs a compatible running T3 Code Nightly and its scoped login. That private API changes between releases.

## Install from this checkout

```bash
./install.sh --backend herdr --no-service
~/.local/bin/herdr-wow run
```

Leave the bridge terminal running. The macOS installer compiles its capture helper; Linux can optionally use the existing user service instead of `--no-service`.

On the first installation, **quit and restart WoW completely**, then log in. New slot addons and sounds are indexed at launch. Later code updates usually need `/reload` after rerunning `./install.sh` from the checkout. A nonstandard installation can be selected with `--wow "/path/to/World of Warcraft/_forever_"`.

All existing spaces/tabs are discoverable without configuring launch directories. To allow new Pi sessions, use an actual workspace ID returned by `herdr workspace list`:

```bash
herdr-wow project add my-project \
  --cwd /absolute/project/directory \
  --workspace WORKSPACE_ID \
  --name 'My project · Pi' \
  --session default
```

Restart the bridge after changing its configuration. The directory and workspace are trusted desktop configuration, never arbitrary paths supplied from the game. Detailed permissions, setup, named-session selection and troubleshooting are in [docs/HERDR.md](docs/HERDR.md). If `herdr-wow` is not on PATH, use `~/.local/bin/herdr-wow`.

## In game

- `/herdr`: open or close the window. The minimap button, game-menu entry and controller shortcut do the same.
- `/herdr new`: start a Pi session in a configured project.
- `/herdr settings`: notification, tracker, voice and display preferences.
- `/herdr notifications on` / `/herdr notifications off`: enable or disable automatic notifications.
- `/herdr unlock`: drag the small tracker by its header; `/herdr lock` locks it again.
- `/herdr selftest`: check the game/bridge link.
- `/herdr errors`: inspect recorded addon errors.

Keyboard shortcuts can be assigned in **Options → Keybindings → Herdr**. Existing keyboard bindings are preserved. The legacy `/t3` and `/t3code` commands still work.

## Bridge commands

```bash
herdr-wow status --log      # backend, game, capture and addon diagnostics
herdr-wow probe             # capture/decode the strip corner
herdr-wow sync              # re-copy the installed addon, not checkout edits
herdr-wow uninstall        # remove this addon/bridge, not Herdr's tabs or chats
```

The `t3code-wow` CLI alias remains available. `herdr` itself is still the desktop terminal manager; this bridge does not replace that executable.

## Compatibility and the rebrand

The visible title, game menu, chat notices, keybinding labels and icons are now **Herdr**. Fresh installations select Herdr by default; existing backend configurations are retained.

To preserve saved settings, keybindings, encryption keys and the measured transport, internal identifiers stay unchanged: `T3Code/`, `T3CodeDB`, `T3CODE_*`, `T3Code_S###`, the slot TOC/XML bytes and the existing `t3code-wow` config/state/data/service paths. Do not delete or rename those slot folders. The main addon's title is Herdr; generated slots retain their legacy metadata because changing it changes addon-manager fingerprints. Updated icon textures may require a full client restart if WoW keeps the old textures cached.

## How it works

Addons cannot open sockets or read arbitrary files. Commands leave the game as an authenticated, encrypted strip of pixels. A desktop bridge captures that strip, talks to Herdr, and writes safely serialized snapshots into preinstalled load-on-demand slot addons. Rotating silent sounds signal new data. The bridge does not read game memory or inject game input.

The encryption, bell positions, slot pacing and controller/combat boundaries are deliberately retained from the original addon. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the initial [portability audit](docs/PORTABILITY-AUDIT.md).

## Development and credits

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Coding agents should also read [AGENTS.md](AGENTS.md). Bridge tests run with `cd bridge && npm test`; addon changes need Lua 5.1/LuaJIT smoke checks and in-game verification.

This fork builds on [Ryan Hughes's T3 Code for WoW](https://github.com/ryanrhughes/t3code-wow), and the client measurements from [wow-ai](https://github.com/chelinho139/wow-ai) and [wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex). The original project's credits also acknowledge Bellular's suggestion to use a native addon rather than an overlay.

Addon and bridge code retain the original [MIT license](LICENSE). The Herdr logo and its resized texture conversions are covered by Apache 2.0; [artwork attribution and license](addon/T3Code/Media/ATTRIBUTION.md) are included with the addon. This is a fan integration, not affiliated with or endorsed by Blizzard or the Herdr project. Use it at your own discretion.
