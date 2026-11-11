-- Headless smoke test: load the addon against tools/wowstub.lua and drive it.
--   lua5.1 tools/smoke.lua <addon dir> <snapshot.lua> [viewId]
local addonDir, snapshot, viewId = arg[1], arg[2], arg[3]
package.path = "./tools/?.lua;" .. package.path
local Stub = dofile("tools/wowstub.lua")
Stub.slotData.default = snapshot

local function check(cond, msg)
	if not cond then for _, e in ipairs(T3Code and T3Code.errors or {}) do print("RECORDED ERROR: " .. e.msg) end error("CHECK FAILED: " .. msg, 2) end
	print("ok - " .. msg)
end

-- Load files in TOC order.
local ns = {}
for line in io.lines(addonDir .. "/T3Code.toc") do
	line = line:gsub("\r", "")
	if line ~= "" and not line:match("^#") and line:match("%.lua$") then
		local path = addonDir .. "/" .. line:gsub("\\", "/")
		local chunk = assert(loadfile(path))
		chunk("T3Code", ns)
	end
end
check(T3Code == ns, "namespace exported")

Stub.Fire("ADDON_LOADED", "T3Code")
check(ns.db and ns.db.session and #ns.db.session == 8, "saved variables initialised")
Stub.Fire("PLAYER_LOGIN")
check(ns.Transport.slotCount == 600, "found 600 slots by binary search")
check(ns.Store.applied == 1, "bootstrap slot applied")
check(#ns.Store.data.threads > 0, "threads loaded: " .. #ns.Store.data.threads)
check(ns.Transport.stripShown, "hello strip shown")
check(ns.Transport:Encrypted(), "link keys loaded from the bootstrap slot")
check(T3Code_Inbox == nil, "slot global cleared after loading")
do
	local drawn = WOWSTUB.StripCells()
	-- Header byte 3 (version) spans cells 6..8: bits 16..23 of the frame.
	local bits = {}
	for i = 1, 9 do local v = drawn[i] bits[#bits + 1] = math.floor(v / 4) % 2 bits[#bits + 1] = math.floor(v / 2) % 2 bits[#bits + 1] = v % 2 end
	local version = 0
	for i = 17, 24 do version = version * 2 + bits[i] end
	check(version == 2, "strip is drawn encrypted (frame version 2)")
end
local payload = ns.Transport:Payload()
check(payload:sub(1, 2) == "H\031", "payload starts with hello record")

-- Strip encodes within capacity and the cells are valid.
local cells = ns.Codec.Encode(ns.Transport.stripSeq, payload)
check(#cells > 0, "strip cells: " .. #cells)

-- Simulate the bridge acknowledging the hello via the next slot.
Stub.validSounds = {}
ns.Transport.signals = "ok"
local sig = ns.db.sigNext
-- Patch the snapshot's ack to this UI session.
local chunk = assert(loadfile(snapshot))
chunk()
local data = T3Code_Inbox
T3Code_Inbox = nil
data.ack = { ui = ns.ui, seq = ns.Transport.stripSeq }
data.gen = data.gen + 1
data.nextSig = sig + 1
ns.Transport:Apply(data)
check(not ns.Transport.stripShown, "strip hidden after ack")

-- Open the window, select a thread, render.
ns.Main:Open()
check(ns.windowOpen, "window open")
check(ns.Transport.stripShown, "window open bumps the strip")
local firstThread = ns.Store.data.threads[1]
ns.Main:SelectThread(viewId ~= "" and viewId or firstThread.id)
check(ns.viewId ~= nil, "thread selected")
ns.Store:Apply(data) -- view arrives
local rows = ns.Transcript.scrollBox._rows or {}
check(#rows > 0, "transcript rendered " .. #rows .. " elements")
local listRows = ns.ThreadList.scrollBox._rows or {}
check(#listRows > 0, "thread list rendered " .. #listRows .. " rows")

-- Structured cards expand locally without commands or losing their preview.
do
	local original = ns.Store.data.view
	local before = #ns.Transport.queue
	ns.Store.data.view = { id = ns.viewId, msgs = {
		{ id = "tool-card", r = "a", kind = "tool", label = "bash", t = "preview", full = string.rep("output line\n", 30) },
		{ id = "thought", r = "a", kind = "thinking", label = "Thinking", t = "Considering options" },
		{ id = "reply", r = "a", kind = "text", label = "Pi", t = "Done" },
	} }
	ns.Transcript:Refresh(true)
	local card, toggle
	for _, r in ipairs(ns.Transcript.scrollBox._rows) do
		if r.ed.msg and r.ed.msg.id == "tool-card" then card = r end
		if r.ed.kind == "option" and r.ed.label == "Expand output" then toggle = r end
	end
	check(card and toggle and card.frame.Body:GetText() == "preview", "tool card starts collapsed with an expand control")
	local height = card.ed.height
	toggle.ed.onClick()
	local collapse
	for _, r in ipairs(ns.Transcript.scrollBox._rows) do
		if r.ed.msg and r.ed.msg.id == "tool-card" then card = r end
		if r.ed.kind == "option" and r.ed.label == "Collapse output" then collapse = r end
	end
	check(collapse and card.ed.height > height and card.frame.Body:GetText():find("output line", 1, true), "expanding a card remeasures the full body")
	collapse.ed.onClick()
	check(not ns.Transcript.expanded["tool-card"] and #ns.Transport.queue == before, "collapse is local and sends no terminal input")
	ns.Store.data.view = original
	ns.Transcript:Refresh(true)
end

-- The focus shortcut returns to the conversation without opening a closed panel.
do
	local box = ns.Main.composer
	box:ClearFocus()
	ns.Main.frame:Hide()
	T3Code_Binding("focusInput")
	check(not ns.Main.frame:IsShown() and not box:HasFocus(), "focus input does nothing while panel is closed")
	ns.Main:Open()
	check(box:HasFocus(), "opening threads focuses the composer")
	box:ClearFocus()
	ns.Main:Refresh()
	check(not box:HasFocus(), "refresh does not steal composer focus")
	ns.Main:ShowPage("settings")
	ns.Main.frame:Hide()
	ns.Main:Open()
	check(not box:HasFocus(), "opening settings does not focus the composer")
	ns.Main:ShowPage("threads")
	check(box:HasFocus(), "returning to threads focuses the composer")
	box:ClearFocus()
	ns.Main:ShowPage("settings")
	local draft, selected = box:GetText(), ns.viewId
	T3Code_Binding("focusInput")
	check(ns.Main.page == "threads" and box:HasFocus(), "focus input returns to threads and focuses composer")
	check(box:GetText() == draft and ns.viewId == selected, "focus input preserves draft and selected thread")
	box:ClearFocus()
end

-- Fishing mode observes manual casts without opening for other channels/units.
do
	local f = ns.Main.frame
	f:Hide()
	Stub.Fire("UNIT_SPELLCAST_CHANNEL_START", "player", "cast", 7620)
	check(not f:IsShown(), "fishing does not reopen by default")
	local fishingCheck
	for _, cb in ipairs(ns.Settings.checks) do
		if cb.key == "openAfterFishingCast" then fishingCheck = cb end
	end
	fishingCheck:SetChecked(true)
	fishingCheck._scripts.OnClick(fishingCheck)
	Stub.Fire("UNIT_SPELLCAST_CHANNEL_START", "party1", "cast", 7620)
	Stub.Fire("UNIT_SPELLCAST_CHANNEL_START", "player", "cast", 12345)
	check(not f:IsShown(), "fishing ignores other players and unrelated spells")
	local oldCombat = InCombatLockdown
	_G.InCombatLockdown = function() return true end
	Stub.Fire("UNIT_SPELLCAST_CHANNEL_START", "player", "cast", 7620)
	check(not f:IsShown(), "fishing does not capture the window during combat")
	_G.InCombatLockdown = oldCombat
	local draft, selected = ns.Main.composer:GetText(), ns.viewId
	Stub.Fire("UNIT_SPELLCAST_CHANNEL_START", "player", "cast", 7620)
	check(f:IsShown() and ns.viewId == selected and ns.Main.composer:GetText() == draft, "manual fishing cast reopens without losing thread or draft")
	f:Hide()
	local oldSpell, oldCSpell = GetSpellInfo, C_Spell
	_G.C_Spell = nil
	_G.GetSpellInfo = function(id) return (id == 7620 or id == 7731) and "Localized Fishing" or "Other spell" end
	Stub.Fire("UNIT_SPELLCAST_CHANNEL_START", "player", "cast", 7731)
	check(f:IsShown(), "fishing recognizes other ranks by localized name")
	_G.GetSpellInfo, _G.C_Spell = oldSpell, oldCSpell
	f:Hide()
	SlashCmdList.T3CODE("fishing off")
	Stub.Fire("UNIT_SPELLCAST_CHANNEL_START", "player", "cast", 7620)
	check(not f:IsShown(), "fishing reopening can be disabled")
	ns.Settings:Refresh()
	check(not fishingCheck:GetChecked(), "fishing checkbox reflects slash command changes")
	ns.Main:Open()
end

-- Send a message: queued, echoed, and present in the strip payload.
ns.Main.composer._text = "Please run the tests"
ns.Main:Send()
check(#ns.Transport.queue >= 1, "command queued")
check(ns.Transport:Payload():find("Please run the tests", 1, true) ~= nil, "message in strip payload")
check(ns.Transcript.echo[ns.viewId] ~= nil, "local echo shown")

-- Pages
ns.Main:ShowPage("usage")
ns.Main:ShowPage("settings")
ns.Main:ShowPage("threads")
check(true, "pages switch")

-- New thread flow
ns.Main:StartNewThread()
check(ns.Main.mode == "new" and ns.Main.newProject ~= nil, "new thread mode with project " .. tostring(ns.Main.newProject))
ns.Main.composer._text = "Build a thing"
ns.Main:Send()
check(ns.Transport:Payload():find("\031new\031", 1, true) ~= nil, "new-thread command in payload")
ns.Transport:Apply({ gen = data.gen + 2, results = { { id = ns.Main.pendingNew, ok = true, open = firstThread.id } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
check(ns.Main.mode == "thread" and ns.viewId == firstThread.id, "result opened the new thread")
check(#ns.Transport.queue == 0, "all commands acknowledged")

-- Question / approval rendering
data.gen = data.gen + 10
data.view = data.view or { id = ns.viewId }
data.view.id = ns.viewId
data.view.pending = { id = "req1", kind = "question", questions = { { id = "q1", h = "Mode", q = "Which mode?", opts = { { l = "Fast", d = "quick", v = "fast" }, { l = "Careful", d = "slow", v = "careful" } } } } }
ns.Transport:Apply(data)
local optionRows = 0
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.ed.kind == "option" then optionRows = optionRows + 1 end end
check(optionRows >= 2, "question options rendered: " .. optionRows)
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.kind == "option" and r.ed.label == "Fast" then r.frame:Click() break end
end
check(ns.Transport:Payload():find("answer\031" .. ns.viewId .. "\031req1\031q1\031fast", 1, true) ~= nil, "answer command queued")

-- Terminal questions keep navigation separate from submitting written text.
local terminalThread = ns.Store:Thread(ns.viewId)
local previousCaps, previousStatus = terminalThread.caps, terminalThread.s
terminalThread.caps, terminalThread.s = { send = true, busySend = false, answers = true }, "input"
data.view.pending = { id = "terminal-1", kind = "terminal-question", textInput = false, actions = { { key = "down", label = "Next option" }, { key = "enter", label = "Select / submit answer" } } }
data.gen = data.gen + 1
ns.Transport:Apply(data)
check(not ns.Main.frame.Bar.Send:IsEnabled(), "question navigation does not enable ordinary busy prompts")
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.kind == "option" and r.ed.label == "Next option" then r.frame:Click() break end
end
check(ns.Transport:Payload():find("answer\031" .. ns.viewId .. "\031terminal-1\031key\031down", 1, true) ~= nil, "terminal navigation uses the answer channel")
local terminalQueue = #ns.Transport.queue
ns.Transcript:TerminalAnswer(data.view, data.view.pending, "key", "enter")
check(#ns.Transport.queue == terminalQueue, "a consumed screen cannot submit again")
data.view.pending = { id = "terminal-2", kind = "terminal-question", textInput = true, actions = { { key = "enter", label = "Select / submit answer" } } }
data.gen = data.gen + 1
ns.Transport:Apply(data)
check(ns.Main.frame.Bar.Send:IsEnabled(), "question text field enables composer while agent is blocked")
ns.Main.composer._text = "Literal answer"
ns.Main:Send()
check(ns.Transport:Payload():find("answer\031" .. ns.viewId .. "\031terminal-2\031text\031Literal answer", 1, true) ~= nil, "typed question text is not sent as an ordinary prompt or Enter")
terminalThread.caps, terminalThread.s = previousCaps, previousStatus

-- Dictation result from the bridge lands in the message box
ns.Main.composer._text = "Hello"
data.gen = data.gen + 1
data.dict = { n = os.time() * 1000, state = "done", text = "run the tests" }
ns.Transport:Apply(data)
check(ns.Main.composer._text == "Hello run the tests", "dictated text typed into the box: " .. tostring(ns.Main.composer._text))
data.gen = data.gen + 1
ns.Transport:Apply(data)
check(ns.Main.composer._text == "Hello run the tests", "same dictation not typed twice")
ns.Main.composer._text = "already pasted words"
data.gen = data.gen + 1
data.dict = { n = os.time() * 1000 + 5, state = "done", text = "pasted words" }
ns.Transport:Apply(data)
check(ns.Main.composer._text == "already pasted words", "text the backend already pasted isn't added again")
ns.Main.composer._text = ""

-- Plan, approval details, run summary, queued note
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "plan" end end
data.view = data.view or {}
data.view.id = ns.viewId
data.view.pending = nil
data.view.plan = "|cffffd100Plan|r\n• step one"
data.view.sum = "Last run: 2 commands · 4m 12s"
data.view.queued = 1
ns.Transport:Apply(data)
local found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.text then
		if r.ed.text:find("step one", 1, true) then found.plan = true end
		if r.ed.text:find("Last run", 1, true) then found.sum = true end
		if r.ed.text:find("queued", 1, true) then found.queued = true end
	end
	if r.ed.label == "Read the plan aloud" then found.readPlan = true end
end
check(found.plan and found.readPlan, "plan text shown with a read-aloud option")
check(found.sum and found.queued, "run summary and queued follow-ups shown")
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "input" end end
data.view.plan, data.view.queued = nil, nil
data.view.pending = { id = "ap1", kind = "approval", what = "Change files", detail = "", files = { { f = "a.lua", a = 12, d = 3 } }, always = true }
ns.Transport:Apply(data)
found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.text and r.ed.text:find("a.lua", 1, true) and r.ed.text:find("+12", 1, true) then found.files = true end
	if r.ed.label == "Always allow this" then found.always = r end
end
check(found.files, "approval lists the files with +/- counts")
found.always.frame:Click()
check(ns.Transport:Payload():find("approve\031" .. ns.viewId .. "\031ap1\031acceptAlways", 1, true) ~= nil, "Always allow sends acceptAlways")
data.gen = data.gen + 1
data.view.pending = nil
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "open" end end
ns.Transport:Apply(data)

-- Notices wait during combat
_G.InCombatLockdown = function() return true end
local t1 = ns.Store.data.threads[2]
ns.Toasts.held = {}
ns:Fire("ThreadTransition", t1, "working", "open")
check(#ns.Toasts.held == 1, "notice held during combat")
_G.InCombatLockdown = function() return false end
ns:Fire("Combat", false)
check(#ns.Toasts.held == 0, "held notice shown after combat")

-- Dismiss one notice without opening its thread; reflow the remaining stack.
do
	for _, frame in ipairs(ns.Toasts.frames) do frame:Hide() end
	local originalView, originalOpen = ns.viewId, ns.windowOpen
	ns.Toasts:Show(data.threads[1], "open")
	ns.Toasts:Show(data.threads[2], "open")
	local first, second = ns.Toasts.frames[1], ns.Toasts.frames[2]
	check(first.Close and first.Close:IsShown(), "notification has a close button")
	first.Close:Click()
	check(not first:IsShown() and first.timer == nil, "close dismisses the notice and cancels its timer")
	check(ns.viewId == originalView and ns.windowOpen == originalOpen, "close does not open or change the selected thread")
	check(second:IsShown() and second._points[1][5] == -120, "remaining notice moves into the first stack position")
	second:Click()
	check(ns.viewId == data.threads[2].id and not second:IsShown(), "clicking the notice body still opens its thread")
	ns.Main:SelectThread(originalView)
end

-- The master switch silences every automatic notice channel and drops queued
-- combat notices, while preserving individual preferences for re-enabling.
do
	local s = ns.db.settings
	local oldRead, oldVoice = s.autoRead, s.tts
	s.autoRead, s.tts = true, "system"
	ns.Toasts:Show(data.threads[2], "open")
	ns.Toasts.held = { { t = data.threads[2], kind = "open" } }
	local master, popup
	for _, cb in ipairs(ns.Settings.checks) do
		if cb.key == "notifications" then master = cb end
		if cb.key == "toasts" then popup = cb end
	end
	check(master ~= nil, "notification master switch is available in settings")
	master:SetChecked(false)
	master:Click()
	check(#ns.Toasts.held == 0 and not ns.Toasts:VisibleThread(), "disabling notifications clears active and queued popups")
	check(not popup:IsEnabled() and not ns.Transport:Flags():find("r", 1, true), "disabled notifications turn off dependent controls and desktop auto-read")
	local printed, sounds = #Stub.printed, #Stub.sounds
	ns:Fire("ThreadTransition", data.threads[2], "working", "open")
	_G.InCombatLockdown = function() return true end
	ns:Fire("ThreadTransition", data.threads[2], "working", "input")
	_G.InCombatLockdown = function() return false end
	ns:Fire("Combat", false)
	check(#Stub.printed == printed and #Stub.sounds == sounds and #ns.Toasts.held == 0, "disabled notifications do not print, play sounds or queue combat notices")
	master:SetChecked(true)
	master:Click()
	check(popup:IsEnabled() and s.toasts and s.sounds and s.autoRead, "re-enabling preserves individual notice preferences")
	check(ns.Transport:Flags():find("r", 1, true) ~= nil, "re-enabling restores configured desktop auto-read")
	SlashCmdList.T3CODE("notifications off")
	check(s.notifications == false, "slash command can disable notifications")
	SlashCmdList.T3CODE("notifications on")
	check(s.notifications == true and #ns.Toasts.held == 0, "slash command enables without replaying discarded notices")
	s.autoRead, s.tts = oldRead, oldVoice
end

-- The close shortcut sends immediately with the current thread and tab identity.
do
	local t = ns.Store:Thread(ns.viewId)
	local oldCaps, oldTab = t.caps, t.closeTabId
	local oldId = ns.viewId
	t.caps, t.closeTabId = { closeThread = true }, "w1:t1"
	local queued = #ns.Transport.queue
	Stub.popup = nil
	T3Code_Binding("closeThread")
	local cmd = ns.Transport.queue[#ns.Transport.queue]
	check(not Stub.popup and #ns.Transport.queue == queued + 1, "close binding sends immediately without confirmation")
	check(cmd.verb == "closeThread" and cmd.args[1] == oldId and cmd.args[2] == "w1:t1", "close binding targets the current thread and tab")
	t.closeTabId = nil
	queued = #ns.Transport.queue
	T3Code_Binding("closeThread")
	check(#ns.Transport.queue == queued, "close binding requires a tab identity")
	t.caps, t.closeTabId = nil, oldTab
	Stub.popup = nil
	T3Code_Binding("closeThread")
	check(not Stub.popup and #ns.Transport.queue == queued, "backends without explicit close support cannot close tabs")
	t.caps, t.closeTabId = oldCaps, oldTab
end

-- Import is explicit, conflict-aware, combat-safe and reversible.
do
	local oldImports = ns.importedBindings
	ns.importedBindings = {
		{ key = "ALT-CTRL-T", binding = "T3CODE_NEW" },
		{ key = "ALT-CTRL-W", binding = "T3CODE_CLOSE_THREAD" },
		{ key = "ALT-CTRL-J", binding = "T3CODE_NEXT_WORKSPACE" },
		{ key = "ALT-CTRL-K", binding = "T3CODE_PREVIOUS_WORKSPACE" },
	}
	Stub.bindings["ALT-CTRL-T"] = "TOGGLEWORLDMAP"
	local accept = StaticPopupDialogs.T3CODE_IMPORT_KEYS.OnAccept
	SlashCmdList.T3CODE("importkeys")
	local data = Stub.popup.data
	check(data.rows[1].before == "TOGGLEWORLDMAP" and GetBindingAction("ALT-CTRL-T") == "TOGGLEWORLDMAP", "import preview records conflicts without changing keys")
	local oldCombat = InCombatLockdown
	_G.InCombatLockdown = function() return true end
	accept(nil, data)
	check(GetBindingAction("ALT-CTRL-T") == "TOGGLEWORLDMAP", "import confirmation cannot change keys in combat")
	_G.InCombatLockdown = oldCombat
	Stub.bindingSet = 2
	accept(nil, data)
	check(GetBindingAction("ALT-CTRL-T") == "TOGGLEWORLDMAP", "import refuses a different active binding set")
	Stub.bindingSet = 1
	Stub.bindings["ALT-CTRL-T"] = "TOGGLEBAG1"
	accept(nil, data)
	check(GetBindingAction("ALT-CTRL-T") == "TOGGLEBAG1", "import refuses conflicts changed during confirmation")
	SlashCmdList.T3CODE("importkeys")
	data = Stub.popup.data
	Stub.failBinding = "ALT-CTRL-W"
	accept(nil, data)
	check(GetBindingAction("ALT-CTRL-T") == "TOGGLEBAG1" and GetBindingAction("ALT-CTRL-W") == "", "failed import rolls back partial changes")
	Stub.failBinding = nil
	accept(nil, data)
	check(GetBindingAction("ALT-CTRL-T") == "T3CODE_NEW" and GetBindingAction("ALT-CTRL-W") == "T3CODE_CLOSE_THREAD" and Stub.savedBindingSet == 1, "confirmed import saves the active set")
	check(GetBindingAction("ALT-CTRL-J") == "T3CODE_NEXT_WORKSPACE" and GetBindingAction("ALT-CTRL-K") == "T3CODE_PREVIOUS_WORKSPACE", "import accepts workspace shortcuts")
	local backup = ns.db.bindingImportBackup
	SlashCmdList.T3CODE("importkeys")
	check(ns.db.bindingImportBackup == backup, "repeating an unchanged import preserves undo backup")
	Stub.bindings["ALT-CTRL-T"] = "TOGGLEWORLDMAP"
	SlashCmdList.T3CODE("undokeys")
	check(GetBindingAction("ALT-CTRL-T") == "TOGGLEWORLDMAP" and ns.db.bindingImportBackup == backup, "undo does not overwrite newer user bindings")
	Stub.bindings["ALT-CTRL-T"] = "T3CODE_NEW"
	SlashCmdList.T3CODE("undokeys")
	check(GetBindingAction("ALT-CTRL-T") == "TOGGLEBAG1" and GetBindingAction("ALT-CTRL-W") == "" and not ns.db.bindingImportBackup, "undo restores previous bindings and unbound keys")
	Stub.popup = nil
	ns.importedBindings = { { key = "CTRL-ALT-J", binding = "T3CODE_NEXT_WORKSPACE" } }
	SlashCmdList.T3CODE("importkeys")
	check(not Stub.popup, "import rejects noncanonical modifier order that WoW cannot dispatch")
	ns.importedBindings = { { key = "ALT-CTRL-X", binding = "UNSAFE_ACTION" } }
	SlashCmdList.T3CODE("importkeys")
	check(not Stub.popup, "import rejects actions outside its allowlist")
	ns.importedBindings = oldImports
	Stub.bindings["ALT-CTRL-T"] = nil
end

-- Focused composer dispatches configured navigation without releasing text focus.
do
	local oldId = ns.viewId
	local oldCtrl, oldAlt = IsControlKeyDown, IsAltKeyDown
	IsControlKeyDown = function() return true end
	IsAltKeyDown = function() return false end
	local oldBinding = Stub.bindings["CTRL-TAB"]
	Stub.bindings["CTRL-TAB"] = "T3CODE_NEXT_THREAD"
	local box = ns.Main.composer
	local editBox = box:GetEditBox()
	local ids = {}
	ns.ThreadList:Refresh(true)
	for _, r in ipairs(ns.ThreadList.scrollBox._rows) do
		if r.ed.thread then table.insert(ids, r.ed.thread.id) end
	end
	check(#ids > 1, "focused navigation fixture has multiple threads")
	ns.Main:SelectThread(ids[#ids])
	box:SetText("focused navigation draft")
	box:SetFocus()
	local onKey = editBox:GetScript("OnKeyDown")
	if onKey then onKey(editBox, "TAB") end
	check(ns.viewId == ids[1] and box:HasFocus(), "Ctrl+Tab navigates while composer remains focused")
	Stub.bindings["CTRL-TAB"] = "T3CODE_PREVIOUS_THREAD"
	if onKey then onKey(editBox, "TAB") end
	check(ns.viewId == ids[#ids] and box:GetText() == "focused navigation draft", "focused navigation resolves changed bindings and restores drafts")
	Stub.bindings["CTRL-TAB"] = "TOGGLEWORLDMAP"
	if onKey then onKey(editBox, "TAB") end
	check(ns.viewId == ids[#ids], "focused composer ignores non-Herdr bindings")
	IsControlKeyDown = function() return false end
	Stub.bindings["TAB"] = "T3CODE_NEXT_THREAD"
	if onKey then onKey(editBox, "TAB") end
	check(ns.viewId == ids[#ids], "unmodified editing keys do not trigger navigation")
	Stub.bindings["TAB"] = nil
	IsControlKeyDown = function() return true end
	IsAltKeyDown = function() return true end
	local navigateWorkspace = ns.ThreadList.NavigateWorkspace
	local direction
	ns.ThreadList.NavigateWorkspace = function(_, value) direction = value end
	Stub.bindings["ALT-CTRL-J"] = "T3CODE_NEXT_WORKSPACE"
	if onKey then onKey(editBox, "J") end
	check(direction == 1 and box:HasFocus(), "Alt+Ctrl workspace shortcut works with composer focus")
	ns.ThreadList.NavigateWorkspace = navigateWorkspace
	Stub.bindings["ALT-CTRL-J"] = nil
	local queued = #ns.Transport.queue
	Stub.bindings["ALT-CTRL-ENTER"] = "T3CODE_NEXT_THREAD"
	box._callbacks.OnEnterPressed()
	check(#ns.Transport.queue == queued, "Enter bound to navigation does not submit the draft")
	if onKey then onKey(editBox, "ENTER") end
	check(ns.viewId == ids[1], "modified Enter dispatches navigation once")
	Stub.bindings["ALT-CTRL-ENTER"] = nil
	Stub.bindings["CTRL-TAB"] = oldBinding
	IsControlKeyDown, IsAltKeyDown = oldCtrl, oldAlt
	box:SetText("")
	ns.Main:SelectThread(oldId)
end

-- Thread bindings follow displayed order and wrap, preserving per-thread drafts.
do
	local oldId = ns.viewId
	local ids = {}
	ns.ThreadList:Refresh(true)
	for _, r in ipairs(ns.ThreadList.scrollBox._rows) do
		if r.ed.thread then table.insert(ids, r.ed.thread.id) end
	end
	check(#ids > 1, "navigation fixture has multiple threads")
	ns.Main:SelectThread(ids[#ids])
	ns.Main.composer:SetText("navigation draft")
	ns.Main.frame:Hide()
	T3Code_Binding("nextThread")
	check(ns.viewId == ids[1] and ns.windowOpen, "next thread wraps and opens the window")
	T3Code_Binding("previousThread")
	check(ns.viewId == ids[#ids] and ns.Main.composer:GetText() == "navigation draft", "previous thread wraps and restores draft")
	ns.Main.composer:SetText("")
	ns.Main:Back()
	T3Code_Binding("previousThread")
	check(ns.viewId == ids[#ids], "previous thread with no selection starts at the last row")
	ns.Main:Back()
	T3Code_Binding("nextThread")
	check(ns.viewId == ids[1], "next thread with no selection starts at the first row")
	local collapsed = ns.db.settings.collapsed
	local oldWorking, oldOpen, oldSettled = collapsed.working, collapsed.open, collapsed.settled
	collapsed.working, collapsed.open, collapsed.settled = true, true, true
	T3Code_Binding("nextThread")
	check(ns.viewId == ids[1], "navigation skips collapsed groups and leaves empty lists alone")
	collapsed.working, collapsed.open, collapsed.settled = oldWorking, oldOpen, oldSettled
	ns.Main:SelectThread(oldId)
end

-- Search and machine filter
ns.ThreadList.query = "zzzz-no-match"
ns.ThreadList:Refresh(true)
local threadRows = 0
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.thread then threadRows = threadRows + 1 end end
check(threadRows == 0, "search hides non-matching threads")
local beforeNavigation = ns.viewId
T3Code_Binding("nextThread")
check(ns.viewId == beforeNavigation, "thread binding respects search with no results")
ns.ThreadList.query = nil
local groups = ns.Store:Groups("m:local")
check(#groups.working + #groups.open + #groups.settled > 0, "machine filter (this computer) keeps local threads")
groups = ns.Store:Groups("m:foundry")
check(#groups.working + #groups.open + #groups.settled == 0, "machine filter (foundry) excludes local threads")
ns.ThreadList:Refresh(true)

-- Report: diagnostics in the box + a screenshot request
ns.Main.composer._text = ""
ns.Main:Report("the list flickers")
check(ns.Main.composer._text:find("the list flickers", 1, true) and ns.Main.composer._text:find("diagnostics", 1, true), "report fills the message box")
check(ns.Transport:Payload():find("\031shot\031", 1, true) ~= nil, "report asks the bridge for a screenshot")
ns.Main.composer._text = ""

-- Attending flag: set while the window is in use, cleared after 90s idle
ns.Main:Open()
ns.Interacted()
Stub.Tick(0.1)
check(ns.Transport:Flags():find("a", 1, true) ~= nil, "attending while using the window")
Stub.now = Stub.now + 100
Stub.Tick(0.1)
check(ns.Transport:Flags():find("a", 1, true) == nil, "not attending after 90s idle")

-- Self-test runs
ns.SelfTest()
check(true, "self-test ran")

-- Window size
ns.db.settings.windowScale = "xlarge"
ns.Main:ApplyScale()
check(true, "window scale applied")
do
	local f = ns.Main.frame
	local savedPoint = { "TOPLEFT", "TOPLEFT", 30, -40 }
	local oldPoint = ns.db.settings.windowPoint
	ns.db.settings.windowPoint = savedPoint
	local checkbox
	for _, cb in ipairs(ns.Settings.checks) do
		if cb.key == "fullscreen" then checkbox = cb end
	end
	checkbox:SetChecked(true)
	checkbox._scripts.OnClick(checkbox)
	check(math.abs(f:GetWidth() * f:GetScale() - UIParent:GetWidth()) < 0.01 and math.abs(f:GetHeight() * f:GetScale() - UIParent:GetHeight()) < 0.01, "fullscreen fills the parent at extra-large scale")
	check(ns.db.settings.windowPoint == savedPoint, "fullscreen preserves saved window position")
	local oldWidth = UIParent._w
	UIParent._w = 1920
	Stub.Fire("DISPLAY_SIZE_CHANGED")
	check(math.abs(f:GetWidth() * f:GetScale() - 1920) < 0.01, "fullscreen follows display size changes")
	UIParent._w = oldWidth
	checkbox:SetChecked(false)
	checkbox._scripts.OnClick(checkbox)
	check(f:GetWidth() == 940 and f:GetHeight() == 640 and f:GetScale() == 1.3, "leaving fullscreen restores normal dimensions and preferred scale")
	T3Code_Binding("fullscreen")
	check(ns.db.settings.fullscreen and checkbox:GetChecked(), "fullscreen shortcut updates the preference and settings checkbox")
	check(math.abs(f:GetWidth() * f:GetScale() - UIParent:GetWidth()) < 0.01, "fullscreen shortcut fills the screen")
	T3Code_Binding("fullscreen")
	check(not ns.db.settings.fullscreen and not checkbox:GetChecked() and f:GetWidth() == 940, "fullscreen shortcut restores windowed mode")
	f:Hide()
	T3Code_Binding("fullscreen")
	check(not f:IsShown() and ns.db.settings.fullscreen, "fullscreen shortcut does not open a closed window")
	T3Code_Binding("toggle")
	check(f:IsShown() and ns.db.settings.fullscreen, "window shortcut opens in the selected fullscreen mode")
	T3Code_Binding("toggle")
	check(not f:IsShown(), "window shortcut closes the window")
	T3Code_Binding("fullscreen")
	ns.Main:Open()
	ns.db.settings.windowPoint = oldPoint
end
ns.db.settings.windowScale = "auto"
ns.Main:ApplyScale()

-- Transitions -> toast
local t = ns.Store.data.threads[1]
local before = t.s
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == t.id then th.s = "working" end end
ns.Transport:Apply(data)
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == t.id then th.s = "open" th.un = true end end
ns.Transport:Apply(data)
local toastShown = ns.Toasts.frames[1] and ns.Toasts.frames[1]._shown
check(toastShown or (ns.windowOpen and ns.viewId == t.id), "finish transition produced a toast")

-- Tracker and tickers run
ns.Tracker:Refresh()
for _ = 1, 5 do Stub.Tick(1) end
check(true, "tickers ran")

-- Gamepad mode: the window captures the controller itself.
Stub.gamepad = true
ns.Main.frame:Hide()
ns.Main:Open()
local f = ns.Main.frame
check(ns.Gamepad.capturing, "window captures the controller in gamepad mode")
local down = f._scripts.OnGamePadButtonDown
check(down ~= nil and f._scripts.OnGamePadStick ~= nil, "button and stick handlers installed")
ns.Gamepad:SelectDefault()
check(ns.Gamepad.selected ~= nil, "cursor starts on a control")
check(down(f, "PADDDOWN") == false, "D-pad consumed (character doesn't move)")
check(f._scripts.OnGamePadStick(f, "Left", 0, -1) == false, "left stick consumed")
check(down(f, "PADFORWARD") == false and f._shown == false and not ns.Gamepad.capturing, "Start closes the window and gives the controller back")
ns.Main:Open()
check(ns.Gamepad.capturing, "reopened window takes the controller again")
check(down(f, "PADRSHOULDER") == false and ns.Main.page == "usage", "RB switched to usage")
down(f, "PADLSHOULDER")
check(ns.Main.page == "threads", "LB switched back")
down(f, "PAD4")
check(ns.Main.dictating, "Y starts dictation")
f._scripts.OnGamePadButtonUp(f, "PAD4")
check(not ns.Main.dictating, "Y release stops dictation")
-- A on a thread row opens it
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do
	if r.ed.thread then ns.Gamepad:Highlight(r.frame) break end
end
ns.viewId = nil
down(f, "PAD1")
check(ns.viewId ~= nil, "A opened the highlighted thread")
-- D-pad routes between the list, the conversation and the message box
local function rowFor(id)
	for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.thread and r.ed.thread.id == id then return r.frame end end
end
data.gen = data.gen + 1
data.view = data.view or {}
data.view.id = ns.viewId
data.view.pending = nil
ns.Transport:Apply(data)
ns.Gamepad:Highlight(rowFor(ns.viewId) or ns.ThreadList.scrollBox._rows[2].frame)
down(f, "PADDRIGHT")
check(ns.Gamepad.selected == ns.Main.composer, "Right from the list goes to the message box")
down(f, "PADDDOWN")
check(ns.Gamepad.selected == f.Bar.Send, "Down from the message box goes to Send")
down(f, "PADDUP")
check(ns.Gamepad.selected == ns.Main.composer, "Up from Send goes back to the message box")
down(f, "PADDLEFT")
local sel = ns.Gamepad.selected
local onRow = false
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.frame == sel and r.ed.thread and r.ed.thread.id == ns.viewId then onRow = true end end
check(onRow, "Left from the conversation returns to the open thread's row")
data.gen = data.gen + 1
data.view.pending = { id = "req2", kind = "question", questions = { { id = "q", h = "Pick", q = "Which?", opts = { { l = "One", d = "", v = "1" }, { l = "Two", d = "", v = "2" } } } } }
ns.Transport:Apply(data)
down(f, "PADDRIGHT")
local selEd
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.kind == "option" and selEd.label == "One", "Right goes straight to the first answer when the agent is asking")
down(f, "PADDDOWN")
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.label == "Two", "Down steps to the next answer")
data.gen = data.gen + 1
data.view.pending = { id = "terminal-pad", kind = "terminal-question", actions = { { key = "tab", label = "Open questions" } } }
ns.Transport:Apply(data)
ns.Gamepad:Highlight(rowFor(ns.viewId))
down(f, "PADDRIGHT")
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.label == "Open questions", "controller reaches the terminal question controls")
down(f, "PAD1")
check(ns.Transport:Payload():find("answer\031" .. ns.viewId .. "\031terminal-pad\031key\031tab", 1, true) ~= nil, "controller activates a terminal question action")
data.gen = data.gen + 1
data.view.pending = nil
ns.Transport:Apply(data)
-- Expand controls participate in the same controller column as answers.
do
	local original, quick = data.view.msgs, ns.db.settings.quickReplies
	ns.db.settings.quickReplies = false
	data.gen = data.gen + 1
	data.view.msgs = { { id = "pad-tool", r = "a", kind = "tool", label = "bash", t = "preview", full = "full output" } }
	ns.Transport:Apply(data)
	ns.Gamepad:Highlight(ns.Main.composer)
	down(f, "PADDUP")
	local option
	for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then option = r.ed end end
	check(option and option.label == "Expand output", "controller can navigate from the composer to a tool expansion")
	local before = #ns.Transport.queue
	down(f, "PAD1")
	check(ns.Transcript.expanded["pad-tool"] and #ns.Transport.queue == before, "controller expands tool output without sending terminal input")
	data.view.msgs, ns.db.settings.quickReplies = original, quick
	data.gen = data.gen + 1
	ns.Transport:Apply(data)
end
-- A on the project dropdown opens a real list; the cursor moves inside it
ns.Gamepad:Highlight(ns.ThreadList.dropdown)
down(f, "PAD1")
local listFrame = ns.UI.ListOpen()
check(listFrame ~= nil, "A opens the project list")
local rows = listFrame.Box._rows or {}
check(#rows >= 2, "list shows the projects: " .. #rows)
local cands = ns.Gamepad:Candidates()
check(#cands == #rows, "cursor is confined to the list rows")
ns.Gamepad:SelectDefault()
check(ns.Gamepad.selected and ns.Gamepad.selected == rows[1].frame, "cursor starts on the current choice (All projects)")
ns.Gamepad:Highlight(rows[2].frame)
down(f, "PAD1")
check(ns.UI.ListOpen() == nil, "picking closes the list")
check(ns.db.settings.project == rows[2].ed.value, "picked project applied: " .. ns.db.settings.project)
ns.Gamepad:Highlight(ns.ThreadList.dropdown)
down(f, "PAD1")
down(f, "PAD2")
check(ns.UI.ListOpen() == nil and f._shown, "B closes the list, not the window")
ns.db.settings.project = "all"
-- Mouse: click opens, clicking a row picks
ns.ThreadList.dropdown._scripts.OnClick(ns.ThreadList.dropdown, "LeftButton")
check(ns.UI.ListOpen() ~= nil, "click opens the list")
ns.UI.ListOpen().Box._rows[2].frame:Click()
check(ns.db.settings.project ~= "all", "click on a row picks it")
ns.db.settings.project = "all"
-- B leaves the composer, then closes
ns.Main.composer._focus = true
down(f, "PAD2")
check(not ns.Main.composer._focus, "B leaves the message box")
down(f, "PAD2")
check(not f._shown, "B closes the window")
check(not ns.Gamepad.capturing, "controller released on close")

-- Launching without a keyboard
check(ns.Launcher.chord == "PADLTRIGGER-PADRTRIGGER-PADBACK", "controller shortcut: both triggers + Back")
check(next(Stub.overrides) == nil, "no key bindings overridden (Forever's controller mode ignores them)")
GameMenuFrame:InitButtons()
local entry
for _, b in ipairs(GameMenuFrame.buttons) do if b.text == ns.title then entry = b end end
check(entry and entry.layoutIndex == 4.5, "game menu entry sits above Log Out")
_G.HideUIPanel = function() end
entry.cb()
check(f._shown, "game menu entry opens the window")
T3Code_Binding("toggle")
check(not f._shown, "shortcut toggles it closed")
check(#(ns.db.errors or {}) == 0, "no errors recorded")

-- Both the branded command and the old alias route to the same UI without
-- replacing the saved settings or existing binding IDs.
do
	local settings = ns.db.settings
	for _, alias in ipairs({ "/herdr", "/t3" }) do
		local handler
		for command, fn in pairs(SlashCmdList) do
			for i = 1, 4 do
				if _G["SLASH_" .. command .. i] == alias then handler = fn end
			end
		end
		check(handler ~= nil, alias .. " has a registered handler")
		local shown = ns.windowOpen
		handler("")
		check(ns.windowOpen ~= shown, alias .. " toggles the existing window")
		handler("")
		check(ns.windowOpen == shown and ns.db.settings == settings, alias .. " preserves window state and saved settings")
	end
end

-- Slash command
SlashCmdList.T3CODE("status")
check(#Stub.printed > 0, "status printed: " .. Stub.printed[#Stub.printed])

-- Self-test: the long control plays, the empty one doesn't -> bells usable
Stub.validSounds = { ["Interface\\AddOns\\T3Code\\Signals\\03999.wav"] = true }
ns.Transport.signals = "untested"
ns.Transport.testing = nil
ns.Transport:SelfTest()
check(ns.Transport.signals == "ok", "self-test passes when the long control plays: " .. ns.Transport.signals)
Stub.validSounds = {}
ns.Transport.testing = nil
ns.Transport:SelfTest()
check(ns.Transport.signals == "muted", "self-test fails when nothing really plays (Forever says willPlay=true anyway)")
ns.Transport.signals = "ok"

-- A bell rung a couple of numbers ahead is still heard; bells map onto 8 rotating
-- files. Only a fresh snapshot moves the bell position (to the bridge's nextSig).
local function BellPath(k) return string.format("Interface\\AddOns\\T3Code\\Signals\\%05d.wav", 3991 + (k - 1) % 8) end
local freshFile = os.tmpname()
do
	local fh = assert(io.open(freshFile, "w"))
	fh:write(string.format("dofile(%q) T3Code_Inbox.gen = 9e15 T3Code_Inbox.nextSig = 503\n", snapshot))
	fh:close()
end
ns.Transport.exhausted = nil
ns.Transport.bellProbe = nil
ns.Transport.ringCooldownUntil = nil
ns.db.sigNext = 500
Stub.slotData[ns.Transport.slotCursor] = freshFile
Stub.validSounds = { [BellPath(502)] = true }
local loadsBefore = Stub.loadCount or 0
Stub.Tick(0.6) -- starts listening
Stub.Tick(0.2) -- checks which bell is really playing
check((Stub.loadCount or 0) > loadsBefore, "loaded a slot when bell 502 rang")
check(ns.db.sigNext == 503, "took the bridge's next bell from the fresh snapshot: " .. ns.db.sigNext)

-- A bell that leads to old data is a false alarm: no moving ahead (which would
-- alias still-rung bells and run away), a short cooldown, and a fresh strip.
Stub.validSounds = { [BellPath(504)] = true }
local loads1 = Stub.loadCount
ns.Transport.bellProbe = nil
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads1 + 1 and ns.db.sigNext == 503, "false ring: one slot loaded, position kept at " .. ns.db.sigNext)
check(ns.Transport.falseRings == 1 and ns.Transport.stripShown, "false ring counted and the strip redrawn")
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads1 + 1, "cooldown: no slot burned by the same false alarm")

-- A laggy client: even the empty control still "plays" at check time. Wait it out
-- instead of trusting the bells.
Stub.now = Stub.now + 5
ns.Transport:HideStrip() -- (as if the bridge acknowledged it; isolates the bell check)
ns.Transport.lastLoadAt = Stub.now
ns.Transport.bellProbe = nil
Stub.validSounds = { [BellPath(503)] = true, ["Interface\\AddOns\\T3Code\\Signals\\04000.wav"] = true }
local loads2 = Stub.loadCount
for _ = 1, 12 do Stub.Tick(0.2) end
check(Stub.loadCount == loads2, "no slot loaded while the client is too slow to tell bells apart")
Stub.validSounds = {}
ns.Transport.bellProbe = nil
local loads3 = Stub.loadCount
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads3, "no slot spent while no bell rings")
os.remove(freshFile)

-- Controller shortcut: hold both triggers, press Back. Read from the controller's
-- state only: the watcher must never take gamepad input (that breaks LT + RT action bars).
do
	local L = ns.Launcher
	L:SetupChord()
	check(L.chordText and L.chordText:find("Left trigger", 1, true) and L.chordText:find("Gamepad_Ltr_View", 1, true), "shortcut shown as the player's buttons: " .. tostring(L.chordText))
	check(not L.chordText:find("RT", 1, true), "no hard-coded Xbox names")
	local w = L.watcher
	check(w._scripts.OnGamePadButtonDown == nil and not w._gamepadEnabled, "the watcher never takes controller input")
	local function frame() w._scripts.OnUpdate(w, 0.016) end
	local wasOpen = ns.windowOpen
	WOWSTUB.padHeld = { PADLTRIGGER = true, PADRTRIGGER = true }
	frame()
	check(ns.windowOpen == wasOpen, "holding the triggers alone does nothing (LT + RT action bars stay the game's)")
	WOWSTUB.padHeld.PADBACK = true
	frame()
	check(ns.windowOpen ~= wasOpen, "triggers + Back toggles Herdr")
	frame()
	frame()
	check(ns.windowOpen ~= wasOpen, "holding Back doesn't toggle it again")
	WOWSTUB.padHeld = { PADBACK = true }
	if ns.windowOpen ~= wasOpen then ns.Launcher:Open() end
	frame()
	WOWSTUB.padHeld = {}
	frame()
	WOWSTUB.padHeld = { PADBACK = true }
	frame()
	check(ns.windowOpen == wasOpen, "Back on its own is left to the game")
	WOWSTUB.padHeld = {}
	frame()
end

-- Tracker section follows the objective tracker, in the quest column.
do
	local f = ns.Tracker.frame
	local function anchoredTo(target)
		for _, pt in ipairs(f._points or {}) do if pt[2] == target then return true end end
		return false
	end
	WOWSTUB.Tick(0.3)
	check(ns.Tracker.attached == "below" and anchoredTo(ObjectiveTrackerFrame.NineSlice), "tracker section sits under the quests: " .. tostring(ns.Tracker.attached))
	check(f:GetWidth() == 280, "same width as the objective tracker")
	ObjectiveTrackerFrame.isCollapsed = true
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "header" and anchoredTo(ObjectiveTrackerFrame.Header), "under the header when All Objectives is collapsed")
	ObjectiveTrackerFrame.isCollapsed = nil
	ObjectiveTrackerFrame._shown = false
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "replace", "takes the tracker's place when it's empty")
	ObjectiveTrackerFrame._shown = true
	ns.db.settings.trackerPoint = { "CENTER", "CENTER", 10, 10 }
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "custom", "a dragged position is kept")
	ns.db.settings.trackerPoint = nil
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "below", "reset reattaches it")
end

-- Minimap button
do
	local mb = ns.MinimapButton.button
	check(mb ~= nil, "minimap button created")
	local wasOpen = ns.windowOpen
	mb._scripts.OnClick(mb, "LeftButton")
	check(ns.windowOpen ~= wasOpen, "minimap click toggles the window")
	mb._scripts.OnClick(mb, "LeftButton")
	mb._scripts.OnEnter(mb)
	mb._scripts.OnDragStart(mb)
	mb._scripts.OnDragStop(mb)
	check(type(ns.db.settings.minimapAngle) == "number", "minimap drag saves its position")
	ns.db.settings.minimapButton = false
	ns.MinimapButton:Refresh()
	check(mb._shown == false, "minimap button can be hidden")
	ns.db.settings.minimapButton = true
	ns.MinimapButton:Refresh()
end

-- Herdr capabilities and delayed launch results: no unsupported controls, no
-- duplicate launch, and a failed startup restores the original prompt.
do
	local caps = { images = false, stop = false, settle = false, archive = false, busySend = false }
	local th = { id = "herdr-test", title = "Main · Pi", p = "space:test", s = "working", l = "Working", caps = caps }
	data.gen = 9e15 + 100
	data.threads = { th }
	data.projects = {
		{ id = "pi-project", name = "Pi launch project", launch = true, browse = false, filterId = "space:test" },
		{ id = "space:test", name = "Development", act = true, browse = true, launch = false },
		{ id = "space:empty", name = "Empty space", act = true, browse = true, launch = false },
	}
	data.bridge = { t3 = "connected", backend = "Herdr", caps = caps }
	data.view = { id = th.id, msgs = { { r = "a", t = "Recent terminal output" } }, note = "Recent Pi terminal output, not full conversation history." }
	ns.Transport:Apply(data)
	ns.Main:SelectThread(th.id)
	ns.Main:Open()
	ns.Main:Refresh()
	check(ns.ThreadList.tabs:IsShown(), "Herdr shows top tab navigation")
	-- The stub does not resolve anchors: simulate the bar's resulting widths
	-- and the client's size event after fullscreen grows/shrinks its parent.
	local tabs = ns.ThreadList.tabs
	local savedWidth = tabs:GetWidth()
	tabs:SetWidth(1500)
	ns.ThreadList:RefreshTabs()
	for _, width in ipairs({ 600, 1500, 600 }) do
		tabs:SetWidth(width)
		local resized = tabs:GetScript("OnSizeChanged")
		if resized then resized(tabs, width, tabs:GetHeight()) end
		local button = tabs.buttons[3]
		local point = button._points[1]
		check(point[4] + button:GetWidth() <= width - 32, "tabs stay inside the bar after fullscreen resize to " .. width)
		check(math.abs(button:GetWidth() - (width - 72) / 3) < 0.01, "tabs fill the resized bar")
	end
	tabs:SetWidth(savedWidth)
	ns.ThreadList:RefreshTabs()
	local savedProject = ns.db.settings.project
	ns.ThreadList.defaultSelected = nil
	ns.db.settings.project = "all"
	ns.ThreadList:DefaultSpace()
	check(ns.db.settings.project == th.p, "initial Herdr space follows the viewed tab instead of mixing all spaces")
	ns.db.settings.project = "all"
	ns.ThreadList:DefaultSpace()
	check(ns.db.settings.project == "all", "explicit all-spaces selection survives later opens")
	ns.db.settings.project = savedProject
	ns.ThreadList:SelectSpace("space:test")
	check(ns.ThreadList.tabs.buttons[1].ActiveLine:IsShown(), "selected Herdr tab has an active indicator")
	local spaces = {}
	for i = 1, ns.ThreadList.scrollBox:GetDataProviderSize() do
		local ed = ns.ThreadList.scrollBox:FindElementData(i)
		if ed.space then spaces[ed.space.id] = true end
		check(not ed.thread, "Herdr sidebar contains spaces instead of thread rows")
	end
	check(spaces["space:empty"] and not spaces["pi-project"], "space sidebar includes empty spaces but excludes launch aliases")
	ns.ThreadList:SelectSpace("space:empty")
	check(ns.viewId == nil and not ns.ThreadList.tabs.buttons[1]:IsShown(), "empty space clears the view and has no tabs")
	ns.ThreadList:SelectSpace("space:test")
	check(ns.viewId == th.id and ns.ThreadList.tabs.buttons[1].thread.id == th.id, "space selection opens its first tab")
	check(not ns.Main.frame.Bar.Stop:IsEnabled(), "Herdr stop is disabled")
	check(not ns.Main.frame.Bar.Shot:IsEnabled(), "Herdr screenshots are disabled")
	check(not ns.Main.frame.Pages.threads.Right.Header.Action:IsShown(), "Herdr settle is hidden")
	local count = #ns.Transport.queue
	ns.Main:Send("Do not send while busy")
	check(#ns.Transport.queue == count, "busy Herdr prompt is not queued")
	th.s = "open"
	ns.db.settings.project = "pi-project"
	ns.ThreadList:Refresh(true)
	check(ns.db.settings.project == "space:test", "old project filters migrate to their space")
	check(#ns.ThreadList.dropdown.options == 3, "space filter includes empty spaces but not launch aliases")
	ns.Main.composer:SetText("workspace navigation draft")
	ns.ThreadList.query = "zzzz-no-match"
	ns.Main:ShowPage("usage")
	ns.Main.frame:Hide()
	T3Code_Binding("nextWorkspace")
	check(ns.db.settings.project == "space:empty" and ns.windowOpen and ns.Main.page == "threads", "next workspace opens the space filter including empty spaces")
	check(ns.viewId == nil and ns.db.drafts[th.id] == "workspace navigation draft" and ns.ThreadList.query == "zzzz-no-match", "empty workspace clears selection while saving the previous draft and search")
	ns.ThreadList.query = nil
	T3Code_Binding("nextWorkspace")
	check(ns.db.settings.project == "space:test", "next workspace wraps without visiting launch aliases or all-spaces")
	check(ns.viewId == th.id and ns.Main.composer:GetText() == "workspace navigation draft", "workspace switching selects its first tab and restores its draft")
	T3Code_Binding("previousWorkspace")
	check(ns.db.settings.project == "space:empty", "previous workspace wraps in reverse")
	ns.db.settings.project = "all"
	T3Code_Binding("nextWorkspace")
	check(ns.db.settings.project == "space:test", "next workspace from all-spaces selects the first browse space")
	ns.db.settings.project = "m:local"
	T3Code_Binding("previousWorkspace")
	check(ns.db.settings.project == "space:empty", "previous workspace from a machine filter selects the last browse space")
	local laterTab = { id = "herdr-later", title = "Later tab", p = th.p, s = "working", caps = caps }
	data.threads = { th, laterTab }
	ns.Store:Apply(data)
	T3Code_Binding("nextWorkspace")
	check(ns.viewId == th.id and ns.ThreadList.tabs.buttons[1].thread.id == th.id, "workspace selects the first desktop tab rather than a later working tab")
	ns.Main:SelectThread(laterTab.id)
	ns.ThreadList:SelectSpace(th.p)
	check(ns.viewId == th.id, "clicking a space also selects its first tab")
	data.threads = { th }
	ns.Store:Apply(data)
	local projects = data.projects
	data.projects = {}
	ns.Store:Apply(data)
	T3Code_Binding("nextWorkspace")
	check(ns.db.settings.project == "all", "no browse spaces leaves the filter at all-spaces")
	data.projects = projects
	ns.Store:Apply(data)
	ns.ThreadList.query = nil
	ns.Main.composer:SetText("")
	ns.Main:StartNewThread("space:empty")
	check(ns.Main.newProject == "pi-project", "browsed spaces cannot become arbitrary launch destinations")
	check(#ns.Main.frame.Pages.threads.Right.Header.Project.options == 1, "new-thread dropdown only lists allowlisted launch projects")
	ns.Main.composer:SetText("Start this Pi task")
	ns.Main:Send()
	local pending = ns.Main.pendingNew
	count = #ns.Transport.queue
	ns.Main:Send("Duplicate")
	check(#ns.Transport.queue == count and ns.Main.pendingNew == pending, "pending startup cannot be submitted twice")
	ns:Fire("CommandResult", { id = pending, ok = false, msg = "Startup timed out; inspect Herdr" })
	check(ns.Main.composer:GetInputText() == "Start this Pi task", "failed startup restores the prompt")
	check(ns.Main.pendingNew == nil, "failed startup clears pending state")
	-- Shortcut launches are empty, space-scoped and deduplicated, even with a
	-- saved task-form draft or a last-used project in another space.
	data.projects[#data.projects + 1] = { id = "other-project", name = "Other", launch = true, browse = false, filterId = "space:empty" }
	ns.Store:Apply(data)
	ns.db.settings.project = "space:test"
	ns.db.settings.lastProject = "other-project"
	count = #ns.Transport.queue
	T3Code_Binding("new")
	local shortcut = ns.Transport.queue[#ns.Transport.queue]
	check(#ns.Transport.queue == count + 1 and shortcut.verb == "new" and shortcut.args[1] == "pi-project" and shortcut.args[2] == "", "new-tab shortcut starts an empty agent in the selected space, not the last-used space")
	pending = ns.Main.pendingNew
	T3Code_Binding("new")
	check(#ns.Transport.queue == count + 1 and ns.Main.pendingNew == pending, "new-tab shortcut cannot duplicate a pending launch")
	ns:Fire("CommandResult", { id = pending, ok = true, open = th.id })
	check(ns.Main.mode == "thread" and ns.viewId == th.id, "new-tab startup result selects the fresh agent")
	check(ns.db.drafts.__new == "Start this Pi task", "empty shortcut launch preserves the saved task-form draft")
	table.remove(data.projects)
	ns.Store:Apply(data)
	ns.db.settings.project = "space:empty"
	count = #ns.Transport.queue
	T3Code_Binding("new")
	check(#ns.Transport.queue == count and not ns.Main.pendingNew, "new-tab shortcut never silently launches into another space")
	th.kind, th.caps = "terminal", { send = false }
	ns.Main:SelectThread(th.id)
	ns.Main:Refresh()
	check(not ns.Main.frame.Bar.Send:IsEnabled(), "shell tab Send is disabled")
	count = #ns.Transport.queue
	ns.Main:Send("must not execute in a shell")
	check(#ns.Transport.queue == count, "shell tabs cannot receive a prompt through keyboard or controller send")
	data.projects = { data.projects[2], data.projects[3] }
	ns.Store:Apply(data)
	ns.Main:StartNewThread("space:empty")
	check(ns.Main.newProject == nil and not ns.Main.frame.Bar.Send:IsEnabled(), "browse-only spaces cannot start an agent without launch configuration")
end

-- Exhaustion
Stub.now = Stub.now + 2
ns.Transport.slotCursor = ns.Transport.slotCount + 1
ns.Transport:LoadNextSlot("signal")
check(ns.Transport:BridgeState() == "exhausted", "slot exhaustion detected")
ns.Tracker:Refresh()

print("\nall smoke checks passed; slots loaded: " .. tostring(Stub.loadCount))
