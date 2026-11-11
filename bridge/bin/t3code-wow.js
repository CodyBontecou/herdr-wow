#!/usr/bin/env node
// herdr-wow: Herdr inside World of Warcraft: Forever.
// The script filename and legacy installation paths remain stable for upgrades.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge, STATE_DIR, VERSION } from '../src/bridge.js';
import { CONFIG_DIR, mintToken, readToken, tokenClaims, findT3Cli } from '../src/auth.js';
import { findWowInstalls, addonsDir as addonsDirOf, findWowProcess } from '../src/wow.js';
import { SlotBank, ADDON, CTL_LONG } from '../src/slots.js';
import { StripCapture, MAC_CAPTURE } from '../src/capture.js';
import { validateHerdrConfig, herdrCommand } from '../src/herdr.js';
import { decodeImage } from '../src/codec.js';
import { acquireInstance, installAgent, removeAgent } from '../src/service.js';
import { importKeybindings } from '../src/keybindings.js';
import { luaValue } from '../src/luaser.js';
import { identify, discoverTailscale, mintRemote, revokeRemote, saveToken, readTokenData, tokenFile } from '../src/envs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const UNIT_NAME = 't3code-wow.service';
const UNIT_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user', UNIT_NAME);
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 't3code-wow');
const BIN_LINK = path.join(os.homedir(), '.local/bin/t3code-wow');
const HERDR_BIN_LINK = path.join(os.homedir(), '.local/bin/herdr-wow');
const DEFAULT_SLOTS = 1200;

const C = process.stdout.isTTY
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { b: String, g: String, y: String, r: String, d: String };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// The addon ships next to the bridge (repo layout) or inside it (installed layout).
function addonSource() {
  for (const p of [path.join(BRIDGE_ROOT, '..', 'addon', ADDON), path.join(BRIDGE_ROOT, 'addon', ADDON)]) {
    if (fs.existsSync(path.join(p, `${ADDON}.toc`))) return p;
  }
  throw new Error('could not find the addon sources next to the bridge');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function resolveWowDir(args, cfg) {
  if (args.wow) {
    const dir = path.resolve(String(args.wow));
    if (fs.existsSync(path.join(dir, '_forever_'))) return path.join(dir, '_forever_');
    return dir;
  }
  if (cfg.wowDir && fs.existsSync(cfg.wowDir)) return cfg.wowDir;
  const { forever, wowOnly, prefixes } = findWowInstalls();
  if (forever.length > 1) console.log(C.y(`Found several WoW: Forever installs, using the first (pick one with --wow):\n  ${forever.join('\n  ')}`));
  if (forever.length) return forever[0];
  const where = '\nIf it\'s somewhere else, pass --wow "/path/to/World of Warcraft".';
  if (wowOnly.length) {
    throw new Error(`found World of Warcraft at ${wowOnly[0]}, but not WoW: Forever. Install Forever from Battle.net (it's a separate game version), launch it once, then run ./install.sh again.${where}`);
  }
  if (prefixes.length) {
    throw new Error(`found Battle.net (${prefixes[0]}) but no World of Warcraft. Install WoW: Forever from Battle.net, launch it once, then run ./install.sh again.${where}`);
  }
  throw new Error(`couldn't find Battle.net. On Omarchy, install it with omarchy-install-gaming-battlenet, install WoW: Forever from it and launch it once, then run ./install.sh again.${where}`);
}

// Quiet unless it fails (enabling prints "Created symlink …", which isn't news).
function systemctl(...args) {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  if (r.status !== 0) process.stderr.write(r.stderr || `systemctl --user ${args.join(' ')} failed\n`);
  return r.status === 0;
}

// Copy just the addon code (leaving Signals/ and generated media alone).
function syncAddon(addonsDir) {
  const src = addonSource();
  const dst = path.join(addonsDir, ADDON);
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'Signals') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    // This file is user-staged data, not addon code. Keep imports on upgrades.
    if (e.name === 'ImportedBindings.lua' && fs.existsSync(d)) continue;
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  return dst;
}

