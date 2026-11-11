import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { StripCapture } from '../src/capture.js';
import { acquireInstance, launchAgent } from '../src/service.js';
import { Bridge } from '../src/bridge.js';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Exercise the real subprocess boundary, not a mocked failure counter.
test('capture recovers from helper disappearance, permissions and timeouts without a bridge restart', async (t) => {
  const dir = temporary(t);
  const helper = path.join(dir, 'capture');
  const cap = new StripCapture({ backend: 'macos', macCapture: helper, captureTimeout: 100 });
  const writeHelper = (body) => fs.writeFileSync(helper, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  assert.equal((await cap.poll(1)).kind, 'missing-helper');
  assert.equal(cap.retryDelay(), 400);
  for (let i = 0; i < 10; i++) await cap.poll(1);
  assert.equal(cap.retryDelay(), 10000);
  writeHelper('echo "Screen Recording permission is required" >&2; exit 1');
  assert.equal((await cap.poll(1)).kind, 'permission-denied');
  writeHelper('exec sleep 3');
  assert.equal((await cap.poll(1)).kind, 'timeout');
  writeHelper("printf 'P6\\n1 1\\n255\\n\\000\\000\\000'");
  assert.equal((await cap.poll(1)).status, 'empty');
  assert.equal(cap.lastError, null);
  assert.equal(cap.errorKind, null);
  assert.equal(cap.failures, 0);
  assert.equal(cap.retryDelay(), 0);
  assert.ok(cap.lastCaptureAt > 0);
  assert.equal(cap.lastSeenAt, 0, 'capture success does not imply addon contact');
  writeHelper('echo no-window >&2; exit 1');
  assert.equal((await cap.poll(1)).status, 'no-window');
  assert.equal(cap.failures, 0, 'no visible window is not a capture failure');
});

test('a new game process identity discards geometry even when the PID is reused', (t) => {
  const cap = new StripCapture();
  cap.resetProcess('42:first-start');
  cap.hint = { cell: 3 };
  cap.lastCaptureAt = 100;
  cap.failures = 4;
  cap.resetProcess('42:first-start');
  assert.ok(cap.hint);
  cap.resetProcess('42:second-start');
  assert.equal(cap.hint, null);
  assert.equal(cap.lastCaptureAt, 0);
  assert.equal(cap.failures, 0);
});

test('round-trip health separates idle captures, overdue acknowledgements and stalled capture', (t) => {
  const dir = temporary(t);
  const b = new Bridge({ addonsDir: path.join(dir, 'addons'), stateDir: path.join(dir, 'state'), log: () => {} });
  b.proc = { pid: 1 };
  b.capture.lastCaptureAt = 100000;
  b.client = { appliedGen: 1, lastAckAt: 90000, lastSeen: 100000 };
  b.lastGen = 1;
  assert.equal(b.linkHealth(100000).state, 'idle');
  b.lastGen = 2;
  b.unackedSince = 80000;
  b.lastPublishAt = 99999;
  assert.equal(b.linkHealth(100000).state, 'awaiting-ack', 'new publishes must not hide an old missing acknowledgement');
  b.client.lastSeen = 80000;
  assert.equal(b.linkHealth(100000).state, 'idle-unverified', 'the strip hides on ack: absence of an ack-of-ack is not a failure');
  b.capture.lastError = 'timeout';
  assert.equal(b.linkHealth(100000).state, 'capture-error');
  b.capture.lastError = null;
  assert.equal(b.linkHealth(120000).state, 'capture-stalled');
});

test('instance ownership rejects a second bridge and is released by a crashed process', async (t) => {
  const dir = temporary(t);
  const module = new URL('../src/service.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireInstance } from ${JSON.stringify(module)}; await acquireInstance(process.argv[1]); console.log('ready');`, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  await assert.rejects(acquireInstance(dir), /instance lock is occupied/);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const release = await acquireInstance(dir);
  await release();
});

test('LaunchAgent safely encodes paths and supervises crashes rather than idle transport', (t) => {
  const dir = temporary(t);
  const plist = launchAgent({ node: '/a & b/node', script: '/c < d/bridge.js', stateDir: dir, envPath: '/bin:/a&b' });
  assert.match(plist, /SuccessfulExit<\/key><false\/>/);
  assert.ok(!plist.includes('/a & b/node'));
  if (process.platform === 'darwin') {
    const file = path.join(dir, 'agent.plist');
    fs.writeFileSync(file, plist);
    execFileSync('/usr/bin/plutil', ['-lint', file]);
  }
});
