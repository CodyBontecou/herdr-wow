import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importKeybindings } from '../src/keybindings.js';

test('uses WoW modifier dispatch order rather than preserving terminal modifier order', () => {
  const result = importKeybindings('[keys]\nnext_workspace = "ctrl+alt+j"\nprevious_workspace = "shift+ctrl+alt+k"');
  assert.deepEqual(result.bindings.map(({ key }) => key), ['ALT-CTRL-J', 'ALT-CTRL-SHIFT-K']);
});

test('imports direct tab shortcuts and reports unsupported actions without importing commands', () => {
  const result = importKeybindings(`[keys]
new_tab = "ctrl+alt+t"
next_tab = 'alt+shift+right' # comment
previous_tab = "ctrl+alt+h"
close_tab = "ctrl+alt+w"
next_workspace = "ctrl+alt+j"
previous_workspace = "ctrl+alt+k"
new_workspace = "ctrl+alt+n"
[[keys.command]]
key = "ctrl+alt+p"
command = '''
[keys]
close_tab = "ctrl+alt+q"
'''
[ui]
sidebar_width = 40
`);
  assert.deepEqual(result.bindings.map(({ key }) => key), ['ALT-CTRL-T', 'ALT-SHIFT-RIGHT', 'ALT-CTRL-H', 'ALT-CTRL-W', 'ALT-CTRL-J', 'ALT-CTRL-K']);
  assert.deepEqual(result.bindings.slice(-2).map(({ binding }) => binding), ['T3CODE_NEXT_WORKSPACE', 'T3CODE_PREVIOUS_WORKSPACE']);
  assert.deepEqual(result.skipped, ['new_workspace: no addon equivalent']);
});

test('prefix sequences require explicit modifier translation and missing actions use defaults', () => {
  assert.equal(importKeybindings('').bindings.length, 0);
  const result = importKeybindings('[keys]\nprefix = "ctrl+b"\nnew_tab = "prefix+shift+t"', { prefixModifier: 'ctrl-alt' });
  assert.deepEqual(result.bindings.map(({ key }) => key), ['ALT-CTRL-SHIFT-T', 'ALT-CTRL-N', 'ALT-CTRL-P', 'ALT-CTRL-SHIFT-X']);
  assert.throws(() => importKeybindings('', { prefixModifier: 'cmd' }), /only ctrl/);
});

test('disabled and unsupported shortcuts are skipped; collisions and malformed keys fail closed', () => {
  const result = importKeybindings('[keys]\nnew_tab = ""\nnext_tab = "cmd+n"\nprevious_tab = "p"\nclose_tab = "f12"');
  assert.deepEqual(result.bindings.map(({ key }) => key), ['F12']);
  assert.equal(result.skipped.length, 5);
  assert.throws(() => importKeybindings('[keys]\nnew_tab = "ctrl+x"\nclose_tab = "ctrl+x"'), /Multiple actions/);
  assert.throws(() => importKeybindings('[keys]\nnew_tab = true'), /must be a string/);
  assert.throws(() => importKeybindings('[keys]\nnew_tab = "x"\nnew_tab = "y"'), /Duplicate/);
  assert.throws(() => importKeybindings('[keys]\nnew_tab = "unterminated'), /Unterminated/);
  assert.throws(() => importKeybindings('[keys]\nnew_tab = """ctrl+t"""'), /Multiline/);
});
