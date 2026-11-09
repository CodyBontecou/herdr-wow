# Architecture

```
 WoW: Forever (Wine)                                   t3code-wow bridge (Node, user service)
 ┌──────────────────────────────┐   pixels   ┌────────────────────────────────────────┐
 │ T3Code addon                 │──────────▶│ capture.js  grim / import, decode strip │
 │  Transport.lua  strip, queue │            │ bridge.js   commands, pacing, snapshots │
 │  Store.lua      snapshot     │◀──────────│ slots.js    Inbox.lua into T3Code_S###  │
 │  UI/*           window,      │   files    │             Signals/NNNNN.wav           │
 │                 tracker, pad │            │ t3.js       WebSocket RPC to T3 Code ───┼──▶ T3 Code server
 └──────────────────────────────┘            │ voice.js    speech, dictation           │
                                              └────────────────────────────────────────┘
```

## Display brand and compatibility

The visible addon is **Herdr**, with `/herdr` and the `herdr-wow` CLI. `/t3`, `/t3code` and `t3code-wow` remain aliases. Internal folder/global names (`T3Code`, `T3CodeDB`, `T3Code_S###`), binding IDs, existing config/state/data/service paths and slot TOC/XML bytes deliberately remain unchanged. Existing keys, preferences, bindings and the addon-manager fingerprint layout therefore do not require a migration. T3 Code references in the backend/API sections below refer to the optional original backend, not the display brand.

## Constraints this is built around

