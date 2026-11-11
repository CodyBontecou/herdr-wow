import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('installer validates before switching and retains files used by the old process', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(checkout, 'bridge/bin'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'addon'), { recursive: true });
  fs.mkdirSync(bin);
  const installer = path.join(checkout, 'install.sh');
  fs.copyFileSync(fileURLToPath(new URL('../../install.sh', import.meta.url)), installer);
  // Exercise release staging without requiring Swift or a game installation.
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
  const cli = path.join(checkout, 'bridge/bin/t3code-wow.js');
  fs.writeFileSync(cli, 'console.log("fixture install complete");\n');
  fs.writeFileSync(path.join(checkout, 'bridge/bin/mac-capture'), 'old helper');
  const env = { ...process.env, HOME: root, XDG_DATA_HOME: path.join(root, 'data'), PATH: `${bin}:${process.env.PATH}` };
  const run = () => execFileSync('/bin/bash', [installer, '--no-service'], { env, stdio: 'pipe', timeout: 15000 });
  run();
  const installed = path.join(env.XDG_DATA_HOME, 't3code-wow/bridge');
  const first = fs.realpathSync(installed);
  fs.writeFileSync(cli, 'this is not valid JavaScript !!!');
  assert.throws(run);
  assert.equal(fs.realpathSync(installed), first, 'failed validation must not replace a working release');
  fs.writeFileSync(cli, 'console.log("replacement install complete");\n');
  fs.writeFileSync(path.join(checkout, 'bridge/bin/mac-capture'), 'new helper');
  run();
  assert.notEqual(fs.realpathSync(installed), first);
  assert.equal(fs.readFileSync(path.join(first, 'bin/mac-capture'), 'utf8'), 'old helper');
  assert.equal(fs.readFileSync(path.join(installed, 'bin/mac-capture'), 'utf8'), 'new helper');
});
