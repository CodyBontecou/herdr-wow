import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HerdrBackend, validateHerdrConfig, herdrCommand } from '../src/herdr.js';
import { Bridge, pendingRequest } from '../src/bridge.js';
import { questionControls } from '../src/herdr-questions.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-herdr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.realpathSync(root);
  const config = { session: 'test', projects: [{ id: 'demo', name: 'Demo · Pi', cwd, workspace: 'w1' }] };
  const calls = [];
  let agents = [];
  let topology = null;
  let terminalText = 'literal | WoW markup\nsecond line';
  const snapshot = () => topology || {
    workspaces: [...new Set(['w1', ...agents.map((a) => a.workspace_id)])].map((id) => ({ workspace_id: id, label: `Space ${id}` })),
    tabs: [...new Map(agents.map((a) => [a.tab_id, { tab_id: a.tab_id, workspace_id: a.workspace_id, label: `Tab ${a.tab_id}` }])).values()],
    panes: agents,
    agents: agents.filter((a) => a.agent),
  };
  let failStart = false;
  let busyOnce = false;
  const agent = (overrides = {}) => ({ terminal_id: 'term-1', pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', agent_status: 'idle', cwd, agent_session: { kind: 'path', value: 'session-1' }, ...overrides });
  const run = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'api') return { snapshot: snapshot() };
    if (args[0] === 'tab' && args[1] === 'close') {
      agents = agents.filter((a) => a.tab_id !== args[2]);
      return { type: 'tab_closed' };
    }
    if (args[0] === 'tab') return { type: 'tab_created', root_pane: { pane_id: 'w1:p2' }, tab: { tab_id: 'w1:t1', label: args[7] } };
    if (args[1] === 'start') {
      if (busyOnce) {
        busyOnce = false;
        throw Object.assign(new Error('shell is starting'), { code: 'agent_pane_busy' });
      }
      if (failStart) throw new Error('startup timed out');
      agents = [agent({ name: args[2] })];
      return { agent: agents[0] };
    }
    if (args[1] === 'get') return { [args[0] === 'pane' ? 'pane' : 'agent']: agents.find((a) => a.pane_id === args[2]) };
    if (args[1] === 'read') {
      if (agents[0]?.agent_status === 'working' && args.includes('recent-unwrapped')) throw Object.assign(new Error('alternate-screen history requires idle'), { code: 'agent_not_idle' });
      return { read: { text: terminalText, truncated: true } };
    }
    if (['prompt', 'send-keys', 'send-text'].includes(args[1])) return { agent: agents[0] };
    throw new Error(`Unexpected command ${args}`);
  };
  const backend = new HerdrBackend({ config, run });
  return { root, config, backend, calls, agent, run, setTerminalText: (value) => { terminalText = value; }, setTopology: (value) => { topology = value; agents = value.panes; }, setAgents: (value) => { agents = value; }, failStart: () => { failStart = true; }, busyOnce: () => { busyOnce = true; } };
}

// Codex layouts follow upstream tui/bottom_pane/{request_user_input,
// async_questions} snapshots. Claude's AskUserQuestion has a distinct custom
// answer/chat row and navigation footer; generic permission menus must not match.
const codexQuestion = '  Question 1/2 (2 unanswered)\n  Choose an option.\n\n  › 1. One\n    2. Two\n\n  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt';
const codexAsync = '  1 of 2\n  Which path?\n\n  › 1. One\n    2. Two\n\n  enter submit   ⌃] skip   ⇧→ main prompt\n  ⇧← next question';
const claudeQuestion = 'Which path?\n❯ 1. One\n  2. Two\n  3. Type something.\n  4. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';

