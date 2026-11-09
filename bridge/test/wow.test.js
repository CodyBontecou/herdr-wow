import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake home with Wine prefixes, set before wow.js reads it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-home-'));
process.env.HOME = home;
delete process.env.WINEPREFIX;
const { findWowInstalls: discover, parseMacWowProcess, processKey } = await import('../src/wow.js');
const findWowInstalls = () => discover({ platform: 'linux' });

function touch(p, content = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function reset() {
  fs.rmSync(path.join(home, 'Games'), { recursive: true, force: true });
  fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
}

const omarchy = () => path.join(home, 'Games/battlenet');

test("finds Forever in Omarchy's Battle.net prefix", () => {
  reset();
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/Battle.net/Battle.net.exe'));
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft/_forever_/Wow.exe'));
  assert.deepEqual(findWowInstalls().forever, [path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft/_forever_')]);
});

test("finds a custom install folder from Battle.net's records, including another drive", () => {
  reset();
  touch(path.join(omarchy(), 'drive_c/ProgramData/Battle.net/Agent/product.db'),
    'junk\x00\x12(C:/Games/World of Warcraft\x00wowf\x00\x12"D:\\Blizzard\\World of Warcraft"');
  touch(path.join(omarchy(), 'drive_c/Games/World of Warcraft/_forever_/Wow.exe'));
  // D: is a dosdevices link to somewhere else on disk.
  const elsewhere = path.join(home, 'Games/disk-d');
  touch(path.join(elsewhere, 'Blizzard/World of Warcraft/_retail_/Wow.exe'));
  fs.mkdirSync(path.join(omarchy(), 'dosdevices'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(omarchy(), 'dosdevices/d:'));
  const r = findWowInstalls();
  assert.deepEqual(r.forever, [path.join(omarchy(), 'drive_c/Games/World of Warcraft/_forever_')]);
  assert.deepEqual(r.wowOnly, [path.join(omarchy(), 'dosdevices/d:/Blizzard/World of Warcraft')]);
});

test('tells WoW without Forever apart from no WoW at all, and ignores other games\' prefixes', () => {
  reset();
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/Battle.net/Battle.net.exe'));
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft/_retail_/Wow.exe'));
  let r = findWowInstalls();
  assert.equal(r.forever.length, 0);
  assert.deepEqual(r.wowOnly, [path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft')]);

  reset();
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/Battle.net/Battle.net.exe'));
  touch(path.join(home, '.local/share/Steam/steamapps/compatdata/1091500/pfx/drive_c/windows/win.ini'));
  r = findWowInstalls();
  assert.deepEqual([r.forever.length, r.wowOnly.length], [0, 0]);
  assert.deepEqual(r.prefixes, [omarchy()], 'only prefixes that really hold Battle.net');
});

test('native discovery and process identity distinguish Forever, another install and PID reuse', (t) => {
  reset();
  const native = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-native-'));
  t.after(() => fs.rmSync(native, { recursive: true, force: true }));
  const wow = path.join(native, 'World of Warcraft');
  const flavor = path.join(wow, '_forever_');
  fs.mkdirSync(path.join(flavor, 'World of Warcraft.app'), { recursive: true });
  assert.deepEqual(discover({ platform: 'darwin', nativeRoots: [wow] }).forever, [flavor]);
  const executable = path.join(flavor, 'World of Warcraft.app/Contents/MacOS/World of Warcraft');
  const ps = `  42 Mon Nov  9 10:00:00 2026 ${executable}\n  43 Mon Nov  9 10:00:01 2026 /Applications/World of Warcraft/_retail_/World of Warcraft.app/Contents/MacOS/World of Warcraft`;
  const proc = parseMacWowProcess(ps, flavor);
  assert.equal(proc.pid, 42);
  assert.equal(parseMacWowProcess(ps, path.join(native, 'Other/_forever_')), null);
  assert.equal(parseMacWowProcess(ps.split('\n')[1]), null);
  assert.notEqual(processKey(proc), processKey(parseMacWowProcess(ps.replace('10:00:00', '10:02:00'), flavor)));
});
