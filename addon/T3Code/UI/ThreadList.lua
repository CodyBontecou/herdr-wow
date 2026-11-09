-- Left side of the window: project filter and the grouped thread list.

local _, ns = ...
local UI = ns.UI

local L = {}
ns.ThreadList = L

local LIST_W_DEFAULT = 280

local GROUPS = {
	{ key = "working", label = "Working" },
	{ key = "open", label = "Open" },
	{ key = "settled", label = "Settled" },
}

local DOT_COLORS = {
	working = { 0.29, 0.62, 1 },
	input = { 1, 0.6, 0.2 },
	plan = { 1, 0.6, 0.2 },
	failed = { 1, 0.25, 0.25 },
	unread = { 0.29, 0.62, 1 },
}

local function InitHeader(button, ed)
	UI.InitGroupHeader(button)
	UI.SetGroupHeader(button, ed.label, ed.count, ed.collapsed)
	button:SetScript("OnClick", function()
		local c = ns.db.settings.collapsed
		c[ed.key] = not c[ed.key]
		PlaySound(c[ed.key] and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_OFF or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
		L:Refresh(true)
	end)
end

local function CreateRow(button)
	button:SetHeight(46)
	button:RegisterForClicks("LeftButtonUp")

	local hover = button:CreateTexture(nil, "HIGHLIGHT")
	hover:SetAtlas("Options_List_Hover")
	hover:SetAllPoints()
	hover:SetAlpha(0.5)

	local sel = button:CreateTexture(nil, "BACKGROUND")
	sel:SetAtlas("PetList-ButtonSelect")
	sel:SetPoint("TOPLEFT", -2, 2)
	sel:SetPoint("BOTTOMRIGHT", 2, -2)
	button.Selected = sel

	local dot = button:CreateTexture(nil, "ARTWORK")
	dot:SetTexture("Interface\\Buttons\\WHITE8X8")
	dot:SetSize(7, 7)
	dot:SetPoint("TOPLEFT", 6, -12)
	dot:SetMask("Interface\\CharacterFrame\\TempPortraitAlphaMask")
	button.Dot = dot

	local title = button:CreateFontString(nil, "ARTWORK", "GameFontNormal")
	title:SetPoint("TOPLEFT", 18, -7)
	title:SetPoint("RIGHT", -74, 0)
	title:SetJustifyH("LEFT")
	title:SetWordWrap(false)
	button.Title = title

	local status = button:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
	status:SetPoint("TOPRIGHT", -6, -8)
	status:SetJustifyH("RIGHT")
	button.Status = status

	local sub = button:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
	sub:SetPoint("BOTTOMLEFT", 18, 8)
	sub:SetPoint("RIGHT", -60, 0)
	sub:SetJustifyH("LEFT")
	sub:SetWordWrap(false)
	button.Sub = sub

	local age = button:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
	age:SetPoint("BOTTOMRIGHT", -6, 8)
	age:SetJustifyH("RIGHT")
	button.Age = age

	button:SetScript("OnEnter", function(self)
		local t = self.thread
		if not t then return end
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText(t.title, 1, 0.82, 0, 1, true)
		GameTooltip:AddLine(ns.Store:ProjectName(t.p), 0.7, 0.7, 0.7)
		GameTooltip:AddLine(t.l or ns.Store.StatusText(t.s), 1, 1, 1, true)
		if t.br then GameTooltip:AddLine("Branch: " .. t.br, 0.6, 0.8, 1) end
		if t.m then GameTooltip:AddLine(t.m, 0.6, 0.6, 0.6) end
		if t.last then
			GameTooltip:AddLine(" ")
			GameTooltip:AddLine(t.last, 0.9, 0.9, 0.9, true)
		end
		GameTooltip:Show()
	end)
	button:SetScript("OnLeave", function() GameTooltip:Hide() end)
	button.created = true
end

local function InitRow(button, ed)
	if not button.created then CreateRow(button) end
	local t = ed.thread
	button.thread = t
	button.Selected:SetShown(t.id == ns.viewId and ns.Main.mode ~= "new")
	button.Title:SetText(t.title)
	if t.s == "settled" then
		button.Title:SetTextColor(0.75, 0.75, 0.75)
	else
		button.Title:SetTextColor(NORMAL_FONT_COLOR:GetRGB())
	end
	local color = DOT_COLORS[t.s] or (t.un and DOT_COLORS.unread)
	button.Dot:SetShown(color ~= nil)
	if color then button.Dot:SetVertexColor(color[1], color[2], color[3]) end
	button.Status:SetText(ns.Color(ns.Store.StatusColor(t.s), t.kind == "terminal" and "Terminal" or ns.Store.StatusText(t.s)))
	local sub = ns.Store:ProjectName(t.p)
	if t.s == "working" or t.s == "input" then
		if ns.Store.data.bridge.backend == "Herdr" and t.l then sub = sub .. "  ·  " .. t.l
		else sub = t.l or sub end
	end
	button.Sub:SetText(sub)
	if t.s == "working" and t.st then
		button.Age:SetText(ns.Duration(time() - t.st))
	else
		button.Age:SetText(ns.Ago(t.u))
	end
	button:SetScript("OnClick", function()
		PlaySound(SOUNDKIT.IG_QUEST_LOG_OPEN or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
		ns.Main:SelectThread(t.id)
	end)
end

local function InitSpace(button, ed)
	if not button.created then CreateRow(button) end
	button.thread = nil
	button.Selected:SetShown(ns.db.settings.project == ed.space.id)
	button.Title:SetText(ed.space.name)
	button.Title:SetTextColor(NORMAL_FONT_COLOR:GetRGB())
	button.Status:SetText("")
	button.Sub:SetText(ed.count .. (ed.count == 1 and " tab / pane" or " tabs / panes"))
	button.Age:SetText("")
	button.Dot:Hide()
	button:SetScript("OnClick", function() L:SelectSpace(ed.space.id) end)
end

function L:SelectSpace(id)
	ns.db.settings.project = id
	self.tabOffset = 0
	local t = ns.Store:Thread(ns.viewId)
	if not t or (id ~= "all" and t.p ~= id) then
		local groups = ns.Store:Groups(id, self.query)
		local first = groups.working[1] or groups.open[1] or groups.settled[1]
		ns.Main:SelectThread(first and first.id or nil)
	end
	self:Refresh(true)
	ns.Main:Refresh()
end

local function TabButton(parent, text, width, onClick)
	local button = CreateFrame("Button", nil, parent)
	button:SetSize(width, 26)
	local bg = button:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	bg:SetColorTexture(0.08, 0.09, 0.12, 0.9)
	button.Background = bg
	local hover = button:CreateTexture(nil, "HIGHLIGHT")
	hover:SetAllPoints()
	hover:SetColorTexture(0.5, 0.65, 0.9, 0.15)
	local line = button:CreateTexture(nil, "ARTWORK")
	line:SetPoint("BOTTOMLEFT")
	line:SetPoint("BOTTOMRIGHT")
	line:SetHeight(2)
	line:SetColorTexture(0.55, 0.7, 1, 1)
	line:Hide()
	button.ActiveLine = line
	button.Label = UI.Text(button, "GameFontHighlightSmall", "CENTER")
	button.Label:SetPoint("LEFT", 8, 0)
	button.Label:SetPoint("RIGHT", -8, 0)
	button.Label:SetWordWrap(false)
	button.Label:SetText(text)
	button:SetScript("OnClick", onClick)
	return button
end

function L:DefaultSpace()
	if self.defaultSelected or ns.Store.data.bridge.backend ~= "Herdr" or ns.Store.applied == 0 then return end
	if #ns.Store.data.projects == 0 then return end
	self.defaultSelected = true
	local s = ns.db.settings
	if s.project ~= "all" and ns.Store.projectsById[s.project] then return end
	local viewed = ns.Store:Thread(ns.viewId)
	if viewed then
		s.project = viewed.p
	else
		for _, p in ipairs(ns.Store.data.projects) do
			if p.act and p.browse ~= false then s.project = p.id break end
		end
	end
	return s.project ~= "all"
end

function L:CreateTabs(parent)
	local bar = CreateFrame("Frame", nil, parent)
	bar:SetPoint("TOPLEFT", 4, -4)
	bar:SetPoint("TOPRIGHT", -4, -4)
	bar:SetHeight(30)
	bar.buttons = {}
	bar.Previous = TabButton(bar, "<", 28, function()
		L.tabOffset = math.max(0, (L.tabOffset or 0) - 3)
		L:Refresh(true)
	end)
	bar.Previous:SetPoint("LEFT")
	bar.Next = TabButton(bar, ">", 28, function()
		L.tabOffset = (L.tabOffset or 0) + 3
		L:Refresh(true)
	end)
	bar.Next:SetPoint("RIGHT")
	for i = 1, 3 do
		local button = TabButton(bar, "", 150, function()
			local t = bar.buttons[i].thread
			if t then ns.Main:SelectThread(t.id) end
		end)
		button:SetPoint("LEFT", bar, "LEFT", 32 + (i - 1) * 154, 0)
		UI.Tooltip(button, nil, function() return button.thread and button.thread.title end)
		bar.buttons[i] = button
	end
	self.tabs = bar
end

function L:RefreshTabs()
	local bar = self.tabs
	if not bar then return end
	local herdr = ns.Store.data.bridge.backend == "Herdr"
	bar:SetShown(herdr)
	self.dropdown:SetShown(not herdr)
	self.heading:SetShown(herdr)
	local header = ns.Main.frame.Pages.threads.Right.Header
	header:SetPoint("TOPLEFT", 4, herdr and -38 or -4)
	header:SetPoint("TOPRIGHT", -4, herdr and -38 or -4)
	if not herdr then return end
	local groups = ns.Store:Groups(ns.db.settings.project, self.query)
	local rows = {}
	for _, group in ipairs(GROUPS) do
		for _, t in ipairs(groups[group.key]) do rows[#rows + 1] = t end
	end
	-- Keep desktop discovery order rather than grouping tabs by activity.
	local included = {}
	for _, t in ipairs(rows) do included[t.id] = true end
	rows = {}
	for _, t in ipairs(ns.Store.data.threads) do
		if included[t.id] then rows[#rows + 1] = t end
	end
	local offset = math.min(self.tabOffset or 0, math.max(0, math.floor((#rows - 1) / 3) * 3))
	if self.tabView ~= ns.viewId then
		for i, t in ipairs(rows) do
			if t.id == ns.viewId then offset = math.floor((i - 1) / 3) * 3 break end
		end
		self.tabView = ns.viewId
	end
	self.tabOffset = offset
	local width = math.max(80, (bar:GetWidth() - 72) / 3)
	for i, button in ipairs(bar.buttons) do
		local t = rows[offset + i]
		button.thread = t
		button:SetShown(t ~= nil)
		button:SetWidth(width)
		button:ClearAllPoints()
		button:SetPoint("LEFT", bar, "LEFT", 32 + (i - 1) * (width + 4), 0)
		local active = t and t.id == ns.viewId and ns.Main.mode == "thread"
		button.Background:SetColorTexture(active and 0.18 or 0.08, active and 0.25 or 0.09, active and 0.38 or 0.12, 0.95)
		button.ActiveLine:SetShown(active)
		local title = t and t.title or ""
		if t and ns.db.settings.project == "all" then title = ns.Store:ProjectName(t.p) .. " · " .. title end
		button.Label:SetText(title)
		button.Label:SetTextColor(active and 1 or 0.7, active and 1 or 0.73, active and 1 or 0.8)

	end
	bar.Previous:SetEnabled(offset > 0)
	bar.Previous.Label:SetAlpha(offset > 0 and 1 or 0.3)
	bar.Next:SetEnabled(offset + 3 < #rows)
	bar.Next.Label:SetAlpha(offset + 3 < #rows and 1 or 0.3)
end

function L:Create(parent)
	local dd = UI.Dropdown(parent, LIST_W_DEFAULT, function(value)
		ns.db.settings.project = value
		L:SelectSpace(value)
	end)
	dd:SetPoint("TOPLEFT", 8, -8)
	dd:SetPoint("TOPRIGHT", -10, -8)
	self.dropdown = dd
	self.heading = UI.Text(parent, "GameFontNormalLarge", "LEFT")
	self.heading:SetPoint("TOPLEFT", 12, -12)
	self.heading:SetText("Spaces")
	self.heading:Hide()

	local search = CreateFrame("EditBox", nil, parent, "SearchBoxTemplate")
	search:SetHeight(20)
	search:SetPoint("TOPLEFT", dd, "BOTTOMLEFT", 6, -6)
	search:SetPoint("TOPRIGHT", dd, "BOTTOMRIGHT", -2, -6)
	search:SetAutoFocus(false)
	search:HookScript("OnTextChanged", function(box)
		L.query = strtrim(box:GetText() or ""):lower()
		L:Refresh(true)
	end)
	self.search = search

	local scrollBox = CreateFrame("Frame", nil, parent, "WowScrollBoxList")
	scrollBox:SetPoint("TOPLEFT", 4, -70)
	scrollBox:SetPoint("BOTTOMRIGHT", -18, 4)
	local scrollBar = CreateFrame("EventFrame", nil, parent, "MinimalScrollBar")
	scrollBar:SetPoint("TOPLEFT", scrollBox, "TOPRIGHT", 4, 0)
	scrollBar:SetPoint("BOTTOMLEFT", scrollBox, "BOTTOMRIGHT", 4, 0)

	local view = CreateScrollBoxListLinearView(2, 2, 2, 2, 2)
	view:SetElementFactory(function(factory, ed)
		if ed.space then
			factory("T3CodeThreadRowTemplate", InitSpace)
		elseif ed.header then
			factory("T3CodeGroupHeaderTemplate", InitHeader)
		elseif ed.empty then
			factory("T3CodeEmptyRowTemplate", function(frame)
				if not frame.Text then
					frame.Text = frame:CreateFontString(nil, "ARTWORK", "GameFontDisable")
					frame.Text:SetPoint("LEFT", 18, 0)
					frame.Text:SetPoint("RIGHT", -8, 0)
					frame.Text:SetJustifyH("LEFT")
				end
				frame.Text:SetText(ed.empty)
			end)
		else
			factory("T3CodeThreadRowTemplate", InitRow)
		end
	end)
	view:SetElementExtentCalculator(function(_, ed)
		if ed.header then return 28 end
		if ed.empty then return 24 end
		return 46
	end)
	ScrollUtil.InitScrollBoxListWithScrollBar(scrollBox, scrollBar, view)
	self.scrollBox, self.scrollBar, self.view = scrollBox, scrollBar, view
end

-- Cycle through displayed rows, respecting filters, search and collapsed groups.
function L:Navigate(direction)
	ns.Main:Create()
	self:Refresh()
	local rows, current = {}, nil
	if ns.Store.data.bridge.backend == "Herdr" then
		local groups = ns.Store:Groups(ns.db.settings.project, self.query)
		local included = {}
		for _, group in ipairs(GROUPS) do
			for _, t in ipairs(groups[group.key]) do included[t.id] = true end
		end
		for _, t in ipairs(ns.Store.data.threads) do
			if included[t.id] then
				rows[#rows + 1] = { id = t.id }
				if t.id == ns.viewId then current = #rows end
			end
		end
	end
	for i = 1, self.scrollBox:GetDataProviderSize() do
		local ed = self.scrollBox:FindElementData(i)
		if ed and ed.thread then
			table.insert(rows, { id = ed.thread.id, index = i })
			if ed.thread.id == ns.viewId and ns.Main.mode == "thread" then current = #rows end
		end
	end
	if #rows == 0 then return end
	local nextIndex
	if current then nextIndex = (current - 1 + direction) % #rows + 1
	else nextIndex = direction > 0 and 1 or #rows end
	local row = rows[nextIndex]
	ns.Main:SelectThread(row.id, { show = true })
	if row.index then self.scrollBox:ScrollToElementDataIndex(row.index, ScrollBoxConstants.AlignNearest, nil, true) end
end

-- Cycle real browse filters, not launch aliases or aggregate/machine entries.
-- Keep the conversation/draft intact, just like choosing a space in the dropdown.
function L:NavigateWorkspace(direction)
	ns.Main:Create()
	self:Refresh()
	local spaces, current = {}, nil
	for _, p in ipairs(ns.Store.data.projects) do
		if p.act and p.browse ~= false then
			table.insert(spaces, p.id)
			if p.id == ns.db.settings.project then current = #spaces end
		end
	end
	if #spaces == 0 then return end
	local nextIndex
	if current then nextIndex = (current - 1 + direction) % #spaces + 1
	else nextIndex = direction > 0 and 1 or #spaces end
	ns.db.settings.project = spaces[nextIndex]
	self.tabOffset = 0
	self:Refresh(true)
	ns.Main:Open()
	ns.Main:ShowPage("threads")
	ns.Main:Refresh()
end

function L:SetupDropdown()
	local herdr = ns.Store.data.bridge.backend == "Herdr"
	local options = { { value = "all", label = herdr and "All spaces" or "All projects" } }
	-- With more than one machine, filters per machine come first.
	local machines = ns.Store.data.bridge and ns.Store.data.bridge.envs
	if machines then
		for _, e in ipairs(machines) do
			table.insert(options, { value = "m:" .. (e["local"] and "local" or e.label), label = "Everything on " .. e.label })
		end
	end
	for _, p in ipairs(ns.Store.data.projects) do
		if p.act and p.browse ~= false then table.insert(options, { value = p.id, label = p.name }) end
	end
	self.dropdown:SetOptions(options, ns.db.settings.project)
end

function L:Refresh(force)
	if not self.scrollBox then return end
	local s = ns.db.settings
	local herdr = ns.Store.data.bridge.backend == "Herdr"
	local selected = ns.Store.projectsById[s.project]
	if selected and selected.filterId then s.project = selected.filterId end
	if s.project ~= "all" and not s.project:find("^m:") and not ns.Store.projectsById[s.project] and ns.Store.applied > 0 then s.project = "all" end
	self:RefreshTabs()
	local key = table.concat({
		ns.Store.applied, s.project, tostring(s.collapsed.working), tostring(s.collapsed.open),
		tostring(s.collapsed.settled), tostring(ns.viewId), ns.Main.mode, self.query or "",
	}, ":")
	if key == self.key and not force then
		-- Only timers changed: refresh the visible rows in place.
		self.scrollBox:ForEachFrame(function(frame, ed)
			if ed.space then InitSpace(frame, ed)
			elseif ed.thread then InitRow(frame, ed) end
		end)
		return
	end
	self.key = key
	self:SetupDropdown()

	local groups = ns.Store:Groups(s.project, self.query)
	local dp = CreateDataProvider()
	if herdr then
		local spaces = { { id = "all", name = "All spaces" } }
		for _, p in ipairs(ns.Store.data.projects) do
			if p.act and p.browse ~= false then spaces[#spaces + 1] = p end
		end
		for _, p in ipairs(spaces) do
			local count = 0
			for _, t in ipairs(ns.Store.data.threads) do
				if p.id == "all" or t.p == p.id then count = count + 1 end
			end
			dp:Insert({ space = p, count = count })
		end
	end
	for _, g in ipairs(herdr and {} or GROUPS) do
		local list = groups[g.key]
		local collapsed = s.collapsed[g.key]
		if #list > 0 or g.key ~= "settled" then
			dp:Insert({ header = true, key = g.key, label = g.label, count = #list, collapsed = collapsed })
			if not collapsed then
				for _, t in ipairs(list) do dp:Insert({ thread = t }) end
				if #list == 0 then
					dp:Insert({ empty = g.key == "working" and "Nothing running" or "Nothing here" })
				end
			end
		end
	end
	if ns.Store.applied == 0 then
		dp:Insert({ empty = "Waiting for the bridge…" })
	elseif (ns.Store.data.older or 0) > 0 and not s.collapsed.settled then
		dp:Insert({ empty = string.format("+%d older settled threads on your desktop", ns.Store.data.older) })
	end
	self.scrollBox:SetDataProvider(dp, ScrollBoxConstants.RetainScrollPosition)
	ns:Fire("ListRebuilt")
end
