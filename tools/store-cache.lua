-- Session transcript-cache regressions; run with lua5.1 and luajit.
local ns = { Fire = function() end }
assert(loadfile("addon/T3Code/Core/Store.lua"))("T3Code", ns)
local store = ns.Store
local function apply(id, text)
	store:Apply({ view = {
		id = id, msgs = { { r = "a", t = text } },
		pending = { id = "old-approval", kind = "approval" }, act = "Working",
	} })
end
local function view(id)
	ns.viewId = id
	return store:View()
end

assert(view("unvisited") == nil, "first visit still loads")
apply("a", "First reply")
assert(view("a").pending, "fresh view retains interactive requests")
apply("b", "Another chat")
assert(view("a").msgs[1].t == "First reply", "switching back shows cached content")
assert(not view("a").pending and not view("a").act, "cached views have no stale controls or activity")
store:Apply({ view = { id = "a", loading = true } })
assert(view("a").msgs[1].t == "First reply", "loading snapshot does not replace cache")
apply("a", "Updated reply")
assert(view("a").msgs[1].t == "Updated reply", "fresh snapshot replaces cached content")
store:Apply({})
assert(view("a").msgs[1].t == "Updated reply", "snapshot without a view preserves cache")

-- Fill the cache, then read the oldest entry so it becomes most recent.
for i = 1, 10 do apply("chat" .. i, tostring(i)) end
assert(view("a"), "cache holds twelve chats")
apply("chat11", "11")
assert(view("b") == nil, "least recently used entry is evicted")
assert(view("a"), "recently revisited entry survives eviction")
assert(view("chat1"), "other cached entries survive eviction")

local reloaded = { Fire = function() end, viewId = "a" }
assert(loadfile("addon/T3Code/Core/Store.lua"))("T3Code", reloaded)
assert(reloaded.Store:View() == nil, "cache clears on UI reload")
print("ok - recent chat cache, refresh, safe fallback, LRU eviction and reload")
