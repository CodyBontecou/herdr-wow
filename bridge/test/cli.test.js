import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/t3code-wow.js', import.meta.url));

test('keybinding import previews without writes, stages only declarative data and survives sync', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-wow-keys-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), HERDR_CONFIG_PATH: path.join(root, 'herdr.toml') };
  const addon = path.join(root, 'addons/T3Code');
  const configDir = path.join(env.XDG_CONFIG_HOME, 't3code-wow');
  fs.mkdirSync(addon, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const config = JSON.stringify({ addonsDir: path.dirname(addon), backend: 'herdr' });
  fs.writeFileSync(path.join(configDir, 'config.json'), config);
  fs.writeFileSync(env.HERDR_CONFIG_PATH, '[keys]\nnew_tab = "ctrl+alt+t"\nnext_tab = "ctrl+alt+l"\nprevious_tab = "ctrl+alt+h"\nclose_tab = "ctrl+alt+w"\n');
  fs.writeFileSync(path.join(addon, 'T3Code.toc'), 'ImportedBindings.lua\n');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 15000 });
  assert.match(run('keybinds', 'import'), /Preview only/);
  const imported = path.join(addon, 'ImportedBindings.lua');
  assert.equal(fs.existsSync(imported), false);
  assert.match(run('keybinds', 'import', '--apply'), /herdr importkeys/);
  const data = fs.readFileSync(imported, 'utf8');
  assert.match(data, /ALT-CTRL-T/);
  assert.match(data, /T3CODE_CLOSE_THREAD/);
  run('sync');
  assert.equal(fs.readFileSync(imported, 'utf8'), data);
  assert.equal(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'), config);
  fs.writeFileSync(env.HERDR_CONFIG_PATH, '[keys]\nnew_tab = "ctrl+alt+y"\n');
  run('keybinds', 'import', '--apply');
  assert.equal(fs.readFileSync(`${imported}.bak`, 'utf8'), data);
});

test('uninstall removes both owned CLI aliases without removing unrelated symlinks', (t) => {
  for (const foreignAlias of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-wow-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') };
    const configDir = path.join(env.XDG_CONFIG_HOME, 't3code-wow');
    const dataDir = path.join(env.XDG_DATA_HOME, 't3code-wow');
    const bin = path.join(root, '.local/bin');
    const wowDir = path.join(root, 'wow/_forever_');
    const addon = path.join(wowDir, 'Interface/AddOns/T3Code');
    for (const dir of [configDir, dataDir, bin, addon]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ wowDir, backend: 'herdr' }));
    const target = path.join(dataDir, 'bridge-cli');
    const foreign = path.join(env.XDG_DATA_HOME, 't3code-wow-unrelated');
    fs.writeFileSync(target, 'owned');
    fs.writeFileSync(foreign, 'not owned');
    const current = path.join(bin, 'herdr-wow');
    const legacy = path.join(bin, 't3code-wow');
    fs.symlinkSync(foreignAlias ? foreign : target, current);
    fs.symlinkSync(target, legacy);
    execFileSync(process.execPath, [cli, 'uninstall', '--yes'], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.existsSync(dataDir), false);
    assert.equal(fs.existsSync(addon), false);
    if (foreignAlias) assert.equal(fs.readlinkSync(current), foreign);
    else assert.equal(fs.existsSync(current), false);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'not owned');
  }
});
