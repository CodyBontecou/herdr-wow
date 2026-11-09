# Herdr WoW

[Herdr](https://herdr.dev) spaces, agent tabs and conversations inside **World of Warcraft: Forever**.

[Setup & limitations](docs/HERDR.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Report a bug](https://github.com/CodyBontecou/herdr-wow/issues)

Browse your spaces and tabs, read agent conversations, reply to idle agents, and start Pi sessions without leaving the game.

**Experimental.** This fork adds native macOS capture and Herdr support to [Ryan Hughes's T3 Code addon](https://github.com/ryanrhughes/t3code-wow). The original Linux/T3 backend remains available. Native macOS transport has been exercised in game, but not every client version, sound setting, display setup or controller combination has been verified.

## In-game screenshots

Real captures from native macOS Forever, cropped to the addon window.

**Pi tool cards** — read syntax-colored tool arguments alongside your spaces and tabs.

![Herdr showing Pi tool cards in World of Warcraft](https://github.com/CodyBontecou/herdr-wow/releases/download/readme-media/04-tool-cards.png)

<details>
<summary>New-session form and notification settings</summary>

**New Thread** — choose an allowlisted project before starting Pi. This capture shows the form, not a completed launch.

![Herdr New Thread form with a configured Pi project](https://github.com/CodyBontecou/herdr-wow/releases/download/readme-media/03-new-session.png)

**Settings** — notification, tracker and read-aloud preferences.

![Herdr notification and tracker settings](https://github.com/CodyBontecou/herdr-wow/releases/download/readme-media/02-settings.png)

</details>

## What works

- **Your desktop organization, in game:** browse every space and tab in one selected Herdr session, in desktop order. Activity changes no longer shuffle tabs. Filter by space or inspect numbered pane rows in split tabs; empty spaces remain visible.
- **Pi conversation cards:** read the last saved conversation branch as replies, thinking, syntax-colored code, diffs and tool cards with expandable output and a bundled monospaced font. Other agents and unavailable Pi histories fall back to terminal output.
- **Agent replies and questions:** send prompts to idle Pi, Codex and Claude Code sessions. Recognized Codex and Claude Code questions support terminal navigation, single-line text entry and explicit submission. Shell tabs and other agent kinds are read-only.
- **New Pi sessions:** choose New Thread, select an allowlisted project, and start Pi in a background Herdr tab. The same session remains accessible on your desktop.
- **Tracker and notifications:** see work in progress and completion notices. Click a popup's × to dismiss it. `/herdr notifications off` disables automatic popups, sounds, chat notices and read-aloud; `on` enables them again. Individual preferences are in Settings.
- **Controller navigation:** hold both triggers and press Back/View to open the window. The window captures controller input only while open and releases it before combat lockdown.
- **Optional voice:** manual and automatic read-aloud use available game voices or a configured desktop speech backend. Dictation still needs a supported desktop backend.

Pi cards read saved history, not live streaming output: in-progress replies appear after Pi saves them. Terminal fallback removes empty viewport padding and a recognized Pi usage footer without removing code indentation. Unrecognized question layouts, approvals, stop, busy follow-ups/steering, screenshots and archiving still require the desktop. See [the setup and limitations guide](docs/HERDR.md).

## What changed from upstream

Herdr WoW is based on [Ryan Hughes's `t3code-wow`](https://github.com/ryanrhughes/t3code-wow). The upstream addon connects WoW to T3 Code on Linux; this fork adds a Herdr-first workflow while keeping the original backend available.

| Area | Changes in this fork |
| --- | --- |
| Backend | Herdr session discovery and agent controls, no T3 installation required. Fresh installs default to Herdr; existing backend choices are preserved. |
| Desktop organization | All spaces and tabs, empty spaces, numbered split panes and lists beyond the original 90-thread limit. Desktop moves, renames, reordering and closures reconcile on refresh. Activity never changes tab order. |
| Conversations | Pi saved-branch cards for user/assistant text, thinking, code and tools; syntax colors, diff colors, bounded expandable output and JetBrains Mono. Other sessions retain a labeled terminal view. |
| New sessions | Launch Pi in an unfocused tab through allowlisted project directories. The task form submits an initial prompt; the new-tab shortcut opens a fresh session ready for input. Failed launches retain their tab for inspection. |
| Keyboard navigation | Preview/import supported Herdr tab and workspace shortcuts, review conflicts in game, and undo the last import. Space cycling follows dropdown order. New-tab launches use a configured project in the selected space or open the task form. |
| Tab closing | Close the actual Herdr tab from its shortcut, with live identity checks. **This immediately terminates all panes and processes in that tab, without confirmation.** |
| Terminal questions | Guarded controls for narrowly recognized Codex and Claude Code question screens. Single-use screen IDs and session checks reject stale answers; text entry does not append Enter. Unknown layouts and approvals remain desktop-only. |
| Native macOS | Forever discovery, process-start identity checks and a ScreenCaptureKit helper for pixel-strip capture and screenshots. Linux capture and the optional T3 backend remain available. |
| Notifications | Dismiss individual popups and mute all automatic popups, sounds, chat notices and read-aloud from Settings or `/herdr notifications off`. Manual speech remains available. |
| Branding | Herdr window title, icons, minimap art, game-menu entry, settings, bindings, `/herdr` commands and `herdr-wow` CLI. Legacy aliases and saved data remain compatible. |
| Safety and verification | Separate browse permissions from launch allowlists; shell tabs stay read-only. Session identity checks, serial commands, guarded question input, Pi-session path validation, bridge regression tests and expanded Lua smoke coverage. |

The encrypted pixel strip, load-on-demand slots, bell protocol, pacing and controller/combat boundaries come from upstream and remain intact. This is still experimental: native macOS transport has worked in game, but full visual/controller verification and broader client/display/sound coverage remain incomplete. The [Herdr guide](docs/HERDR.md) records feature boundaries and verification gaps.

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
git clone https://github.com/CodyBontecou/herdr-wow.git
cd herdr-wow
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

## Import Herdr keyboard shortcuts

```bash
herdr-wow keybinds import          # preview supported shortcuts; no changes
herdr-wow keybinds import --apply  # stage the import for WoW
```

Then `/reload` and run `/herdr importkeys` to review conflicts and confirm. `/herdr undokeys` restores bindings changed by the last import when safe. Two-step prefix sequences need an explicit modifier translation; Cmd/Super chords and unsupported actions are skipped. See [shortcut import details](docs/HERDR.md#import-terminal-shortcuts).

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