test('question recognition handles collapsed and expanded Codex and Claude, not approvals/history', () => {
  const codex = { agent: 'codex', agent_status: 'blocked' };
  const claude = { agent: 'claude', agent_status: 'blocked' };
  assert.deepEqual(questionControls(codex, '  ? 1 question\n    ⇧← to answer').actions, [{ key: 'shift+left', label: 'Open questions' }]);
  assert.equal(questionControls(codex, '  ? 2 questions\n    tab to answer').actions[0].key, 'tab');
  assert.ok(questionControls(codex, codexQuestion).actions.some((a) => a.key === 'right'));
  assert.ok(questionControls(codex, codexAsync).actions.some((a) => a.key === 'shift+left'));
  assert.equal(questionControls(codex, codexAsync.replace('› 1. One', '  1. One').replace('  2. Two', '› 2. Other')).textInput, true);
  assert.equal(questionControls(codex, codexAsync.replace('One', 'Other').replace('Two', 'Other (write an answer)')).textInput, false);
  assert.equal(questionControls(codex, codexAsync.replace('One', 'Other').replace('  2. Two', 'option 1/3')).textInput, false);
  assert.equal(questionControls(codex, codexQuestion.replace('› 1. One', '› Type your answer (optional)')).textInput, true);
  assert.equal(questionControls(claude, claudeQuestion).textInput, false);
  assert.equal(questionControls(claude, claudeQuestion.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.')).textInput, true);
  assert.equal(questionControls(claude, 'Ready to submit your answers?\n❯ Submit answers').actions[0].key, 'enter');
  for (const agent of [codex, claude, { agent: 'pi', agent_status: 'blocked' }]) {
    assert.equal(questionControls(agent, 'Run rm -rf?\n❯ 1. Yes\n  2. No\nEnter to select'), null);
  }
  assert.equal(questionControls({ ...codex, agent_status: 'idle' }, codexQuestion), null);
  assert.equal(questionControls({ ...claude, agent_status: 'working' }, claudeQuestion), null);
  assert.equal(questionControls(codex, 'Question 1/2\ncustom key to submit answer'), null);
});

test('question actions are session-bound, screen-bound, single-use and never become prompts', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent({ agent: 'codex', agent_status: 'blocked' })]);
  f.setTerminalText(codexQuestion);
  await f.backend.refresh();
  const id = [...f.backend.threads.keys()][0];
  const p = await f.backend.threadProjection(id);
  const q = p.terminalQuestion;
  assert.equal((await f.backend.threadProjection(id)).terminalQuestion.id, q.id, 'polls preserve a request until acted on');
  assert.equal(pendingRequest(p).kind, 'terminal-question');
  await assert.rejects(f.backend.respondAnswers(id, q.id, { key: 'ctrl+c' }), /not available/);
  await assert.rejects(f.backend.respondAnswers(id, q.id, { key: ['up', 'enter'] }), /one question action/);
  await assert.rejects(f.backend.respondAnswers(id, q.id, { text: 'no field' }), /text field/);
  await f.backend.respondAnswers(id, q.id, { key: 'down' });
  assert.deepEqual(f.calls.filter((c) => c.args[1] === 'send-keys').map((c) => c.args), [['agent', 'send-keys', 'w1:p2', 'down']]);
  await assert.rejects(f.backend.respondAnswers(id, q.id, { key: 'enter' }), /question changed/);
  const fresh = (await f.backend.threadProjection(id)).terminalQuestion;
  assert.notEqual(fresh.id, q.id);
  f.setTerminalText(codexQuestion.replace('One', 'Different'));
  await assert.rejects(f.backend.respondAnswers(id, fresh.id, { key: 'enter' }), /screen changed/);
  const newer = (await f.backend.threadProjection(id)).terminalQuestion;
  f.setAgents([f.agent({ agent: 'codex', agent_status: 'blocked', terminal_id: 'replacement' })]);
  await assert.rejects(f.backend.respondAnswers(id, newer.id, { key: 'enter' }), /session changed/);
  assert.equal(f.calls.filter((c) => ['prompt', 'send-text'].includes(c.args[1])).length, 0);
});

test('collapsed Codex questions can be opened during animated work but cannot replay or answer', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent({ agent: 'codex', agent_status: 'working' })]);
  f.setTerminalText('Working 1s\n? 1 question\n  ⇧← to answer');
  await f.backend.refresh();
  const id = [...f.backend.threads.keys()][0];
  const q = (await f.backend.threadProjection(id)).terminalQuestion;
  f.setTerminalText('Working 2s\n? 1 question\n  ⇧← to answer');
  assert.equal((await f.backend.threadProjection(id)).terminalQuestion.id, q.id);
  await assert.rejects(f.backend.respondAnswers(id, q.id, { key: 'enter' }), /not available/);
  await f.backend.respondAnswers(id, q.id, { key: 'shift+left' });
  await assert.rejects(f.backend.respondAnswers(id, q.id, { key: 'shift+left' }), /question changed/);
  const next = (await f.backend.threadProjection(id)).terminalQuestion;
  f.setTerminalText('Ask Codex to do anything');
  await assert.rejects(f.backend.respondAnswers(id, next.id, { key: 'shift+left' }), /screen changed/);
});

