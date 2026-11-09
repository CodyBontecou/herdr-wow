# macOS and multi-agent portability audit

Audited checkout: `305af2a`. This is an implementation audit and migration proposal, not a claim that macOS or alternative agents already work. No runtime code was changed, no agents were launched, and no game installation was modified.

## Summary

The fork is a good base. Keep the WoW UI and the encrypted pixel/slot/bell transport. Separate the bridge into a host-platform layer and an agent-backend layer. Omarchy is not fundamental to the design; T3 Code currently is fundamental to the bridge's data model, but can become an optional backend.

The two largest uncertainties are native macOS game file/sound behavior and session ownership across agent tools. Resolve those before polishing branding or building every integration.

Recommended first usable target: **native macOS + one bridge-owned Pi RPC session**, with configured project directories, send/reply/stop, tracker updates, and restart/resume. Add Codex app-server next and Claude Code after that. Keep T3 and Linux implementations available behind the same interfaces.

## 1. What is reusable

| Area | Assessment | Evidence |
| --- | --- | --- |
| Window, tracker, transcript, controller navigation, notices | Mostly backend-neutral views of compact snapshots; preserve them | [`Store.lua`](../addon/T3Code/Core/Store.lua), [`UI/`](../addon/T3Code/UI/) |
| Pixel encoding and authentication | Node/Lua algorithms, not an Omarchy dependency | [`codec.js`](../bridge/src/codec.js), [`strip-crypto.js`](../bridge/src/strip-crypto.js), [`Transport.lua`](../addon/T3Code/Core/Transport.lua), [`Crypto.lua`](../addon/T3Code/Core/Crypto.lua) |
| Slot serialization, installation and bell rotation | Ordinary filesystem operations; portability depends on what the native game actually reloads | [`slots.js`](../bridge/src/slots.js), [`luaser.js`](../bridge/src/luaser.js), [architecture](ARCHITECTURE.md) |
| Pacing, snapshot budgets, acknowledgments | Valuable transport logic independent of which agent does the work | [`bridge.js`](../bridge/src/bridge.js): `onFrame`, `schedulePublish`, `buildSnapshot`, publishing methods |
| WoW markup and speech formatting | Reusable | [`format.js`](../bridge/src/format.js) |
| Node runtime | Bridge package has no npm dependencies and specifies Node >=22 | [`package.json`](../bridge/package.json) |

This audit does **not** establish compatibility with Retail or Classic. The repo targets Forever, TOC `16001`, `_forever_`, and specific Blizzard templates/APIs. Changing the OS and changing the game flavor are separate projects. See [`wow.js`](../bridge/src/wow.js), [`slots.js`](../bridge/src/slots.js), and [`T3Code.toc`](../addon/T3Code/T3Code.toc).

## 2. Omarchy/Linux coupling and macOS replacements

| Dependency | Current behavior | Proposed macOS path | Priority |
| --- | --- | --- | --- |
| Game installation discovery | Scans Wine/Proton prefixes and Windows Battle.net records | Support native app locations and explicit flavor directory; keep `--wow` | Required |
| Game process detection | Reads `/proc`, matches `_forever_/Wow.exe` | Native process identity with PID plus process start time, tied to selected installation | Required |
| Strip capture | Hyprland IPC + `grim`; X11 `import`; PPM parsing | Native capture helper returning lossless pixels and window metadata | Required |
| Service management | Writes systemd user unit and calls `systemctl` | Foreground initially; per-user LaunchAgent later | Optional for first prototype |
| Speech | Configurable stdin command, otherwise `spd-say`/espeak | Native `say` adapter; retain custom command and game voice fallback | Optional |
| Dictation | Omarchy + `wl-paste`, or Linux audio recorders + Voxtype | Recording/transcription adapter returning text directly | Optional; important for controller-only input |
| Usage | Reads Omarchy usage JSON and merges with T3 provider limits | Optional backend usage; show unavailable honestly | Optional |
| Config/state/data | XDG paths under the user's home | Can retain XDG paths initially; changing to Library directories requires migration | Not a functional blocker |

Sources: [`wow.js`](../bridge/src/wow.js): `candidateRoots`, `findWowInstalls`, `findWowProcess`; [`capture.js`](../bridge/src/capture.js): `resolveBackend`, `grab`, `screenshot`; [`voice.js`](../bridge/src/voice.js); [`usage.js`](../bridge/src/usage.js); [`t3code-wow.js`](../bridge/bin/t3code-wow.js): install/uninstall/env commands; [`install.sh`](../install.sh).

### The hidden macOS blocker: process detection

Passing `--wow` only bypasses installation discovery. It does not make the bridge functional on macOS. `findWowProcess()` returns null when `/proc` is unavailable, and `Bridge.captureLoop()` never polls without a process. Adding a capture backend alone is therefore insufficient. Process identity also drives signal resets on game restart; replacing it with a boolean or PID-only lookup loses an existing correctness property.

