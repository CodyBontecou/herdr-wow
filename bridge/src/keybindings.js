// Import only declarative [keys] shortcuts. Never execute custom commands or
// import unrelated settings (including launch directories and credentials).
export const KEY_ACTIONS = Object.freeze({
  new_tab: 'T3CODE_NEW',
  next_tab: 'T3CODE_NEXT_THREAD',
  previous_tab: 'T3CODE_PREVIOUS_THREAD',
  close_tab: 'T3CODE_CLOSE_THREAD',
  next_workspace: 'T3CODE_NEXT_WORKSPACE',
  previous_workspace: 'T3CODE_PREVIOUS_WORKSPACE',
});
const DEFAULTS = { new_tab: 'prefix+c', next_tab: 'prefix+n', previous_tab: 'prefix+p', close_tab: 'prefix+shift+x', next_workspace: '', previous_workspace: '' };

// A small TOML lexer lets us ignore whole custom-command strings, including
// multiline scripts containing fake [keys] headers. This is not a TOML parser:
// only single-line string assignments in [keys] are accepted below.
function statements(text) {
  const result = [];
  let value = '', quote = null, triple = false, comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment) {
      if (c !== '\n') continue;
      comment = false;
    }
    if (quote) {
      value += c;
      if (quote === '"' && c === '\\') { value += text[++i] || ''; continue; }
      if (c === quote) {
        if (!triple) quote = null;
        else if (text.slice(i, i + 3) === quote.repeat(3)) {
          value += text.slice(i + 1, i + 3);
          i += 2;
          quote = null;
        }
      } else if (c === '\n' && !triple) throw new Error('Invalid single-line TOML string');
    } else if (c === '#') comment = true;
    else if (c === '"' || c === "'") {
      quote = c;
      triple = text.slice(i, i + 3) === c.repeat(3);
      value += triple ? c.repeat(3) : c;
      if (triple) i += 2;
    } else if (c === '\n') { result.push(value.trim()); value = ''; }
    else value += c;
  }
  if (quote) throw new Error('Unterminated TOML string');
  if (value.trim()) result.push(value.trim());
  return result;
}

function readKeys(text) {
  const keys = {};
  let inKeys = false;
  for (const line of statements(text)) {
    if (!line) continue;
    if (line.startsWith('[')) { inKeys = line === '[keys]'; continue; }
    if (!inKeys) continue;
    const match = /^([a-z_]+)\s*=\s*(.*)$/s.exec(line);
    if (!match) throw new Error('Unsupported [keys] syntax; use simple key = "shortcut" entries');
    const [, name, raw] = match;
    if (Object.hasOwn(keys, name)) throw new Error(`Duplicate Herdr key: ${name}`);
    if (raw.startsWith('"""') || raw.startsWith("'''")) throw new Error(`Multiline shortcut is not supported: ${name}`);
    if (/^'[^'\n]*'$/.test(raw)) keys[name] = raw.slice(1, -1);
    else {
      try { keys[name] = JSON.parse(raw); } catch { throw new Error(`Unsupported shortcut string: ${name}`); }
      if (typeof keys[name] !== 'string') throw new Error(`Shortcut must be a string: ${name}`);
    }
  }
  return keys;
}

const MODIFIERS = { ctrl: 'CTRL', control: 'CTRL', alt: 'ALT', shift: 'SHIFT' };
const SPECIAL = { enter: 'ENTER', tab: 'TAB', esc: 'ESCAPE', escape: 'ESCAPE', space: 'SPACE', backspace: 'BACKSPACE', delete: 'DELETE', insert: 'INSERT', home: 'HOME', end: 'END', pageup: 'PAGEUP', pagedown: 'PAGEDOWN', left: 'LEFT', right: 'RIGHT', up: 'UP', down: 'DOWN', minus: '-', comma: ',', period: '.', slash: '/', backtick: '`', equal: '=' };

function wowKey(shortcut, prefixModifier) {
  let tokens = shortcut.toLowerCase().split('+');
  if (tokens.includes('prefix')) {
    if (!prefixModifier) throw new Error('prefix sequence needs --prefix-modifier ctrl-alt (or another modifier chord)');
    tokens = tokens.flatMap((t) => t === 'prefix' ? prefixModifier.toLowerCase().split(/[+-]/) : [t]);
  }
  const key = tokens.pop();
  const mods = new Set();
  for (const token of tokens) {
    if (!MODIFIERS[token]) throw new Error(`unsupported modifier: ${token || '(empty)'}`);
    mods.add(MODIFIERS[token]);
  }
  const name = /^[a-z0-9]$/.test(key) || /^f(?:[1-9]|1\d|2[0-4])$/.test(key) ? key.toUpperCase() : SPECIAL[key];
  if (!name) throw new Error(`unsupported key: ${key || '(empty)'}`);
  if (!mods.size && !/^F\d+$/.test(name)) throw new Error('unmodified keys are not imported; add a modifier');
  // WoW accepts arbitrary strings in SetBinding, but physical key dispatch
  // looks up modifiers in ALT-CTRL-SHIFT order. A different order saves a
  // binding that GetBindingAction can read but no keyboard chord can trigger.
  return [...['ALT', 'CTRL', 'SHIFT'].filter((m) => mods.has(m)), name].join('-');
}

export function importKeybindings(text, { prefixModifier } = {}) {
  if (prefixModifier && !/^(?:ctrl|alt|shift)(?:[+-](?:ctrl|alt|shift))*$/i.test(prefixModifier)) throw new Error('Prefix replacement must contain only ctrl, alt and/or shift');
  const keys = readKeys(text);
  const bindings = [], skipped = [];
  for (const [action, binding] of Object.entries(KEY_ACTIONS)) {
    const shortcut = keys[action] ?? DEFAULTS[action];
    if (!shortcut) { skipped.push(`${action}: disabled`); continue; }
    try { bindings.push({ action, binding, key: wowKey(shortcut, prefixModifier), source: shortcut }); }
    catch (err) { skipped.push(`${action}: ${err.message}`); }
  }
  for (const action of Object.keys(keys)) {
    if (action !== 'prefix' && !KEY_ACTIONS[action]) skipped.push(`${action}: no addon equivalent`);
  }
  const seen = new Set();
  for (const { key } of bindings) {
    if (seen.has(key)) throw new Error(`Multiple actions map to ${key}; fix the Herdr shortcuts before importing`);
    seen.add(key);
  }
  return { bindings, skipped };
}