async function cmdInstall(args) {
  const cfg = readConfig();
  // Pre-backend configurations came from the original T3 installer.
  const backend = String(args.backend || cfg.backend || (cfg.wowDir || cfg.addonsDir ? 't3' : 'herdr'));
  if (!['t3', 'herdr'].includes(backend)) throw new Error('Choose --backend t3 or --backend herdr');
  if (backend === 'herdr') {
    validateHerdrConfig(cfg.herdr);
    await herdrCommand(['workspace', 'list'], { session: cfg.herdr?.session || 'default' });
  }
  if (process.platform === 'darwin') {
    const source = path.join(BRIDGE_ROOT, 'native/mac-capture.swift');
    if (!fs.existsSync(MAC_CAPTURE) || fs.statSync(source).mtimeMs > fs.statSync(MAC_CAPTURE).mtimeMs) {
      console.log('Building the macOS screen-capture helper…');
      const temp = `${MAC_CAPTURE}.new`;
      execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', source, '-o', temp], { stdio: 'inherit', timeout: 120000 });
      execFileSync(temp, ['self-test']);
      fs.renameSync(temp, MAC_CAPTURE);
    }
    execFileSync(MAC_CAPTURE, ['self-test']);
  }
  const wowDir = resolveWowDir(args, cfg);
  const addonsDir = addonsDirOf(wowDir);
  console.log(`${C.b('World of Warcraft:')} ${wowDir}`);
  fs.mkdirSync(addonsDir, { recursive: true });

  // The game only discovers new addon folders and sound files when it starts.
  const freshAddon = !fs.existsSync(path.join(addonsDir, ADDON, `${ADDON}.toc`));
  const dst = syncAddon(addonsDir);
  console.log(`${C.g('✓')} Addon installed to ${dst}`);

  const slots = Number(args.slots || cfg.slots || DEFAULT_SLOTS);
  const bank = new SlotBank(addonsDir, { slots });
  const had = bank.installedSlotCount();
  const bellsMissing = !fs.existsSync(bank.sigFile(CTL_LONG));
  const { made, pruned } = bank.install();
  if (had > slots) bank.removeSlots(slots);
  console.log(`${C.g('✓')} ${slots} live-update slots ready ${C.d(`(${made} files written${pruned ? `, ${pruned} unused signal files removed` : ''})`)}`);

  const { signals: _legacySignals, ...rest } = cfg;
  const next = { ...rest, backend, wowDir, addonsDir, slots };
  writeConfig(next);

  if (backend === 't3') {
    if (!findT3Cli()) {
      console.log(C.r('✗ The `t3` command was not found. Open T3 Code once (it installs `t3`), then run `herdr-wow install` again.'));
      process.exitCode = 1;
      return;
    }
    const token = readToken();
    const claims = token && tokenClaims(token);
    if (!claims || (claims.exp && claims.exp < Date.now() + 86400000)) {
      process.stdout.write('… Creating a T3 Code session for the bridge (this takes a few seconds)\r');
      await mintToken();
    }
    console.log(`${C.g('✓')} T3 Code session ready ${C.d('(scoped to reading and running threads; revoke with `t3 auth session list`)')}`);
  } else {
    console.log(`${C.g('✓')} Herdr ready; browsing all spaces and tabs. New Pi sessions use configured launch projects.`);
  }

  const service = !args['no-service'] && ['linux', 'darwin'].includes(process.platform);
  if (service && process.platform === 'darwin') {
    // Migrate only an identifiable foreground bridge, never an arbitrary saved PID.
    const st = readStatus();
    if (st?.pid && st.pid !== process.pid) {
      let command = '';
      try { command = execFileSync('/bin/ps', ['-p', String(st.pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch {}
      const scripts = [HERDR_BIN_LINK, BIN_LINK, path.join(BRIDGE_ROOT, 'bin/t3code-wow.js')];
      if (scripts.some((script) => command.endsWith(`${script} run`) || command.endsWith(`${script} run --verbose`))) {
        process.kill(st.pid, 'SIGTERM');
        for (let i = 0; i < 50; i++) {
          try { process.kill(st.pid, 0); } catch { break; }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    await installAgent({ node: process.execPath, script: path.join(DATA_DIR, 'bridge/bin/t3code-wow.js'), stateDir: STATE_DIR, envPath: process.env.PATH || '' });
    const since = Date.now();
    let ready = false;
    for (let i = 0; i < 50; i++) {
      const status = readStatus();
      if (status && Date.parse(status.at) >= since) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`LaunchAgent started but has not reported healthy startup. Check ${path.join(STATE_DIR, 'bridge.log')}`);
    console.log(`${C.g('✓')} Bridge installed as a macOS LaunchAgent (restarts after crashes)`);
  }
  if (service && process.platform === 'linux') {
    const node = process.execPath;
    const script = path.join(BRIDGE_ROOT, 'bin', 't3code-wow.js');
    fs.mkdirSync(path.dirname(UNIT_FILE), { recursive: true });
    fs.writeFileSync(UNIT_FILE, [
      '[Unit]',
      'Description=Herdr bridge for World of Warcraft',
      'After=graphical-session.target',
      '',
      '[Service]',
      `ExecStart=${node} ${script} run`,
      'Restart=always',
      'RestartSec=3',
      `Environment=PATH=${process.env.PATH}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'));
    systemctl('daemon-reload');
    systemctl('enable', UNIT_NAME);
    systemctl('restart', UNIT_NAME);
    console.log(`${C.g('✓')} Bridge running as the ${UNIT_NAME} user service`);
  }

  if (!service) console.log('Start the bridge in a terminal with `herdr-wow run`. Keep that terminal running.');
  console.log('');
  await firstLaunch({
    restart: freshAddon || had < slots || bellsMissing,
    running: !!findWowProcess(wowDir),
    waiting: service && process.stdin.isTTY && process.stdout.isTTY,
    since: Date.now(),
    backend,
  });
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

// After installing: say exactly what to do in the game, then wait (Enter skips) until
// the addon checks in, so you know it works before you go looking for it.
async function firstLaunch({ restart, running, waiting, since, backend }) {
  let step;
  if (restart) step = running ? 'Quit World of Warcraft completely and start it again, then log in to a character.' : 'Start World of Warcraft: Forever and log in to a character.';
  else step = running ? 'Type /reload in game.' : 'Start World of Warcraft: Forever and log in to a character.';
  console.log(`${C.b('Next:')} ${step}`);
  if (restart && running) console.log(C.d('  The game only finds new addon files when it starts, so a /reload isn\'t enough this time.'));

  let connected = null;
  if (waiting) {
    let skipped = false;
    process.stdin.resume();
    process.stdin.once('data', () => {
      skipped = true;
    });
    let shown = '';
    const until = Date.now() + 20 * 60 * 1000;
    while (!skipped && Date.now() < until) {
      const st = readStatus();
      if (st?.addon && st.addon.lastSeen >= since) {
        connected = st;
        break;
      }
      const msg = st?.wow ? 'World of Warcraft is running. Waiting for you to log in… (Enter to skip)' : 'Waiting for World of Warcraft to start… (Enter to skip)';
      if (msg !== shown) {
        process.stdout.write(`\r\x1b[2K${C.d(msg)}`);
        shown = msg;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.stdin.pause();
    process.stdout.write('\r\x1b[2K');
    if (connected) {
      // The first hello can arrive before the addon has its link keys; give it a moment.
      for (let i = 0; i < 8 && !readStatus()?.addon?.encrypted; i++) await new Promise((r) => setTimeout(r, 1000));
      const enc = readStatus()?.addon?.encrypted;
      console.log(`${C.g('✓')} Connected: the game and the bridge are talking${enc ? ' over an encrypted link' : ''}.`);
    } else if (!skipped) {
      console.log(C.y('The game hasn\'t checked in yet. Once you\'re in, `herdr-wow status` shows whether it connected.'));
    }
  }
  console.log(`
${C.b('In game')}
  /herdr                    open or close Herdr (or click its minimap button; /t3 still works)
  both triggers + Back      open it from a controller
  /herdr selftest           check the link step by step if something seems off

${C.b('From here')}
  ${backend === 'herdr' ? 'New Thread in game          start Pi in a background Herdr tab' : 'herdr-wow env add <host>   show threads from another machine (T3 Connect)'}
  herdr-wow status           what the bridge sees
  rerun the install command   update
  herdr-wow uninstall        remove this addon and bridge (not Herdr's tabs)`);
}

function cmdSync(args) {
  const cfg = readConfig();
  const addonsDir = cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  // The game only discovers new addon folders and sound files when it starts.
  const freshAddon = !fs.existsSync(path.join(addonsDir, ADDON, `${ADDON}.toc`));
  const dst = syncAddon(addonsDir);
  console.log(`${C.g('✓')} Addon code copied to ${dst}. Type /reload in game.`);
}

async function cmdRun(args) {
  const cfg = readConfig();
  const addonsDir = cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  const release = await acquireInstance(STATE_DIR);
  let bridge;
  try {
    bridge = new Bridge({ addonsDir, config: { ...cfg, verbose: args.verbose || cfg.verbose } });
  } catch (err) {
    await release();
    throw err;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    bridge.stop();
    await bridge.commandTail;
    bridge.flushState();
    await release();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await bridge.start();
  } catch (err) {
    bridge.stop();
    await release();
    throw err;
  }
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function cmdStatus(args) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8'));
  } catch {
    console.log(C.r('The bridge has not run yet.'), 'Start it with `herdr-wow install` or `herdr-wow run`.');
    process.exitCode = 1;
    return;
  }
  if (args.json) return console.log(JSON.stringify(st, null, 2));
  const age = Date.now() - Date.parse(st.at);
  const alive = age < 10000;
  const ok = (b) => (b ? C.g('●') : C.r('●'));
  console.log(`${ok(alive)} Bridge ${st.version} ${alive ? `responding (pid ${st.pid})` : `status stale (last seen ${ago(age)})`}`);
  console.log(`${ok(st.t3.state === 'connected')} ${st.backend || 'T3 Code'}: ${st.t3.state}${st.t3.error ? ` — ${st.t3.error}` : ''} ${C.d(`(${st.t3.threads} threads, ${st.t3.origin || '?'})`)}`);
  console.log(`${ok(!!st.wow)} WoW: ${st.wow ? `running (pid ${st.wow.pid})` : 'not running'}`);
  console.log(`${ok(st.capture.state === 'ok' || st.capture.state === 'idle')} Screen link: ${st.capture.state} via ${st.capture.backend} ${C.d(`(${st.capture.decoded} frames read, ${st.capture.rejected} rejected)`)}${st.capture.lastError ? `\n    ${C.y(st.capture.lastError)}` : ''}`);
  if (st.capture.lastCaptureAt) console.log(`  Last successful capture: ${ago(Date.now() - st.capture.lastCaptureAt)}`);
  if (st.link) console.log(`${ok(alive && ['idle', 'updating'].includes(st.link.state))} Addon round trip: ${st.link.state}${st.link.lastAckAt ? `; last acknowledged update ${ago(Date.now() - st.link.lastAckAt)}` : '; no update acknowledged yet'}${['idle', 'idle-unverified'].includes(st.link.state) ? ' (not a continuous liveness check)' : ''}`);
  if (st.addon) {
    console.log(`${ok(alive && !['capture-error', 'capture-stalled', 'awaiting-ack'].includes(st.link?.state))} Addon ${st.addon.version}: last heard ${ago(Date.now() - st.addon.lastSeen)}; window ${st.addon.flags.includes('o') ? 'open' : 'closed'}`);
    console.log(`${ok(st.addon.encrypted)} Link ${st.addon.encrypted ? 'encrypted' : 'not encrypted yet (waiting for the addon to load its keys)'}${st.rejected?.forged ? C.d(` · ${st.rejected.forged} unauthenticated frames ignored`) : ''}`);
  } else {
    console.log(`${ok(false)} Addon: not heard from yet ${C.d('(log in, then /herdr)')}`);
  }
  console.log(`  Live updates left this session: ${st.slots.remaining}/${st.slots.total} ${C.d(`· ${st.publishes} updates sent · update bell #${st.signals.next}`)}`);
  console.log(`  Speech: ${st.voice.tts || C.y('none')} · Dictation: ${st.voice.dictation || C.y('none')}`);
  if (args.log || args.v) {
    console.log('');
    for (const l of st.log) console.log(C.d(l));
  }
}

async function cmdProbe() {
  const cfg = readConfig();
  const proc = findWowProcess(cfg.wowDir);
  const cap = new StripCapture(cfg.capture || {});
  console.log(`backend: ${cap.resolveBackend()}; WoW pid: ${proc?.pid ?? 'not running'}`);
  const res = await cap.grab(proc?.pid);
  if (res.status !== 'ok') return console.log(`capture: ${res.status}`);
  const out = path.join(os.tmpdir(), 'herdr-wow-probe.ppm');
  const img = res.image;
  fs.writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${img.width} ${img.height}\n255\n`), Buffer.from(img.data)]));
  let png = out;
  try {
    execFileSync('magick', [out, out.replace(/\.ppm$/, '.png')]);
    png = out.replace(/\.ppm$/, '.png');
  } catch {}
  const dec = decodeImage(img);
  console.log(`captured ${img.width}x${img.height} -> ${png}`);
  if (!dec) console.log('no strip visible (open the Herdr window in game, or send something)');
  else if (dec.error) console.log(`strip found but unreadable: ${dec.error} (cell ${dec.geo.cell}px at ${dec.geo.ox},${dec.geo.oy})`);
  else console.log(`strip decoded: seq ${dec.seq}, ${dec.payload.length} bytes, cell ${dec.geo.cell}px at ${dec.geo.ox},${dec.geo.oy}`);
}

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// Remove everything install put on this computer, and revoke the bridge's sessions.
async function cmdUninstall(args) {
  const cfg = readConfig();
  if (!args.yes) {
    console.log('This removes Herdr for World of Warcraft: the addon and its update folders, its settings in the game,');
    console.log('the bridge service, the bridge\'s T3 Code sessions (on every machine it was added to) and its files.');
    if (!(await ask('Remove it? [y/N] '))) {
      console.log(process.stdin.isTTY ? 'Nothing removed.' : 'Nothing removed. Run `herdr-wow uninstall --yes` to remove without asking.');
      return;
    }
  }
  const done = (msg) => console.log(`${C.g('✓')} ${msg}`);
  const warn = (msg) => console.log(`${C.y('!')} ${msg}`);

  if (process.platform === 'darwin') removeAgent();
  if (fs.existsSync(UNIT_FILE)) {
    spawnSync('systemctl', ['--user', 'disable', '--now', UNIT_NAME], { stdio: 'ignore' });
    fs.rmSync(UNIT_FILE);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    done('Stopped and removed the bridge service');
  }

  let wowDir = cfg.wowDir;
  if (!wowDir) {
    try {
      wowDir = findWowInstalls().forever[0];
    } catch {}
  }
  const addonsDir = cfg.addonsDir || (wowDir && addonsDirOf(wowDir));
  if (addonsDir && fs.existsSync(addonsDir)) {
    const n = new SlotBank(addonsDir).removeSlots(0);
    fs.rmSync(path.join(addonsDir, ADDON), { recursive: true, force: true });
    done(`Removed the addon and ${n} update folders from the game`);
  }
  if (wowDir) {
    // The addon's saved settings (account-wide SavedVariables).
    let removed = 0;
    const accounts = path.join(wowDir, 'WTF', 'Account');
    try {
      for (const acct of fs.readdirSync(accounts)) {
        for (const f of [`${ADDON}.lua`, `${ADDON}.lua.bak`]) {
          const p = path.join(accounts, acct, 'SavedVariables', f);
          if (fs.existsSync(p)) {
            fs.rmSync(p);
            removed++;
          }
        }
      }
    } catch {}
    if (removed) done('Removed its saved settings from the game');
  }

  // Revoke the sessions the bridge was given, here and on other machines.
  const claims = tokenClaims(readToken() || '');
  const t3 = findT3Cli();
  if (claims?.sid && t3) {
    const r = spawnSync(t3, ['auth', 'session', 'revoke', claims.sid], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0) done('Revoked the bridge\'s T3 Code session');
    else warn(`Couldn't revoke the bridge's T3 Code session; remove it with \`t3 auth session list\` (${claims.sid}).`);
  }
  for (const e of cfg.environments || []) {
    const tok = readTokenData(e.id);
    if (!tok?.sessionId || !e.ssh) continue;
    try {
      await revokeRemote(e.ssh, tok.sessionId);
      done(`Revoked the bridge's session on ${e.label}`);
    } catch (err) {
      warn(`Couldn't revoke the bridge's session on ${e.label} (${err.message.split('\n')[0]}); remove it there with \`t3 auth session list\`.`);
    }
  }

  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  done('Removed the bridge\'s settings and state');

  for (const link of [HERDR_BIN_LINK, BIN_LINK]) {
    try {
      const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (fs.lstatSync(link).isSymbolicLink() && target.startsWith(path.resolve(DATA_DIR) + path.sep)) fs.rmSync(link);
    } catch {}
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  done('Removed bridge files and this installation\'s command aliases');

  if (findWowProcess()) console.log(`\nWorld of Warcraft is running: ${C.b('/reload')} or restart it to finish unloading Herdr.`);
}

async function cmdEnv(args) {
  const sub = args._[1];
  const cfg = readConfig();
  if (cfg.backend === 'herdr') throw new Error('env manages T3 machines. Configure local Herdr projects with `herdr-wow project add`.');
  cfg.environments = cfg.environments || [];
  if (sub === 'list' || !sub) {
    console.log(`${C.b('this computer')} ${C.d('(always shown)')}`);
    for (const e of cfg.environments) {
      const tok = readTokenData(e.id);
      let state = C.r('unreachable');
      for (const url of e.urls) {
        try {
          const id = await identify(url, 4000);
          if (id.environmentId === e.id) {
            state = C.g(`online at ${url}`);
            break;
          }
        } catch {}
      }
      console.log(`${C.b(e.label)} ${state} ${C.d(`· ssh ${e.ssh || '-'} · token ${tok?.expiresAt ? `until ${tok.expiresAt.slice(0, 10)}` : 'missing'}`)}`);
    }
    if (!cfg.environments.length) console.log(C.d('No other machines yet. Add one with: herdr-wow env add <tailscale or ssh host> [--url https://...]'));
    return;
  }
  if (sub === 'add') {
    const host = args._[2];
    if (!host) throw new Error('usage: herdr-wow env add <host> [--url https://...] [--ssh <ssh host>]');
    const ssh = args.ssh ? String(args.ssh) : host;
    const urls = [];
    for (const u of [].concat(args.url || [])) urls.push(String(u).replace(/\/?$/, '/'));
    if (!urls.length) urls.push(...(await discoverTailscale(host)));
    if (!urls.length && /^https?:/.test(host)) urls.push(host);
    if (!urls.length) throw new Error(`couldn't find ${host} on Tailscale; pass --url with its T3 Code address (Settings > Connections on that machine)`);
    let ident;
    let good = [];
    for (const url of urls) {
      try {
        const id = await identify(url);
        if (ident && id.environmentId !== ident.environmentId) continue;
        ident = ident || id;
        good.push(url);
      } catch (err) {
        console.log(C.y(`  ${url}: ${err.message}`));
      }
    }
    if (!ident) throw new Error(`no T3 Code server answered at ${urls.join(', ')}`);
    if (ident.orchestrationProtocolVersion !== 2) throw new Error(`${ident.label} runs an incompatible T3 Code (protocol ${ident.orchestrationProtocolVersion}); update it`);
    const local = JSON.parse(await (await fetch(new URL('/.well-known/t3/environment', JSON.parse(fs.readFileSync(path.join(process.env.T3CODE_HOME || path.join(os.homedir(), '.t3'), 'userdata', 'server-runtime.json'), 'utf8')).origin))).text());
    if (ident.environmentId === local.environmentId) throw new Error(`${host} is this computer`);
    console.log(`${C.g('✓')} Found ${C.b(ident.label)} (${ident.platform?.machine || 'machine'}, T3 Code ${ident.serverVersion}) at ${good.join(', ')}`);
    process.stdout.write(`… Creating a T3 Code session on ${ident.label} over SSH (${ssh})\r`);
    const tok = await mintRemote(ssh, `WoW bridge (${local.label || os.hostname()})`);
    saveToken(ident.environmentId, tok);
    console.log(`${C.g('✓')} Session created on ${ident.label} ${C.d(`(revoke with herdr-wow env remove ${ident.label})`)}`);
    const existing = cfg.environments.find((e) => e.id === ident.environmentId);
    const used = new Set(cfg.environments.map((e) => e.code));
    let code = existing?.code;
    for (let n = 1; !code; n++) if (!used.has(`e${n}`)) code = `e${n}`;
    const entry = { code, id: ident.environmentId, label: ident.label || host, ssh, urls: good };
    cfg.environments = cfg.environments.filter((e) => e.id !== ident.environmentId).concat(entry);
    writeConfig(cfg);
    if (fs.existsSync(UNIT_FILE)) systemctl('restart', UNIT_NAME);
    console.log(`${C.g('✓')} ${ident.label}'s threads will show in game within a few seconds.`);
    return;
  }
  if (sub === 'remove') {
    const name = args._[2];
    const e = cfg.environments.find((x) => x.label === name || x.id === name || x.ssh === name);
    if (!e) throw new Error(`no machine called ${name}; see herdr-wow env list`);
    const tok = readTokenData(e.id);
    if (tok?.sessionId && e.ssh) {
      try {
        await revokeRemote(e.ssh, tok.sessionId);
        console.log(`${C.g('✓')} Revoked the bridge's session on ${e.label}`);
      } catch (err) {
        console.log(C.y(`Couldn't revoke the session on ${e.label} (${err.message}); remove it there under Settings > Connections.`));
      }
    }
    fs.rmSync(tokenFile(e.id), { force: true });
    cfg.environments = cfg.environments.filter((x) => x !== e);
    writeConfig(cfg);
    if (fs.existsSync(UNIT_FILE)) systemctl('restart', UNIT_NAME);
    console.log(`${C.g('✓')} Removed ${e.label}`);
    return;
  }
  throw new Error('usage: herdr-wow env [list|add <host>|remove <name>]');
}

// Stage declarative shortcuts only; WoW owns applying and persisting bindings.
async function cmdKeybinds(args) {
  if (args._[1] !== 'import') throw new Error('Use herdr-wow keybinds import [--config FILE] [--prefix-modifier ctrl-alt] [--apply]');
  const source = args.config || process.env.HERDR_CONFIG_PATH || path.join(os.homedir(), '.config/herdr/config.toml');
  if (typeof source !== 'string') throw new Error('--config needs a file path');
  const { bindings, skipped } = importKeybindings(fs.readFileSync(source, 'utf8'), { prefixModifier: args['prefix-modifier'] });
  console.log('Herdr → WoW keybinding preview (only supported actions):');
  for (const b of bindings) console.log(`  ${b.action}: ${b.source} → ${b.key}`);
  for (const reason of skipped) console.log(`  Skipped ${reason}`);
  console.log('Custom commands and unrelated Herdr settings are never imported.');
  if (!args.apply) {
    console.log('Preview only. Add --apply to stage these bindings; WoW will still ask before changing keys.');
    return;
  }
  if (!bindings.length) throw new Error('No supported shortcuts to import');
  const cfg = readConfig();
  const addonsDir = args.wow ? addonsDirOf(resolveWowDir(args, cfg)) : cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  const addon = path.join(addonsDir, ADDON);
  const toc = path.join(addon, `${ADDON}.toc`);
  if (!fs.existsSync(toc) || !fs.readFileSync(toc, 'utf8').includes('ImportedBindings.lua')) throw new Error('Update the addon with ./install.sh before importing keys');
  const target = path.join(addon, 'ImportedBindings.lua');
  const data = bindings.map(({ key, binding }) => ({ key, binding }));
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `-- Generated by herdr-wow keybinds import. No terminal commands are imported.\nlocal _, ns = ...\nns.importedBindings = ${luaValue(data)}\n`, { encoding: 'latin1', mode: 0o600 });
  fs.renameSync(temp, target);
  console.log('Staged. In WoW: /reload, then /herdr importkeys to review conflicts and confirm. No bridge restart needed.');
}

// Explicit allowlist for in-game Pi launches. This only writes configuration;
// it never creates a Herdr workspace or starts an agent.
async function cmdProject(args) {
  const cfg = readConfig();
  if (args._[1] !== 'add' || !args._[2] || !args.cwd || !args.workspace) throw new Error('usage: herdr-wow project add <id> --cwd DIR --workspace ID [--name TEXT] [--session NAME]');
  const id = args._[2];
  const session = args.session || cfg.herdr?.session || 'default';
  const project = { id, name: String(args.name || id), cwd: path.resolve(String(args.cwd)), workspace: String(args.workspace) };
  const herdr = { ...cfg.herdr, session, projects: [...(cfg.herdr?.projects || []).filter((p) => p.id !== id), project] };
  validateHerdrConfig(herdr);
  const { workspaces } = await herdrCommand(['workspace', 'list'], { session });
  if (!workspaces?.some((w) => w.workspace_id === project.workspace)) throw new Error('That workspace does not exist in the selected Herdr session');
  writeConfig({ ...cfg, herdr });
  console.log(`Configured ${id} for Pi in Herdr. Install with --backend herdr, then restart the bridge after configuration changes.`);
}

function help() {
  console.log(`${C.b('herdr-wow')} ${VERSION} — Herdr inside World of Warcraft: Forever

  herdr-wow install [--backend herdr|t3] [--wow DIR] [--slots N] [--no-service]
                     Install the addon and bridge (new installs default to Herdr)
  herdr-wow status [--log] [--json]
                     Show backend, game, capture and addon status
  herdr-wow sync      Re-copy the installed addon; rerun ./install.sh for checkout edits
  herdr-wow keybinds import [--config FILE] [--prefix-modifier ctrl-alt] [--apply] [--wow DIR]
                     Preview Herdr shortcuts; --apply stages them for /herdr importkeys
  herdr-wow run [--verbose]
                     Run the bridge in the foreground
  herdr-wow project add <id> --cwd DIR --workspace ID [--name TEXT] [--session NAME]
                     Allow an existing Herdr workspace/directory for new Pi sessions
  herdr-wow env [list|add <host>|remove <name>]
                     Manage optional T3 Code remote backends (T3 Connect / Tailscale)
  herdr-wow probe     Capture and decode the game window's pixel strip
  herdr-wow uninstall [--yes]
                     Remove this addon/bridge, not Herdr's tabs or agent conversations

  In game: /herdr (legacy /t3 still works).
  The t3code-wow CLI alias and existing installation paths remain supported.`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { keybinds: cmdKeybinds, project: cmdProject, env: cmdEnv, install: cmdInstall, run: cmdRun, status: cmdStatus, sync: cmdSync, probe: cmdProbe, uninstall: cmdUninstall };
if (!cmd || args.help || !commands[cmd]) {
  help();
  if (cmd && !commands[cmd]) process.exitCode = 1;
} else {
  Promise.resolve(commands[cmd](args)).catch((err) => {
    console.error(C.r(`✗ ${err.message}`));
    process.exitCode = 1;
  });
}
