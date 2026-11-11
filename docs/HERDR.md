# Herdr spaces and tabs (experimental)

The Herdr backend lets **New Thread → Start** open Pi in a background Herdr tab in a configured project directory. The same session is available on your desktop. No T3 installation or login is required when this backend is selected. Fresh installs now select Herdr; existing configured backends (including pre-fork T3 installations) are preserved.

The addon lists every space and tab in the selected Herdr session, including existing Pi, Codex and Claude Code sessions and ordinary terminal tabs. It shows recent terminal output and accepts replies to Pi/Codex/Claude Code when idle/ready. Shell tabs and other agent kinds are read-only. Configured project directories restrict new Pi launches, not discovery. Pi sessions with an available local session file show saved conversation blocks; other agents retain recent terminal output. Approval menus are not parsed. Recognized Codex and Claude Code question screens have explicit terminal navigation and submit buttons in game, including an Open questions button for Codex's collapsed queue. Select a text field first to enter a single-line written answer with the composer; Send enters the text without submitting it. Review the updated terminal, then use Select / submit answer. Multiple-choice selection and navigation use the terminal's own UI, not reconstructed question data. Unknown layouts remain desktop-only. Stop, busy follow-ups/steering, settling, archiving, image attachments and approvals are not supported yet; use Herdr on the desktop for these. Unknown and blocked states are never treated as completed work.

## Setup from a checkout

Requirements: Node >=22 and Herdr with `api snapshot`, pane reads and agent controls (tested with 0.8.0). Pi must be installed on the host's PATH to start new Pi sessions, but is not required just to browse existing tabs. On macOS, the capture helper needs macOS 14 or later and Xcode command-line tools (`xcode-select --install`). The installer starts a supervised macOS LaunchAgent by default; `--no-service` retains foreground operation.

1. Start Herdr. All its spaces and tabs in the selected session are discoverable without configuring project directories.
2. **Optional, for new Pi launches:** choose an existing workspace and run `herdr workspace list` inside Herdr to get its ID. Allowlist a launch directory using the checkout's CLI. Substitute your directory and actual workspace ID (not its sidebar number):

   ```bash
   node bridge/bin/t3code-wow.js project add my-project \
     --cwd /absolute/project/directory \
     --workspace WORKSPACE_ID \
     --name 'My project · Pi' \
     --session default
   ```

3. Install from this checkout:

   ```bash
   ./install.sh --backend herdr
   ```

   Use `--wow "/path/to/World of Warcraft/_forever_"` for a nonstandard game location. Native macOS installations in the standard Applications directories are also discovered. This still targets Forever, not Retail or Classic.
4. Fully quit and restart WoW the first time so it indexes the new slot addons and sounds. Later code-only updates usually need `/reload`; new folders need another full restart.
5. Check `herdr-wow status --log`. The installer starts the bridge automatically. If you chose `--no-service`, start `~/.local/bin/herdr-wow run` in a terminal and leave it running.

6. Log in to a character and open `/herdr` (`/t3` remains a compatibility alias). **All spaces** shows every tab; the dropdown filters by space, including empty spaces. Select a tab to read its output. To start Pi, choose **New Thread**, select an allowlisted launch project, enter a task, and press **Start**. Pi uses your normal settings. If first-run/trust/setup prompts block startup, inspect the retained Herdr tab on the desktop.

Additional `project add` commands add or replace allowlist entries by ID. Configuration is stored at `${XDG_CONFIG_HOME:-~/.config}/t3code-wow/config.json`. Project commands do not launch agents or create workspaces. Restart the bridge after editing configuration. Workspaces must already exist in the selected Herdr session. If a workspace is closed/recreated, configure its new returned ID.

Named Herdr sessions can be selected with `--session NAME` when configuring projects, or by setting `herdr.session` in the config for browse-only use. Discovery covers one selected Herdr session (default: `default`), not all named sessions or remote machines. The bridge clears inherited socket routing variables when explicitly selecting that session, so launching it inside another Herdr session does not accidentally control that other session.

## Browsing spaces and tabs

One Herdr topology snapshot supplies spaces, tabs, panes and agent metadata every two seconds. Each space is a browse filter; each tab appears as a row with its tab label and agent kind. Split tabs have one numbered row per pane, so no pane is silently hidden. Terminal output is read only for the selected tab. Discovery does not focus tabs, start agents or add launch permissions.