### Capture design

Use a small native helper behind the existing `StripCapture` contract. Prefer a persistent ScreenCaptureKit-based helper for production, subject to a measured spike. Return `{width, height, pixels}` in a known raw format, or PPM compatible with the existing decoder. Keep image attachments as a separate JPEG/PNG operation. ScreenCaptureKit is a proposed implementation, not a verified integration in this audit.

The installed macOS `screencapture(1)` documents non-interactive window (`-l`) and rectangle (`-R`) capture. That makes it a possible proof-of-concept, but it does not establish acceptable polling performance, permission behavior, output pixel fidelity, or hidden-window support. Its normal image formats also do not directly satisfy the existing PPM parser. Do not use repeated full-screen JPEGs for decoding the strip.

Measure:

- Screen Recording permission granted, denied, and revoked; ensure failures are explained rather than reported as an idle link.
- The identity receiving permission when run from a terminal versus a LaunchAgent/helper; do not assume foreground authorization transfers.
- Retina physical pixels versus logical window coordinates, content origin versus title bar/shadow, UI scaling, and mixed-DPI monitors.
- Multiple game windows, movement/resizing, fullscreen Spaces, focus changes, obscured windows, and minimized windows.
- Color conversion/HDR effects on the decoder, capture latency, and idle CPU use.

