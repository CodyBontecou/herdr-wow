-- Import local, declarative Herdr shortcuts only after an in-game confirmation.
local _, ns = ...
local K = {}
ns.Keybindings = K

local ALLOWED = {
	T3CODE_NEW = true,
	T3CODE_NEXT_THREAD = true,
	T3CODE_PREVIOUS_THREAD = true,
	T3CODE_CLOSE_THREAD = true,
	T3CODE_NEXT_WORKSPACE = true,
	T3CODE_PREVIOUS_WORKSPACE = true,
}
local SPECIAL = {
	ENTER = true, TAB = true, ESCAPE = true, SPACE = true, BACKSPACE = true,
	DELETE = true, INSERT = true, HOME = true, END = true, PAGEUP = true,
	PAGEDOWN = true, LEFT = true, RIGHT = true, UP = true, DOWN = true,
	["-"] = true, [","] = true, ["."] = true, ["/"] = true, ["`"] = true, ["="] = true,
}
local function ValidKey(key)
	if type(key) ~= "string" or #key > 40 then return false end
	local base = key:gsub("^ALT%-", ""):gsub("^CTRL%-", ""):gsub("^SHIFT%-", "")
	local f = tonumber(base:match("^F(%d+)$"))
	local functionKey = f and f >= 1 and f <= 24 and base == "F" .. f
	return (base ~= key or functionKey) and (base:match("^[A-Z0-9]$") or functionKey or SPECIAL[base])
end
local function CanChange()
	if InCombatLockdown() then
		ns.Print("Key bindings cannot change in combat. Try again after combat.")
		return false
	end
	return true
end
local function Current(key) return GetBindingAction(key) or "" end
local function Restore(rows)
	for _, row in ipairs(rows) do SetBinding(row.key, row.before ~= "" and row.before or nil) end
end

function K:Apply(data)
	if not CanChange() then return end
	if GetCurrentBindingSet() ~= data.set then
		ns.Print("The active binding set changed. Run /herdr importkeys again.")
		return
	end
	for _, row in ipairs(data.rows) do
		if Current(row.key) ~= row.before then
			ns.Print("Bindings changed while confirmation was open. Run /herdr importkeys again.")
			return
		end
	end
	for _, row in ipairs(data.rows) do
		if not SetBinding(row.key, row.binding) then
			Restore(data.rows)
			ns.Print("The import failed. Previous key bindings were restored.")
			return
		end
	end
	SaveBindings(data.set)
	ns.db.bindingImportBackup = data
	ns.Print("Herdr shortcuts imported into the active binding set. /herdr undokeys restores the previous keys.")
end

StaticPopupDialogs["T3CODE_IMPORT_KEYS"] = {
	text = "%s",
	button1 = "Import keys",
	button2 = "Cancel",
	OnAccept = function(_, data) K:Apply(data) end,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	preferredIndex = 3,
}

function K:Preview()
	if not CanChange() then return end
	local rows, seen = {}, {}
	for _, row in ipairs(ns.importedBindings or {}) do
		if type(row) ~= "table" or not ALLOWED[row.binding] or not ValidKey(row.key) or seen[row.key] then
			ns.Print("Invalid staged key bindings. Run herdr-wow keybinds import again.")
			return
		end
		seen[row.key] = true
		if Current(row.key) ~= row.binding then
			table.insert(rows, { key = row.key, binding = row.binding, before = Current(row.key) })
		end
	end
	if #rows == 0 then
		ns.Print("No new shortcuts to import. Stage them with herdr-wow keybinds import --apply, then /reload.")
		return
	end
	local text = "Import Herdr shortcuts into the active WoW binding set?"
	for _, row in ipairs(rows) do
		local label = _G["BINDING_NAME_" .. row.binding] or row.binding
		text = text .. "\n" .. row.key .. " → " .. label
		if row.before ~= "" then text = text .. " (replaces " .. row.before .. ")" end
	end
	text = text .. "\nOther keys stay unchanged."
	StaticPopup_Show("T3CODE_IMPORT_KEYS", text, nil, { set = GetCurrentBindingSet(), rows = rows })
end

function K:Undo()
	if not CanChange() then return end
	local data = ns.db.bindingImportBackup
	if not data or data.set ~= GetCurrentBindingSet() then
		ns.Print("No import backup for the active binding set.")
		return
	end
	for _, row in ipairs(data.rows) do
		if Current(row.key) ~= row.binding then
			ns.Print("An imported key changed. Undo cancelled so your newer bindings stay unchanged.")
			return
		end
	end
	-- Keep the backup if a restore fails, and roll back partial changes.
	for _, row in ipairs(data.rows) do
		if not SetBinding(row.key, row.before ~= "" and row.before or nil) then
			for _, original in ipairs(data.rows) do SetBinding(original.key, original.binding) end
			ns.Print("Undo failed. Imported key bindings were restored.")
			return
		end
	end
	SaveBindings(data.set)
	ns.db.bindingImportBackup = nil
	ns.Print("Previous key bindings restored.")
end