test('uncertain terminal writes consume the question and are never automatically retried', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent({ agent: 'codex', agent_status: 'blocked' })]);
  f.setTerminalText(codexQuestion);
  await f.backend.refresh();
  const id = [...f.backend.threads.keys()][0];
  const q = (await f.backend.threadProjection(id)).terminalQuestion;
  const run = f.backend.run;
  let writes = 0;
  f.backend.run = async (args, options) => {
    if (args[1] === 'send-keys') { writes++; throw new Error('timed out after possible write'); }
    return run(args, options);
  };
  await assert.rejects(f.backend.respondAnswers(id, q.id, { key: 'enter' }), /possible write/);
  await assert.rejects(f.backend.respondAnswers(id, q.id, { key: 'enter' }), /question changed/);
  assert.equal(writes, 1);
});

test('question text is entered literally without Enter; control bytes are rejected', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent({ agent: 'claude', agent_status: 'blocked' })]);
  f.setTerminalText(claudeQuestion.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.'));
  await f.backend.refresh();
  const id = [...f.backend.threads.keys()][0];
  const q = (await f.backend.threadProjection(id)).terminalQuestion;
  for (const text of ['one\ntwo', '\x1b[200~injected', 'a\tb']) {
    await assert.rejects(f.backend.respondAnswers(id, q.id, { text }), /single-line/);
  }
  await f.backend.respondAnswers(id, q.id, { text: '$(touch nope); literal | text' });
  assert.deepEqual(f.calls.filter((c) => c.args[1] === 'send-text').map((c) => c.args), [['pane', 'send-text', 'w1:p2', '$(touch nope); literal | text']]);
  assert.equal(f.calls.filter((c) => ['prompt', 'send-keys'].includes(c.args[1])).length, 0);
});

test('launch creates a no-focus Pi tab in the allowlisted project and submits literal text only after startup', async (t) => {
  const f = fixture(t);
  const text = '--wait\n$(touch should-not-exist); please help';
  const { threadId } = await f.backend.launchThread('demo', text);
  assert.match(threadId, /^herdr-/);
  assert.deepEqual(f.calls[0].args, ['tab', 'create', '--workspace', 'w1', '--cwd', f.config.projects[0].cwd, '--label', f.calls[1].args[2], '--no-focus']);
  assert.deepEqual(f.calls[1].args.slice(0, 2), ['agent', 'start']);
  assert.deepEqual(f.calls[1].args.slice(3), ['--kind', 'pi', '--pane', 'w1:p2']);
  const prompt = f.calls.find((c) => c.args[1] === 'prompt');
  assert.equal(prompt.args[3], text);
  assert.ok(f.calls.every((c) => c.options.session === 'test'));
  assert.equal(f.backend.threads.get(threadId).projectId, 'space:w1');
});

test('empty new-tab launch starts a fresh Pi session without submitting a prompt', async (t) => {
  const f = fixture(t);
  const { threadId } = await f.backend.launchThread('demo', '');
  assert.equal(f.backend.threads.get(threadId).uiStatus, 'open');
  assert.deepEqual(f.calls.map((c) => c.args.slice(0, 2)), [['tab', 'create'], ['agent', 'start']]);
  assert.deepEqual(f.calls[1].args.slice(3), ['--kind', 'pi', '--pane', 'w1:p2']);
  assert.ok(f.calls[0].args.includes('--no-focus'));
});

test('new shell readiness retries only definite pre-submission busy rejections', async (t) => {
  const f = fixture(t);
  f.busyOnce();
  await f.backend.launchThread('demo', 'hello');
  assert.equal(f.calls.filter((c) => c.args[1] === 'start').length, 2);
  assert.equal(f.calls.filter((c) => c.args[1] === 'prompt').length, 1);
});