No accessibility permission or input injection should be needed for a capture-only design; avoid introducing either without a demonstrated requirement. Follow Apple’s [ScreenCaptureKit documentation](https://developer.apple.com/documentation/screencapturekit) during the implementation spike; native API details were not verified here.

### Native client transport must be measured

The repo's slot and bell observations were made on Forever under Wine/Proton. Do not assume the native client has identical sound caching and file-indexing behavior. Verify startup discovery, once-per-session slot loads, changed Lua loading, long WAV rereads, `C_Sound.IsPlaying`, `/reload`, game restart, and sound-disabled fallback. The timer fallback still depends on slots reading fresh data; it cannot rescue a broken slot channel.

Preserve slot TOC/XML bytes and addon folder names during the first port. Their layout is deliberately tied to addon-manager fingerprinting. See [AGENTS.md](../AGENTS.md) and [`SlotBank.slotToc/slotXml`](../bridge/src/slots.js).

## 3. T3 coupling is larger than one API client

The following all need attention:

- [`t3.js`](../bridge/src/t3.js): T3 discovery, authentication, Effect WebSocket RPC, subscriptions, bounded projections, thread lifecycle and image upload.
- [`auth.js`](../bridge/src/auth.js): minting and renewing scoped T3 sessions.
- [`fleet.js`](../bridge/src/fleet.js): unconditionally constructs local and remote `T3Client` instances; its public interface is a useful starting point, but its internals are not provider-neutral.
- [`envs.js`](../bridge/src/envs.js): T3 environment discovery and SSH-based token issuance/revocation, not generic remote-agent discovery.
- [`bridge.js`](../bridge/src/bridge.js): imports T3 status rules and directly interprets `runs`, `turnItems`, `runtimeRequests`, `modelSelection`, settled overrides, provider configs and `_env` throughout activity, approvals, notices, speech and snapshots.
- [`t3code-wow.js`](../bridge/bin/t3code-wow.js): install requires `t3` and a token even with `--no-service`; status, uninstall and environment management assume T3.
- [`Transcript.lua`](../addon/T3Code/UI/Transcript.lua): unconditionally offers T3-style approval decisions, including session and sometimes persistent approval.
- [`tools/snapshot.mjs`](../tools/snapshot.mjs): starts the real T3 client; development fixtures should not require that backend.

A cosmetic rename of `this.t3`, or having every adapter synthesize T3's entire schema, would preserve the wrong dependency. Normalize each backend into a small shared model before the bridge builds the WoW snapshot.

## 4. Agent integration options

### Pi: strongest first integration for this fork

Pi documents a long-lived JSONL subprocess interface: `pi --mode rpc`. It supports prompting with images, steering, follow-ups, abort, state/messages, session switching, and session statistics. Extension dialogs have a separate request/response channel that can map to in-game questions. Sources: [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md), [extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md); installed copies of these docs were inspected.

Start one managed process per active session with an explicit project working directory and persistent session storage. `--no-session` is useful for protocol experiments, not the desired persistent product. Cache normalized transcripts/status and keep a registry of owned session files for resume.

Important semantic details from the current installed documentation:

- Prompt acceptance is not run completion. In this version, wait for `agent_settled`, not just `agent_end`, before announcing completion; version-test this behavior.
- Busy prompts need explicit steering/follow-up behavior.
- To stop without later queued work restarting, account for `clear_queue` as well as `abort`.
- Supported extension dialogs can be rendered; arbitrary custom TUI components cannot.
- Extension confirmation is not evidence of a universal built-in permission/sandbox system. Do not advertise generic tool approvals without a real enforcing extension/policy.

Prefer raw subprocess RPC to preserve the repo's dependency-free bridge. An SDK integration is another option if adding a package dependency is acceptable.

### Codex: app-server, not terminal scraping

The installed `codex-cli 0.167.0` exposes `codex app-server`, default stdio transport, and schema generation. Generated schemas confirm `thread/start`, `thread/list`, `thread/read`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, and server-originated approval/question requests. Source: installed CLI help and `codex app-server generate-json-schema`; upstream [app-server source/docs](https://github.com/openai/codex/tree/main/codex-rs/app-server).

This is a good fit for persistent thread/event management. Generate fixtures and schemas from the supported installed release, rather than assuming upstream main matches it. Translate native request IDs and supported approval decisions explicitly. Configure project roots and preserve sandbox/approval policy; do not copy the existing T3 launch default of `full-access`.

Codex is also the candidate worth investigating first if controlling pre-existing sessions is essential. The installed CLI includes daemon/proxy tooling, but neither schema presence nor session listing proves that an independently launched TUI's live turn is controllable through a separate server. Validate shared-server routing and ownership before promising it.

### Claude Code: prefer the Agent SDK for full interaction

The installed `Claude Code 2.1.319` CLI advertises streaming JSON input/output, partial output, session resume, and host-directed permission prompts. These are integration surfaces, not a complete protocol specification.

For full bidirectional approvals and interruptions, prefer Anthropic's Agent SDK rather than reverse-engineering hidden CLI control messages. The official [TypeScript SDK repository](https://github.com/anthropics/claude-agent-sdk-typescript) documents the package; the official [Python SDK types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py) expose permission callbacks, allow/deny results, session resume and partial messages. Python types establish capabilities, not exact TypeScript signatures; verify the selected TS package before implementation.

This creates a deliberate dependency choice: allow the official JS SDK as an optional backend dependency, or isolate it in an optional helper process. Keep core transport dependency-free if desired. A minimal print/resume CLI adapter can be a limited first step, but should not claim full interactive permission handling from streaming flags alone.

The hosted Claude SDK documentation returned HTTP 403 during this audit; detailed TS approval/image/auth behavior remains an implementation verification item. In particular, do not assume an SDK has identical subscription/authentication terms to an interactive CLI just because that CLI is logged in.

### Managed sessions versus existing terminal sessions

For all three backends, distinguish:

1. **Bridge-owned session:** the bridge starts the runtime and owns its events, input and permission callbacks. Recommended first scope.
2. **Resume/import:** the bridge opens a saved session after its former owner stops. Enforce single-writer ownership and explain resume/fork behavior.
3. **Live attachment:** another TUI is currently running the agent. Requires an explicit integration in that runtime or a supported shared service; saved JSONL files do not provide a control channel.

Do not scrape terminal output or inject terminal keystrokes as the primary architecture. Do not concurrently write session files or silently fork a user's conversation.

## 5. Proposed boundaries

```text
WoW UI / encrypted strip / slots / bells
                    |
             Bridge coordinator
            /                  
HostPlatform                    AgentRegistry
- discover installation         - configured projects/backends
- process identity              - globally unique session IDs
- capture strip/window          - session ownership and resume
- optional speech/dictation     - normalized session state/events
- optional service management   - capability-checked commands
                                 |
                         T3 | Pi RPC | Codex | Claude SDK
```

A shared session model should include stable ID, backend/machine, project ID, title, working/input/failed/idle state, activity label, timestamps, messages, pending interaction and supported capabilities. Keep rich tool events optional; not every backend has a native plan or the same run summary.

Use configured, allowlisted project directories; do not accept arbitrary shell commands or working directories from the game. Configure backend/model/policy out of game initially. In-game thread creation should select a configured project/backend combination.

Keep review metadata (`visited`, `settled`, `archived`) separate from execution state. Implement it in bridge-owned persistence when a backend lacks matching native semantics; never implement "settle" by terminating an agent. Track unread status per completion/visit, rather than requiring T3's timestamps.

Capabilities should cover at least images, stop, steer, queued follow-ups, questions, approval decisions, plans, usage and resume. Expose supported approval choices per request, not a global trio of Approve/Session/Always. Addon controls and bridge dispatch must both enforce capabilities. Missing usage should be unavailable, not invented account quota or zero consumption.

Keep compatibility fields such as `bridge.t3` temporarily if that avoids unnecessary UI churn; do not let those field names dictate the internal model. Delay renaming `T3Code`, SavedVariables, slot folders and commands until after functional portability.

## 6. Safety and lifecycle requirements

- Preserve authenticated encrypted commands, file-local addon keys, safe Lua serialization, WoW escaping and sequence/command deduplication.
- Do not add game memory access, network access inside Lua, key injection, or a different transport without live measurements.
- Preserve controller/combat/taint rules and bell counters; these are not platform cleanup opportunities.
- Preserve backend permission/sandbox policy. Explicitly reject stale approval IDs and unsupported approval scopes; never broaden an approval during translation.
- Treat project configuration and custom executable commands as trusted desktop configuration, never model/game-supplied shell snippets. Spawn agents with executable/argument arrays and a fixed cwd.
- Persist owned session identity and review metadata; reconcile running state after bridge/helper crashes. Do not announce every recovered session as newly completed.
- Existing `onFrame` marks command IDs handled before asynchronous execution, and invokes commands without awaiting them. This is not a durable exactly-once execution guarantee. Add per-session ordering and backend idempotency/reconciliation where available; do not blindly replay uncertain agent launches after a crash. Source: [`bridge.js`](../bridge/src/bridge.js): `onFrame`, `runCommand`.
- Screenshot attachments must target the selected backend/machine and follow its image support and retention limits. The current `takeShots` removes pending images before upload; define failure/retry behavior when generalizing it.
- Defer generic remote-machine support. Existing Tailscale/SSH code provisions T3 specifically; any replacement needs a separately authenticated agent-host service or controlled SSH transport.

## 7. Staged plan and acceptance evidence

| Stage | Work | Exit evidence |
| --- | --- | --- |
| 0: native feasibility | Explicit game path, native process detection, lossless capture spike; minimal temporary transport exercise | In native Forever, authenticated hello/command round trip; fresh slot reads; bell rotation; sound-off fallback; `/reload` and full restart verified |
| 1: platform boundary | Inject host services; retain Linux implementation; macOS foreground run; optional voice/usage | Fixture tests for process identity, pixel scaling and permission errors; native capture stable after move/resize; Linux contract tests preserved |
| 2: backend boundary | Normalize T3 into shared model; inject registry; capability-aware commands and UI | Existing T3 flows remain equivalent; synthetic backend renders snapshots without running T3; unsupported actions rejected |
| 3: Pi vertical slice | Managed RPC sessions, configured projects, transcript/status, follow-up, stop, persistence | Start from game, receive streamed reply, send busy follow-up, stop without restarting queue, resume after bridge restart; no T3 installed/running |
| 4: Codex | Version-pinned app-server adapter; native permission/question mapping; image inputs | Same backend contract suite plus allow/deny, stale request rejection, interruption, resume and attachment tests |
| 5: Claude | Optional SDK integration and explicit auth/dependency policy | Same contract suite, with real bidirectional permission handling and reconnect/resume behavior demonstrated |
| 6: productization | LaunchAgent, permission onboarding, native speech/dictation, diagnostics, docs/branding | Fresh install/uninstall and denied-permission paths verified; controller input checked; screenshots/recording attached to review, not committed |

Stage 0 is the first milestone, not a general multi-provider rewrite. If native file/sound behavior invalidates the transport, stop and reassess before building backends. Voice, account quota, multi-machine aggregation, arbitrary active-terminal attachment and other WoW flavors are not MVP requirements.

Relative scope: macOS foreground support is medium but contains the highest feasibility risk; backend normalization plus Pi is medium-to-large; Codex and Claude each add meaningful lifecycle/permission work. Full parity across all tools and existing live terminals is a substantially larger project. These are scope assessments, not delivery estimates.

## 8. Verification performed and gaps

- Read repository architecture, contributing/security constraints, bridge modules, addon store/UI command paths and tests.
- Confirmed this host has a native `_forever_` installation under the standard macOS applications location. This is filesystem evidence only; no game launch or live protocol check was performed.
- Inspected installed Pi RPC documentation, Codex and Claude CLI help, generated Codex schemas in a temporary directory, and first-party upstream Codex/Claude sources. Did not invoke paid agent runs or inspect credentials/session contents.
- Ran `cd bridge && npm test` once: **33 tests, 28 passed, 4 failed, 1 skipped**. All four failures report missing `lua5.1` (`ENOENT`). The explicit skip is Lua encoder agreement; Lua crypto tests are dynamically omitted entirely when neither Lua runtime is found. Thus this run does not validate Lua/Node crypto agreement.
- Bridge test constructors use temporary `stateDir` values. No real bridge or installer was started.
- No live UI verification, native game transport verification, ScreenCaptureKit prototype, or end-to-end provider integration was performed. Install Lua 5.1 and LuaJIT in the development environment before treating the full suite as a baseline.

## Decision needed before implementation

Is the first release for **sessions started/owned by this bridge**, or must it control **agents already running in existing terminals**? The former supports a small, defensible macOS + Pi first milestone. The latter requires a runtime-attachment investigation before finalizing the backend design.