Ordinary terminals and unsupported agent kinds are read-only, enforced in both the addon and bridge. Idle Pi, Codex and Claude Code sessions accept literal prompts through Herdr's agent interface; shell input is never sent. Empty spaces stay in the filter. Spaces and tabs follow their desktop Herdr order, with split-pane rows kept together; activity changes do not move tabs. Renamed, reordered, moved and closed tabs/spaces are reconciled at the next snapshot. The original T3 thread-count limit does not truncate Herdr's tab list.

Launch projects are listed separately in the New Thread dropdown. Browse-only spaces never become launch destinations automatically, and changing the space filter does not authorize a new directory. An old configured-project filter is migrated to its matching space filter.

## Pi conversation cards

For Pi sessions in the default local Pi sessions directory, the addon displays the last saved conversation branch as separate replies, muted thinking blocks, code blocks and tool cards. Code and tool output use JetBrains Mono (bundled under the SIL Open Font License), basic lexical syntax colors and green/red diff lines. Completed and failed tools have distinct labels. Long blocks have an Expand output button; expansion is local, controller-accessible and never sends terminal keys. Each card carries at most 5,000 raw characters; the desktop retains longer output.

This reads Pi's saved JSONL, not its live renderer: streaming messages appear after Pi persists them. Unsaved tree navigation cannot be observed. Only the exact session path reported by Herdr is read, with a matching cwd; system prompts, extension state, images and signatures are not displayed. Custom session locations, sessions over 32 MiB, malformed sessions and other agents fall back to the terminal view. Recognized terminal questions continue to show the terminal screen and use the existing guarded controls.

## Import terminal shortcuts

Install this checkout first (`./install.sh --backend herdr`). Preview your Herdr shortcuts from the terminal:

```bash
herdr-wow keybinds import
herdr-wow keybinds import --apply
```

The first command changes nothing. The second stages only supported keybindings in the installed addon. In WoW, `/reload`, then `/herdr importkeys`. Review the listed keys and any existing WoW actions they replace, then click **Import keys**. Changes are saved to the active account or character binding set; other keys remain unchanged. Nothing is changed during combat. `/herdr undokeys` restores the keys changed by the last import, unless you have since edited those keys or switched binding sets. A repeated, unchanged import preserves the existing undo backup.

The importer reads `HERDR_CONFIG_PATH` or `~/.config/herdr/config.toml`; use `--config FILE` to override it. `--wow DIR` chooses another installation. Direct shortcuts for `new_tab`, `next_tab`, `previous_tab` and `close_tab` map to the addon's new/next/previous/close-thread actions. `next_workspace` and `previous_workspace` cycle the space filter in dropdown order, including empty spaces and wrapping at either end. They skip aggregate filters and launch-only projects, open the Threads page, and preserve the current conversation, draft and search. They do not focus or change workspaces in the desktop terminal. New-tab shortcuts immediately create an unfocused tab with a fresh Pi session, ready for a first message. They use an allowlisted launch project matching the selected space (preferring the last-used project within that space); All spaces uses the viewed tab's space, or a configured default when no tab is selected. If the space has no launch project, the shortcut opens the project/task form instead and explains what is missing. Saved task-form drafts are not submitted. The New Thread button still opens the project/task form. Shortcuts never run arbitrary terminal commands. Close-thread shortcuts immediately terminate the actual Herdr tab, including all split panes and their running processes, without confirmation. Workspace creation/removal, custom commands and unrelated configuration are not imported or executed. Unsupported shortcuts are reported instead of guessed.

WoW bindings cannot express Herdr's two-step prefix sequences. To explicitly replace `prefix+…` with a modifier chord, preview `herdr-wow keybinds import --prefix-modifier ctrl-alt`, then add `--apply` if the translation is what you want. Missing tab shortcuts use Herdr's documented defaults; empty strings remain disabled. Cmd/Super shortcuts and unmodified keys other than function keys are skipped. The importer accepts simple single-line strings in `[keys]`, not every TOML representation.

Staged data lives in `T3Code/ImportedBindings.lua`, is preserved by addon sync/upgrades, and does not need a bridge restart. Re-staging backs up the preceding file as `ImportedBindings.lua.bak`. The importer never modifies WoW's binding files or SavedVariables on disk.

## Notifications

Click the × at the top-right of a popup to dismiss only that notice, without opening or selecting a tab. The remaining notices move up. Clicking the popup body still opens its tab; right-clicking its body also dismisses it.

Open `/herdr settings` and toggle **Enable notifications**, or use `/herdr notifications on` / `/herdr notifications off` (no argument toggles). This saved master preference controls automatic popups, notice sounds, chat notices and automatic read-aloud. Disabling hides existing popups and discards queued combat notices and deferred desktop announcements. Re-enabling does not replay discarded notices. Individual popup/sound/read-aloud preferences are preserved. Manual read-aloud and replies are unaffected.