test('CLI reads are raw text, even JSON-shaped text; configured sessions discard inherited socket routing', async (t) => {
  const f = fixture(t);
  const originalPath = process.env.PATH;
  const originalSocket = process.env.HERDR_SOCKET_PATH;
  const text = '{"error":{"message":"terminal output, not an API failure"}}';
  fs.writeFileSync(path.join(f.root, 'herdr'), `#!/bin/sh\n[ -z "$HERDR_SOCKET_PATH" ] || exit 1\nprintf '%s' '${text}'\n`, { mode: 0o700 });
  try {
    process.env.PATH = `${f.root}:${originalPath}`;
    process.env.HERDR_SOCKET_PATH = '/wrong-session.sock';
    for (const kind of ['agent', 'pane']) {
      const result = await herdrCommand([kind, 'read', 'w1:p2'], { session: 'test' });
      assert.equal(result.read.text, text);
    }
  } finally {
    process.env.PATH = originalPath;
    if (originalSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalSocket;
  }
});

test('unknown project and image input cannot create a tab', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.backend.launchThread('/arbitrary/directory', 'hello'), /configured/);
  await assert.rejects(f.backend.launchThread('demo', 'hello', [{}]), /Screenshots/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => validateHerdrConfig({ projects: [f.config.projects[0], f.config.projects[0]] }), /unique/);
});