Measured on live Forever 1.60.1 clients (TOC 16001) by
[wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) and
[wow-ai](https://github.com/chelinho139/wow-ai). The approach here builds on that work:

1. Addons can't use sockets or read files. They can draw pixels.
2. The client indexes addon files **at launch**. Files that exist then can be loaded
   later. `LoadAddOn` reads a load-on-demand addon's Lua from disk when it loads, and
   each addon loads once per UI session (`/reload` resets that). New files need a
   full restart.
3. `PlaySoundFile` returns whether a file will play. A file that has never loaded is
   read fresh every time. Once one plays, the result is cached until the process exits.
4. SavedVariables are only written on `/reload` or logout, and `ReloadUI()` needs a
   key press or click.

## Game → bridge: the strip

`Codec.lua` and `codec.js` share one frame format:

```
'T' '3' version  seq(2)  len(2)  payload…  fletcher16(2)
```

**Encryption.** The strip is on screen, so streams and recordings capture it. Version 2
frames (all of them, once the addon has its keys) carry

```
nonce(12)  ChaCha20(records)  HMAC-SHA-256(version, seq, nonce, ciphertext)[0..8]
```

- The bridge makes a random master key per install (`~/.local/state/t3code-wow/strip.key`,
  mode 0600) and derives an encryption key and a MAC key from it. Both go into every
  snapshot it writes to the slots. Slot files are never on screen.
- The addon keeps the keys in file-local variables in `Transport.lua`. They aren't on
  the exported `T3Code` table and aren't saved. The slot global is cleared on load.
- Nonces are a per-load prefix (time and random bytes) plus a counter, and a frame is
  re-sealed only when its content changes.
- Version 1 (plaintext) frames are only ever a bare hello with no thread id. The addon
  sends one before it has keys, and the bridge answers it with a snapshot carrying
  them. The bridge never runs commands from a plaintext frame and drops any encrypted
  frame that fails the tag.
- Replays are harmless: the bridge only runs command ids above the last one it ran
  for that session.
- `Crypto.lua` implements ChaCha20 and SHA-256 on the client's `bit` library; the bridge
  uses Node's. `bridge/test/crypto.test.js` checks they agree under both signed (LuaJIT)
  and unsigned (WoW-style) `bit` results, and that a strip the addon draws decrypts only
  with the right keys. Cost in game: about 0.2 ms per frame, a few ms for a full
  2,000-character message.

This keeps out viewers and anything else that can draw on the screen. It can't stop
another addon in the same game: addons share one Lua state, so a malicious addon could
drive T3 Code's UI directly. Only install addons you trust.

The frame is packed into 3-bit cells. Each cell is a 3×3-pixel square with R, G and B
each fully on or off. The strip is 160 cells per row and up to 40 rows (about 2.4 KB),
scaled so one UI unit is one physical pixel. It is anchored at the top-left of
`UIParent` on the TOOLTIP strata. The bridge searches cell sizes 2–8 and small offsets,
so a border or scaling quirk doesn't break it.

The payload is records separated by `RS` (0x1E), with fields separated by `US` (0x1F):

```
H  1  session  ui  nextSlot  sigNext  gen  flags  viewThreadId  addonVersion
C  id  verb  args…                      (one per queued command)
```

- `session` is persistent (SavedVariables). `ui` is new every load, so the bridge can
  tell a `/reload` happened.
- `flags`:
  - `o`: window open
  - `t`: tracker on
  - `g`: gamepad UI
  - `r`: read finished replies with the desktop voice
  - `s`: sound signals unavailable
- Verbs:
  - `send`, `new`, `stop`
  - `settle`, `unsettle`, `archive`, `read`
  - `closeThread` (Herdr only; thread ID and selected tab ID)
  - `approve`, `answer`
  - `speak`, `say`, `hush`, `dictate`
  - `ping`

The strip is drawn only while something is unacknowledged. "Something" means a status
change such as opening the window or switching threads, or a queued command. It is
redrawn when content changes and hidden as soon as a snapshot acknowledges its
sequence number, usually in under a second. If nothing answers for 20 s, it hides and
retries with backoff.

## Bridge → game: slots and signals

`T3Code_S001…S1200` (1,200 by default) are load-on-demand addons grouped under T3Code in
the addon list (`## Group`). They deliberately have no `## Dependencies`: WowUp hides
an unrecognised load-on-demand folder only when all its dependencies are recognised, and
T3Code isn't on CurseForge, so a dependency on it made every slot its own "Unknown" row
(1,200 rows, measured with WowUp 2.24). Without it WowUp shows one "T3 Code" entry.

Addon managers also fingerprint each folder (a 32-bit hash of the `.toc` and the files it
lists) and look it up across all of CurseForge. A slot that listed `Inbox.lua` directly
produced a fresh hash with every update, and one collided: WowUp took a slot for a
Minecraft modpack, which an "update" would have installed over it. So every slot's TOC is
identical and lists a static `Slot.xml`, which loads `Inbox.lua` with
`<Script file="Inbox.lua"></Script>`. The scanners only follow self-closing `<Script/>`
tags, so all slots share one fixed fingerprint that matches nothing on CurseForge
(checked with WowUp's own hashing code and a rescan).
Each contains `Inbox.lua`, which assigns `T3Code_Inbox = { … }`. The bridge serializes
plain data with `luaser.js`, so thread text can never become code. All text is escaped
for WoW markup (`|` → `||`), then markdown is turned into colors and bullets.

A publish works like this:

1. Build the snapshot: threads, projects, the viewed thread's messages, pending
   question or approval, usage, bridge status, command results and the ack.
2. Write it to the slots the addon will load next (from its last confirmed position
   to a little past the bridge's prediction) and to slots 1–3 (what a `/reload`
   bootstraps from).
3. Ring the next **bell**.

**Bells (the "new update" signal).** Measured on this client:

- `PlaySoundFile` returns `willPlay = true` for *every* file, even empty or garbage
  ones, so its answer is useless.
- `C_Sound.IsPlaying(handle)` a fraction of a second later is reliable: real sounds
  play and empty files don't.
- Sound files bigger than `Sound_MaxCacheableSizeInBytes` (174,762 bytes here) are
  streamed and re-opened from disk on every play (confirmed by watching file
  access), so they're never stuck in the cache.

So a bell is a 10-second silent WAV (441 KB), and those ten files are all of `Signals/`. The bridge rings bell `k` by writing
that sound and empties bell `k-4`. The addon plays bells `sigNext … sigNext+3` every
0.5 s, checks which is really playing 0.15 s later, stops them all, and loads one slot
if one rang. Eight bells rotate forever, with no per-session limit. They live at
`Signals/03991–03998.wav`; `03999` (always long) and `04000` (always empty) are the
self-test controls. These names already existed when the client started, which
matters because the client only knows files that existed at launch.

If game sound is entirely off, the self-test fails and the addon falls back to
loading a slot on a timer (3 s while you're using the window, 20 s open, 90 s closed).

Measured in game: a 1.2 s round trip from strip to update, 1 slot per 2 idle minutes
with the window closed, and 2 per minute with it open.

**Pacing.** Each publish costs one slot, so the bridge paces by what you're doing:

| Situation | Interval |
| --- | --- |
| Acks and command results | ~0.5 s |
| Viewing a working thread | 2 s |
| Window open | 1.5–3 s |
| Window closed, status changes | 3 s |
| Window closed, minor changes | 20 s |
| Heartbeat (window open / closed) | 90 s / 240 s |

When few slots remain, intervals stretch 2–4×. When they run out, the addon offers
`/reload`.

## T3 Code side

`t3.js` uses the same API as T3's own clients:

- **Auth:** a session token from `t3 auth session issue --scope orchestration:read
  --scope orchestration:operate`, renewed a week before it expires.
- **Live data:** `POST /api/auth/websocket-ticket/rpc` gets a ticket, then
  `/ws?orchestrationProtocol=2` opens Effect RPC JSON frames.
- **Subscriptions:** `orchestration.subscribeShell` (thread list, live) and
  `subscribeServerConfig` (providers and usage limits).
- **Thread detail:** `GET /api/orchestration/threads/:id/bounded`, fetched for the
  viewed thread and for active threads so the tracker can say what they're doing.
- **Writes:** `orchestration.dispatchCommand` with `message.dispatch`, `run.interrupt`,
  `runtime-request.respond`, `thread.settle`, `thread.unsettle` and `thread.visit`;
  plus `orchestration.launchThread`.

## Optional Herdr backend and native macOS capture

With `backend: "herdr"`, `herdr.js` replaces the T3 fleet. Configured project IDs map to allowlisted canonical directories and existing Herdr workspaces in one selected Herdr session. New threads create unfocused tabs and start a fresh Pi session. Task-form launches then submit the initial prompt; new-tab shortcut launches leave Pi ready for input without submitting a prompt. The shortcut selects a configured launch project in the selected space and falls back to the project/task form when none is configured. Discovery reads one Herdr topology snapshot for all spaces, tabs, panes and agent kinds in the selected session. Spaces become browse filters; tabs become rows, with separate numbered rows for split panes. Empty spaces remain visible. Launch projects are separate, so discovery never authorizes new working directories. Ordinary terminals and unsupported agent kinds are read-only; idle Pi/Codex/Claude Code agents may receive prompts through Herdr. Only the viewed tab's terminal output is fetched. Thread display state is shared through `thread-state.js`; terminal output is a separate projection field, not fabricated T3 tool/run history. The bridge retains its compact snapshot format, including the legacy `bridge.t3` connection field for compatibility, and adds backend/capability metadata.

Herdr tab closing uses the opt-in `closeThread` capability and closes immediately from the close-thread shortcut, terminating every pane and process in a split tab. The command carries the selected tab ID as well as the thread ID; the bridge rechecks the live terminal/session identity and tab membership before calling `herdr tab close` in the configured session. This check and close are not atomic, so concurrent desktop changes can still race the operation. An uncertain close is never automatically retried by the adapter. Closing is distinct from archiving or interrupting and is not enabled for the T3 backend.

For Pi, the bridge may read the exact JSONL session path reported by Herdr, restricted to the canonical local Pi sessions directory, a matching session cwd, supported session versions and files up to 32 MiB. It follows parent IDs from the last saved entry rather than mixing alternate branches, ignores system messages, signatures and extension state, and projects user/text/thinking/code/tool blocks. Tool results attach to their matching call IDs. Persisted messages are not a live streaming API, and moving the in-memory tree cursor without saving an entry is not reflected. Missing, unsupported, oversized or invalid sessions fall back to the terminal view. Only the viewed session is read; no directory search guesses a session from cwd. Block previews and bounded full text share the existing snapshot character budget. Syntax colors are generated in Node with literal WoW escapes preserved; the addon supplies native card backgrounds, a bundled OFL monospaced font and local expand/collapse controls. No input permissions or slot manifests change.

Herdr does not supply structured questions, approvals, images, steering or in-game interruption through this adapter. For narrowly recognized Codex and Claude Code question screens, the bridge projects explicit terminal key controls as `terminal-question` pending data, not fabricated T3 runtime requests. Answers carry either one allowlisted key or single-line text, are tied to a single-use screen ID, and recheck terminal/session identity and the exact visible screen before writing. Text entry never appends Enter. Opening Codex's collapsed queue checks the opener and question count rather than unrelated animated output; it cannot submit an answer. Unknown layouts and approvals stay desktop-only. These are non-atomic terminal controls; another desktop user or the agent can still change the screen between the check and the write. Addon controls and bridge dispatch reject unsupported operations. Terminal reads are escaped and explicitly labeled as recent terminal output. Commands execute serially so an asynchronous launch cannot be overtaken by a later command. The original authenticated strip, slots, manifest bytes, bell sequence and pacing are unchanged.

On macOS, `wow.js` discovers native Forever installations and identifies the selected process through `ps` with a start-time identity. Installation builds `bridge/native/mac-capture.swift` with Xcode tools. The ScreenCaptureKit helper captures lossless sRGB pixels for the strip and JPEG for screenshots, subject to Screen Recording permission. The bridge runs in the foreground on macOS; Linux retains its systemd installation. See [HERDR.md](HERDR.md) for setup and limitations. Native game transport behavior must still be verified in game; Wine measurements above are not automatically macOS guarantees.

## Notification controls

The saved `notifications` master preference gates popups, notice sounds, chat transition notices and automatic read-aloud. Turning it off hides active notices, cancels their timers and clears the addon's combat queue; individual popup/sound/read-aloud preferences remain unchanged. Every popup has a child close button that dismisses only that notice, while its body still opens the associated thread. Closing a notice reflows the stack.

The existing `r` flag is only sent while notifications and desktop automatic read-aloud are enabled. Removing it clears deferred bridge announcements. Announcements also re-check flags after asynchronous detail fetches, so disabling notifications during a fetch cannot start a new automatic read afterward. Manual speech commands, agent status updates and silent transport bells are unaffected. `/t3 notifications on|off` and the Settings checkbox use the same control path.

## Controller

While the window is open it takes the gamepad itself (`EnableGamePadButton` /
`EnableGamePadStick`), so the character doesn't move and B closes the window. The D-pad
moves between controls by position, with explicit routes where position isn't enough
(thread list → message box, for example). Blizzard's `SmartNavigationPointerTemplate`
draws the cursor.

The addon never touches the binding-group APIs, which would taint the gamepad action
bars, and avoids Blizzard's `Menu` (it caused "blocked action" errors). LB/RB switch
tabs, X reads aloud, Y dictates, and the right stick scrolls the transcript. Forever has
no on-screen keyboard, so text input uses dictation, quick replies and option buttons.
The game menu gets a T3 Code button, and a controller chord opens the window.