These addon controls require `/reload` after installing the update. They apply to both Herdr and T3 backends.

## Branding and upgrades

The UI title, tracker, notifications, minimap art, game-menu entry, keybinding labels and Options category are Herdr. Use `/herdr` in game and `herdr-wow` on the desktop. Legacy `/t3`, `/t3code` and `t3code-wow` commands remain aliases. Existing saved settings and assigned keybindings are retained.

The installed `T3Code` folder/global, `T3CodeDB`, binding IDs, slot addon names and manifest bytes, service name and config/state/data directories intentionally retain their legacy names. This is a display/command rebrand, not a transport or data migration. New icon textures reuse the existing filenames; `/reload` loads the new code, but cached textures may need a full game restart. Artwork source and licensing are included in `addon/T3Code/Media/ATTRIBUTION.md`.

## Capture recovery and supervision

Updates are staged in immutable release directories under the existing data directory. The macOS helper is built and self-tested before the installed links switch. Running bridges retain their old release files; old releases are not automatically pruned. The first upgrade from the old directory layout keeps `.legacy.*` backups. A crashed installer may leave `install.lock`; confirm no installer is running before removing that directory and retrying.

Capture failures retry with exponential backoff from 400 ms to 10 seconds. Successful capture clears resolved errors, even when no strip is visible. Missing helper, permission denial, timeout and other capture errors are reported separately. A changed game process identity clears cached geometry. No-strip and hidden-window states are normal and do not trigger bridge restarts.

`herdr-wow status --log` separates status freshness, last successful capture, decoded frames and acknowledged snapshot generations. `awaiting-ack` means a strip is still being received while an update remains unacknowledged for over 15 seconds; `capture-stalled` means no successful capture for over 15 seconds. The addon hides its strip immediately when acknowledged, without sending an acknowledgement-of-acknowledgement. Quiet pixels with an unconfirmed snapshot therefore report `idle-unverified`, not a link failure. Neither idle state proves continuous addon liveness. Capture success alone does not verify the return channel.

On macOS, the LaunchAgent `io.herdr.wow.bridge` starts at login and restarts after crashes with a 10-second throttle. Logs are in the state directory's `bridge.log`. To restart it, use `launchctl kickstart -k gui/$(id -u)/io.herdr.wow.bridge`. To stop it for foreground debugging, use `launchctl bootout gui/$(id -u)/io.herdr.wow.bridge`, then `herdr-wow run`. Rerunning the installer without `--no-service` restores supervision; uninstall removes the agent. `--no-service` does not stop an already installed service. Shell path overrides are retained, but shell credentials are not copied into the plist.

A loopback-only, OS-owned listener prevents simultaneous bridges for the same canonical state directory and user. It carries no API or transport data and is released on crashes. Its deterministic port can conflict with another local program; the error reports the port instead of starting a second bridge. This is bridge supervision, not a new game/addon channel.

Authenticated command IDs are persisted before external side effects so a replay after recovery does not resubmit an uncertain operation. This is at-most-once dispatch, not exactly-once delivery: a crash between recording an ID and completing its operation may leave it unexecuted or uncertain. Check the desktop before manually resubmitting. Capture recovery never resets bell/slot counters; only the existing game-process/session rules advance or reset them.

## macOS capture permissions

Installation builds a small ScreenCaptureKit helper at `~/.local/share/t3code-wow/bridge/bin/mac-capture`. It captures the selected game process's window, converts the top-left corner to lossless sRGB PPM pixels, and reuses the existing encrypted strip decoder. It does not press game keys or read game memory. The current implementation invokes the helper per capture; a persistent capture service is a possible later optimization.

If Screen Recording access is denied, request it explicitly:

```bash
~/.local/share/t3code-wow/bridge/bin/mac-capture permission
```

Grant the terminal/helper access in **System Settings → Privacy & Security → Screen Recording** (the exact label varies by macOS version), then restart the bridge. Do not assume permissions granted to a different application or service apply here.

Use `~/.local/bin/herdr-wow status --log` for backend, process and capture diagnostics, and `~/.local/bin/herdr-wow probe` to capture/decode the strip corner. Open `/herdr` or submit an action while probing: acknowledged strips are intentionally hidden. Probe images and logs can contain private information; inspect them before sharing.

Native process detection includes process start time so a restarted game with a reused PID is not mistaken for the previous process. Native slot loading and bell behavior still need measurement across real macOS client versions, sound settings, reloads and restarts. Capture success by itself does not verify the entire transport.