test('the current Herdr chat remains visible when the bridge inherits its pane ID', async (t) => {
  const f = fixture(t);
  const previous = process.env.HERDR_PANE_ID;
  try {
    process.env.HERDR_PANE_ID = 'w1:p99';
    const current = f.agent({ pane_id: 'w1:p99' });
    f.setAgents([current]);
    const backend = new HerdrBackend({ config: f.config, run: f.run });
    await backend.refresh();
    assert.equal(backend.threads.size, 1, 'the conversation that started the bridge must be listed');
  } finally {
    if (previous === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previous;
  }
});

test('discovery includes agents in other directories and spaces; unknown is not completion', async (t) => {
  const f = fixture(t);
  f.setAgents([
    f.agent({ agent_status: 'unknown' }),
    f.agent({ terminal_id: 'other-agent', pane_id: 'w1:p3', agent: 'codex' }),
    f.agent({ terminal_id: 'other-project', pane_id: 'w1:p4', cwd: os.tmpdir() }),
    f.agent({ terminal_id: 'other-workspace', pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' }),
  ]);
  await f.backend.refresh();
  assert.equal(f.backend.threads.size, 4);
  const [thread] = f.backend.threads.values();
  assert.equal(thread.uiStatus, 'input');
  await assert.rejects(f.backend.sendMessage(thread.id, 'hello'), /busy or needs input/);
  assert.ok(!f.calls.some((c) => c.args[1] === 'prompt'));
});

test('all spaces, tabs and split panes are browsable without granting launch or shell-input permissions', async (t) => {
  const f = fixture(t);
  const entries = [
    f.agent({ agent: 'codex', workspace_id: 'w2', tab_id: 'w2:t1', pane_id: 'w2:p1' }),
    f.agent({ agent: 'claude', terminal_id: 'term-2', workspace_id: 'w2', tab_id: 'w2:t1', pane_id: 'w2:p2' }),
    f.agent({ agent: null, terminal_id: 'shell', workspace_id: 'w3', tab_id: 'w3:t1', pane_id: 'w3:p1' }),
  ];
  f.setTopology({
    workspaces: [{ workspace_id: 'w2', label: 'Other project' }, { workspace_id: 'w3', label: 'Shells' }, { workspace_id: 'w4', label: 'Empty space' }],
    tabs: [{ tab_id: 'w2:t1', workspace_id: 'w2', label: 'Review' }, { tab_id: 'w3:t1', workspace_id: 'w3', label: 'Server logs' }],
    panes: entries, agents: entries.filter((a) => a.agent),
  });
  await f.backend.refresh();
  assert.deepEqual([...f.backend.projects.values()].filter((p) => p.browse).map((p) => p.title), ['Other project', 'Shells', 'Empty space']);
  assert.equal(f.backend.threads.size, 3);
  const threads = [...f.backend.threads.values()];
  assert.match(threads[0].title, /Review.*Codex.*Pane 1/);
  assert.match(threads[1].title, /Review.*Claude Code.*Pane 2/);
  const shell = threads.find((th) => th.kind === 'terminal');
  assert.equal(shell.uiStatus, 'open');
  assert.equal(shell.capabilities.send, false);
  const output = await f.backend.threadProjection(shell.id);
  assert.match(output.note, /read-only/);
  assert.deepEqual(f.calls.at(-1).args, ['pane', 'read', 'w3:p1', '--source', 'visible']);
  await assert.rejects(f.backend.sendMessage(shell.id, 'must not execute'), /read-only/);
  await assert.rejects(f.backend.launchThread('space:w2', 'must not launch'), /configured/);
  assert.ok(!f.calls.some((c) => c.args[1] === 'prompt' || c.args[0] === 'tab'));
  await f.backend.sendMessage(threads[0].id, 'Review this');
  assert.deepEqual(f.calls.find((c) => c.args[1] === 'prompt').args, ['agent', 'prompt', 'w2:p1', 'Review this']);
});

test('browse-only configuration needs no launch directory; tab moves, renames and closures update the model', async (t) => {
  const f = fixture(t);
  const first = f.agent();
  f.setAgents([first]);
  const backend = new HerdrBackend({ config: { session: 'test' }, run: f.run });
  await backend.refresh();
  const [id] = backend.threads.keys();
  assert.equal(backend.launchProjects.size, 0);
  f.setTopology({ workspaces: [{ workspace_id: 'w2', label: 'Renamed space' }], tabs: [{ tab_id: 'w2:t7', workspace_id: 'w2', label: 'Renamed tab' }], panes: [{ ...first, workspace_id: 'w2', tab_id: 'w2:t7', pane_id: 'w2:p7' }], agents: [{ ...first, workspace_id: 'w2', tab_id: 'w2:t7', pane_id: 'w2:p7' }] });
  await backend.refresh();
  assert.equal(backend.threads.get(id).projectId, 'space:w2');
  assert.match(backend.threads.get(id).title, /Renamed tab/);
  assert.equal(backend.projects.has('space:w1'), false);
  f.setTopology({ workspaces: [], tabs: [], panes: [], agents: [] });
  await backend.refresh();
  assert.equal(backend.threads.size, 0);
  assert.equal(backend.projects.size, 0);
});

test('WoW snapshots keep empty spaces and more than 90 tabs, without mixing browsing and launch destinations', async (t) => {
  const f = fixture(t);
  const entries = Array.from({ length: 95 }, (_, i) => f.agent({ terminal_id: `term-${i}`, pane_id: `w1:p${i}`, tab_id: `w1:t${i}` }));
  f.setTopology({ workspaces: [{ workspace_id: 'w1', label: 'Development' }, { workspace_id: 'w2', label: 'Empty' }], tabs: entries.map((a) => ({ tab_id: a.tab_id, workspace_id: a.workspace_id, label: 'Main' })), panes: entries, agents: entries });
  await f.backend.refresh();
  const b = new Bridge({ addonsDir: path.join(f.root, 'addons'), config: { backend: 'herdr', herdr: f.config }, stateDir: path.join(f.root, 'state'), log: () => {} });
  b.t3 = f.backend;
  t.after(() => { b.stop(); clearTimeout(b.saveTimer); });
  const snapshot = b.buildSnapshot();
  assert.equal(snapshot.threads.length, 95);
  assert.equal(snapshot.projects.find((p) => p.id === 'space:w1').launch, false);
  assert.equal(snapshot.projects.find((p) => p.id === 'space:w2').act, true, 'empty spaces remain in the dropdown');
  assert.equal(snapshot.projects.find((p) => p.id === 'demo').browse, false);
  assert.equal(snapshot.projects.find((p) => p.id === 'demo').filterId, 'space:w1');
});

test('a working chat can be read without asking Herdr to scroll its alternate-screen history', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent({ agent_status: 'working' })]);
  await f.backend.refresh();
  const [id] = f.backend.threads.keys();
  const projection = await f.backend.threadProjection(id);
  assert.ok(projection.terminalOutput);
  assert.deepEqual(f.calls.find((c) => c.args[1] === 'read').args, ['agent', 'read', 'w1:p2', '--source', 'visible']);
});

test('terminal viewport padding is removed without changing code indentation or internal paragraph spacing', async (t) => {
  const f = fixture(t);
  const body = '    indented code\n\n\n    another line\n\nA paragraph.';
  for (const kind of ['pi', 'codex', null]) {
    f.setAgents([f.agent({ agent: kind, agent_status: 'working' })]);
    await f.backend.refresh();
    const [id] = f.backend.threads.keys();
    f.setTerminalText('\n   \n\t\n' + body + '\n\n \n');
    assert.equal((await f.backend.threadProjection(id)).terminalOutput, body);
    f.setTerminalText('\n   \n\t\n');
    assert.equal((await f.backend.threadProjection(id)).terminalOutput, '');
  }
});

