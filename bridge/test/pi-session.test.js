import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePiSession, readPiSession } from '../src/pi-session.js';
import { highlightCode, wowBlocks } from '../src/blocks.js';

const header = { type: 'session', version: 3, cwd: '/project' };
const msg = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId, message: { role, content, timestamp: 1000, ...extra } });
const encode = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('Pi projection walks the saved branch and excludes system state, images, signatures and abandoned messages', () => {
  const source = encode([header,
    msg('root', null, 'system', 'PRIVATE PROMPT'),
    msg('u', 'root', 'user', [{ type: 'text', text: 'Hello' }, { type: 'image', data: 'PRIVATE IMAGE' }]),
    msg('old', 'u', 'assistant', [{ type: 'text', text: 'abandoned answer' }]),
    msg('new', 'u', 'assistant', [{ type: 'thinking', thinking: 'Considering options', thinkingSignature: 'PRIVATE SIGNATURE' }, { type: 'thinking', redacted: true, thinking: 'PRIVATE REDACTED' }, { type: 'text', text: 'Answer\n```js\nconst value = 42;\n```\nNext steps' }]),
  ]);
  const parsed = parsePiSession(source + '{"type":');
  assert.deepEqual(parsed.blocks.map((b) => b.kind), ['user', 'thinking', 'text', 'code', 'text']);
  assert.equal(parsed.blocks[3].language, 'js');
  assert.equal(parsed.blocks[3].text, 'const value = 42;');
  assert.doesNotMatch(JSON.stringify(parsed.blocks), /PRIVATE|abandoned/);
  assert.equal(parsePiSession(source + 'broken\n'), null, 'only incomplete final appends may be ignored');
  assert.equal(parsePiSession(encode([header, msg('x', 'missing', 'user', 'wrong branch')])), null);
  assert.equal(parsePiSession(encode([header, msg('x', 'x', 'user', 'cycle')])), null);
});

test('tool results update their matching cards, including error and pending states', () => {
  const parsed = parsePiSession(encode([header,
    msg('a', null, 'assistant', [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm test' } }, { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'file.js' } }]),
    msg('b', 'a', 'toolResult', [{ type: 'text', text: 'test failed' }], { toolCallId: 'c1', isError: true }),
  ]));
  assert.equal(parsed.blocks[0].text, 'npm test\n\ntest failed');
  assert.equal(parsed.blocks[0].status, 'error');
  assert.equal(parsed.blocks[1].status, 'pending');
  assert.equal(wowBlocks(parsed.blocks)[0].error, true);
});

test('session reads require a Pi identity, an exact session-root path and a matching cwd', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions);
  const file = path.join(sessions, 'session.jsonl');
  fs.writeFileSync(file, encode([{ ...header, cwd: root }, msg('u', null, 'user', 'hello')]));
  const agent = { agent: 'pi', cwd: root, agent_session: { kind: 'path', value: file } };
  const options = { sessionRoot: sessions };
  assert.equal(readPiSession(agent, options)[0].text, 'hello');
  assert.equal(readPiSession({ ...agent, cwd: sessions }, options), null);
  assert.equal(readPiSession({ ...agent, agent: 'codex' }, options), null);
  assert.equal(readPiSession({ ...agent, agent_session: { kind: 'id', value: file } }, options), null);
  const outside = path.join(root, 'outside.jsonl');
  fs.copyFileSync(file, outside);
  fs.symlinkSync(outside, path.join(sessions, 'link.jsonl'));
  assert.equal(readPiSession({ ...agent, agent_session: { kind: 'path', value: outside } }, options), null);
  assert.equal(readPiSession({ ...agent, agent_session: { kind: 'path', value: path.join(sessions, 'link.jsonl') } }, options), null);
});

test('syntax highlighting escapes literal markup and keeps strings/comments intact', () => {
  const code = 'const x = "return |cffffffffunsafe|r"; // true';
  const rendered = highlightCode(code, 'js');
  assert.ok(rendered.includes('|cffc6a0eeconst|r'));
  assert.ok(rendered.includes('|cffa8cf91"return ||cffffffffunsafe||r"|r'));
  assert.ok(rendered.endsWith('|cff8b97a8// true|r'));
  assert.equal(highlightCode('+added\n-removed', 'diff'), '|cff8ed6a0+added|r\n|cfff08b8b-removed|r');
});

test('long cards have independently formatted previews and bounded expansion payloads', () => {
  const rows = wowBlocks(Array.from({ length: 100 }, (_, i) => ({ id: String(i), kind: 'tool', label: 'bash', status: 'done', text: 'const value = "example";\n'.repeat(400) })));
  assert.ok(rows.length > 0 && rows.length <= 40);
  assert.equal(rows.at(-1).id, '99');
  assert.ok(rows.at(-1).full.length > rows.at(-1).t.length);
  assert.ok(rows.at(-1).full.includes('More output is available in Pi.'));
  assert.ok(rows.reduce((n, r) => n + r.t.length + (r.full?.length || 0), 0) <= 60000);
});