## Launch and failure behavior

- New-agent commands select configured launch project IDs. Browse/reply commands select opaque IDs for discovered tabs; the bridge resolves their current identity before using Herdr. Launch directories, executables, native agent arguments and workspace destinations still come only from trusted desktop configuration.
- New tabs use `--no-focus`. The bridge starts `pi` through Herdr, waits for startup readiness, then submits the initial prompt as a literal argument (not a shell command).
- The addon prevents a second Start submission while a launch is pending. Authenticated command IDs are deduplicated during normal operation, and backend commands execute in receive order. This is not durable exactly-once execution across crashes: inspect Herdr before retrying an uncertain launch.
- A newly created shell may not be ready immediately. Only Herdr's definite pre-input `agent_pane_busy` rejection is retried, for up to five seconds. Timeouts or uncertain failures are not automatically replayed.
- After startup/prompt failure, the new tab stays in Herdr for inspection. The addon restores the initial draft. **Inspect the tab before retrying**: the agent or initial prompt may already have started.
- Existing tabs are visible across all spaces and directories in the selected session, including the conversation that started the bridge. Replies are rejected for read-only tabs, working agents and agents needing desktop input.
- Saved thread IDs include terminal/session identity. A replaced agent is rejected rather than intentionally receiving a delayed prompt for its predecessor. Question actions also re-read the visible screen, reject any changes and consume the request before writing input. The non-answering Open questions action only requires the same recognized opener and question count, so background animation does not prevent opening Codex's queue. Uncertain writes are not automatically retried. Herdr's CLI remains a terminal-control interface, not a transactional conversation API; external changes between checks and input submission remain a limitation. Animated output can invalidate a question action: refresh and review the screen before trying again. These checks are not an atomic question-response protocol or a security boundary against agent-written terminal text.
- Terminal output is escaped for WoW markup. Active agents are read from their visible viewport without scrolling; idle agents can provide recent terminal output. Empty outer viewport rows are removed without changing indentation or blank lines inside messages. Empty viewports do not create blank message rows. A recognized trailing Pi weekly-usage widget and editor/footer block are omitted from the transcript; ordinary message text, fenced examples, and other agents' output are preserved. It is not reconstructed into user/assistant messages, and alternate-screen history may be incomplete. The addon labels it as recent terminal output.
- Review/unread metadata is not durable for Herdr yet. Agent processes and their conversations remain owned by Herdr/Pi, not by the bridge; stopping the bridge does not terminate them.

## Verification of this first implementation

- Bridge suite: 58 tests passed, including Lua/Node crypto agreement under both Lua 5.1 and LuaJIT. Temporary Lua runtimes were built outside the checkout for this run.
- Addon smoke checks passed under both runtimes, including notice dismissal/stack reflow, notification mute/queue clearing, manual read-aloud preservation, empty-space filters, launch-only project choices, shell-input rejection, browse-only startup prevention, unsupported controls, pending-start deduplication and restoring a failed launch's prompt. The initial synthetic fixture needed an active-project flag to satisfy the existing project dropdown checks; the corrected fixture passed.
- The `/herdr` and legacy `/t3` commands both toggle the same window and preserve saved settings in the smoke tests. CLI alias cleanup is tested with isolated home/config/state/data directories, including preservation of unrelated symlinks with similar path prefixes. Slot TOC/XML content is unchanged by the rebrand.
- A disposable Herdr 0.8.0 session successfully launched Pi, submitted `/help` without a model request, read terminal output, and preserved the active tab. The disposable session and outer test pane were stopped/deleted afterward.
- Installed from the checkout on native macOS Forever, restarted the game, and observed the addon window showing Connected with Herdr. Status confirmed encrypted frames decoded with no rejected frames, fresh slots consumed, and no sound-fallback flag. This establishes a working native handshake, not exhaustive validation of every bell/reload/sound case.
- A live Herdr topology check matched all 7 spaces and 12 tabs/panes, across Pi and Codex, without granting any new launch permissions. Split panes, shell tabs, empty spaces, moves/renames/closures and lists exceeding 90 tabs are covered by fixtures.
- The new all-spaces UI needs an in-game `/reload` after installation. The final in-game New Thread/Start interaction and physical controller check remain unverified: the shared game state was changing during UI inspection, so automated input was stopped to avoid interference. The backend launch path and addon command path have been exercised separately.

To return to the original backend, run `./install.sh --backend t3`; T3's own login and service requirements apply. Herdr projects remain in configuration but are unused. Uninstalling this addon/bridge does not close Herdr tabs or delete Pi conversations.