test('Pi transcripts omit the usage widget and terminal footer, without deleting message text or code examples', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent({ agent_status: 'working' })]);
  await f.backend.refresh();
  const [id] = f.backend.threads.keys();
  const message = 'Your reply is ready.\n\nKeep this code example:\n```text\n    wk ██░░░ 37% (4d)\n──────────────────\n```\n\nA normal wk abbreviation is fine.';
  f.setTerminalText(message + '\n\n                                             wk ██░░░ 37% (4d)\n── ⠧ Working ───────────────────────\n\n──────────────────────────────\n/project (main)\n↑2k ↓20 $0.01 3%/200k (provider) model');
  assert.equal((await f.backend.threadProjection(id)).terminalOutput, message);
  f.setTerminalText(message);
  assert.equal((await f.backend.threadProjection(id)).terminalOutput, message);
  const ordinaryText = 'Status widget example:\n    wk ██░░░ 37% (4d)\n──────────────────\nThis explanation is still part of the reply.';
  f.setTerminalText(ordinaryText);
  assert.equal((await f.backend.threadProjection(id)).terminalOutput, ordinaryText);
});

test('Pi footer cleanup does not remove similar text from other agents or shell logs', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent({ agent: 'codex', agent_status: 'working' })]);
  await f.backend.refresh();
  const [id] = f.backend.threads.keys();
  const text = 'Log example:\n    wk ██░░░ 37% (4d)\n──────────────────';
  f.setTerminalText(text);
  assert.equal((await f.backend.threadProjection(id)).terminalOutput, text);
});

test('replacement sessions reject delayed prompts; disappeared agents are removed', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent()]);
  await f.backend.refresh();
  const [id] = f.backend.threads.keys();
  f.setAgents([f.agent({ agent_session: { value: 'replacement' } })]);
  await assert.rejects(f.backend.sendMessage(id, 'do not send'), /session changed/);
  assert.ok(!f.calls.some((c) => c.args[1] === 'prompt'));
  await f.backend.refresh();
  assert.ok(!f.backend.threads.has(id));
  f.setAgents([]);
  await f.backend.refresh();
  assert.equal(f.backend.threads.size, 0);
});

test('close thread closes the confirmed tab including split panes in the configured session', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent(), f.agent({ pane_id: 'w1:p3', terminal_id: 'term-2' }), f.agent({ pane_id: 'w1:p4', terminal_id: 'term-3', tab_id: 'w1:t2' })]);
  await f.backend.refresh();
  const [id] = f.backend.threads.keys();
  await f.backend.closeThread(id, 'w1:t1');
  const closes = f.calls.filter((c) => c.args[1] === 'close');
  assert.deepEqual(closes.map((c) => c.args), [['tab', 'close', 'w1:t1']]);
  assert.equal(closes[0].options.session, 'test');
  assert.equal(f.backend.threads.size, 1);
  assert.equal([...f.backend.agents.values()][0].tab_id, 'w1:t2');
});

test('close thread rejects replaced sessions, moved panes and missing confirmation identity', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent()]);
  await f.backend.refresh();
  const [id] = f.backend.threads.keys();
  await assert.rejects(f.backend.closeThread(id), /tab changed/);
  await assert.rejects(f.backend.closeThread('missing', 'w1:t1'), /no longer available/);
  f.setAgents([f.agent({ agent_session: { value: 'replacement' } })]);
  await assert.rejects(f.backend.closeThread(id, 'w1:t1'), /session changed/);
  f.setAgents([f.agent({ tab_id: 'w1:t2' })]);
  await assert.rejects(f.backend.closeThread(id, 'w1:t1'), /tab changed/);
  await f.backend.refresh();
  await assert.rejects(f.backend.closeThread(id, 'w1:t1'), /tab changed/);
  assert.ok(!f.calls.some((c) => c.args[1] === 'close'));
});

test('close failures are reported without retrying an uncertain destructive command', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent()]);
  await f.backend.refresh();
  const [id] = f.backend.threads.keys();
  f.backend.run = async (args, options) => {
    if (args[1] === 'close') {
      f.calls.push({ args, options });
      throw new Error('close timed out');
    }
    return f.run(args, options);
  };
  await assert.rejects(f.backend.closeThread(id, 'w1:t1'), /close timed out/);
  assert.equal(f.calls.filter((c) => c.args[1] === 'close').length, 1);
});

test('startup failure keeps the created tab for inspection and never retries or sends a prompt', async (t) => {
  const f = fixture(t);
  f.failStart();
  await assert.rejects(f.backend.launchThread('demo', 'hello'), /Check Herdr pane w1:p2.*tab was kept/);
  assert.deepEqual(f.calls.map((c) => c.args.slice(0, 2)), [['tab', 'create'], ['agent', 'start']]);
});

test('Pi structured cards reach snapshots without duplicate terminal output, with fallback when unavailable', async (t) => {
  const f = fixture(t);
  f.setAgents([f.agent()]);
  await f.backend.refresh();
  const id = [...f.backend.threads.keys()][0];
  const blocks = [{ id: 'card', kind: 'tool', label: 'bash', status: 'done', text: 'echo hello\n\n' + 'output\n'.repeat(30) }];
  f.backend.readSession = () => blocks;
  const projection = await f.backend.threadProjection(id);
  assert.equal(projection.blocks, blocks);
  assert.equal(projection.terminalOutput, undefined);
  const b = new Bridge({ addonsDir: path.join(f.root, 'addons'), config: { backend: 'herdr', herdr: f.config }, stateDir: path.join(f.root, 'state'), log: () => {} });
  b.t3 = f.backend;
  t.after(() => { b.stop(); clearTimeout(b.saveTimer); });
  b.client = { view: id, flags: 'o' };
  b.views.set(id, { projection, fetchedAt: Date.now() });
  const rows = b.buildSnapshot().view.msgs;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'tool');
  assert.ok(rows[0].full);
  assert.equal(rows[0].label, 'bash · Completed');
  f.setAgents([f.agent({ agent_status: 'blocked' })]);
  assert.ok((await f.backend.threadProjection(id)).terminalOutput, 'blocked Pi screens remain visible instead of showing stale saved messages');
  f.setAgents([f.agent()]);
  f.backend.readSession = () => null;
  assert.equal((await f.backend.threadProjection(id)).terminalOutput, 'literal | WoW markup\nsecond line');
});

test('bridge sends new-thread results, escapes terminal output and rejects unsupported actions without capture', async (t) => {
  const f = fixture(t);
  const b = new Bridge({ addonsDir: path.join(f.root, 'addons'), config: { backend: 'herdr', herdr: f.config }, stateDir: path.join(f.root, 'state'), log: () => {} });
  b.t3 = f.backend;
  t.after(() => { b.stop(); clearTimeout(b.saveTimer); });
  await b.runCommand({ id: 1, verb: 'new', args: ['demo', 'hello'] });
  const opened = b.results.find((r) => r.open);
  assert.ok(opened?.ok);
  b.client = { view: opened.open, flags: 'o' };
  const projection = await f.backend.threadProjection(opened.open);
  b.views.set(opened.open, { projection, fetchedAt: Date.now() });
  const snapshot = b.buildSnapshot();
  assert.equal(snapshot.bridge.backend, 'Herdr');
  assert.equal(snapshot.view.msgs[0].t, 'literal || WoW markup\nsecond line');
  assert.match(snapshot.view.note, /not full conversation history/);
  assert.equal(snapshot.threads[0].caps.busySend, false);
  b.capture.screenshot = () => { throw new Error('capture must not run'); };
  await b.runCommand({ id: 2, verb: 'shot', args: [opened.open] });
  assert.match(b.results.at(-1).msg, /not supported/);
  assert.equal(b.shots.size, 0);
  b.views.set(opened.open, { projection: { ...projection, terminalOutput: '' }, fetchedAt: Date.now() });
  assert.deepEqual(b.buildSnapshot().view.msgs, [], 'an empty viewport must not create a blank message row');
  assert.equal(snapshot.threads[0].closeTabId, 'w1:t1');
  await b.runCommand({ id: 3, verb: 'closeThread', args: [opened.open, snapshot.threads[0].closeTabId] });
  assert.equal(b.results.at(-1).ok, true);
  assert.equal(f.backend.threads.size, 0);
  b.t3 = { capabilities: {}, closeThread: () => { throw new Error('must not call'); } };
  await b.runCommand({ id: 4, verb: 'closeThread', args: [opened.open, 'w1:t1'] });
  assert.match(b.results.at(-1).msg, /not supported/);
  b.t3 = f.backend;
});
