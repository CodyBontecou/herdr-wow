// Herdr is the session owner. Question controls use explicit, guarded terminal
// input; approvals stay desktop-only. Never change the user's terminal focus.
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { questionControls } from './herdr-questions.js';
import { readPiSession } from './pi-session.js';

const PROMPT_AGENTS = new Set(['pi', 'codex', 'claude']);
const spaceId = (workspace) => `space:${workspace}`;

function questionDigest(text, controls) {
  // Opening the queue cannot answer anything. Ignore animated/background output
  // for that action only, but require the same recognized opener and count.
  const screen = controls.mode === 'collapsed'
    ? JSON.stringify([controls.actions, text.match(/\?\s+\d+ questions?/gi)?.at(-1)]) : text;
  return createHash('sha256').update(screen).digest('hex');
}

export const HERDR_CAPABILITIES = Object.freeze({
  images: false, stop: false, approvals: false, answers: true, settle: false,
  archive: false, busySend: false, closeThread: true,
});

export function herdrCommand(args, { timeout = 10000, session } = {}) {
  const prefix = session ? ['--session', session] : [];
  const env = { ...process.env };
  if (session) {
    // Inherited sockets override session selection in Herdr. Never let the
    // terminal that starts the bridge redirect a configured named session.
    for (const key of ['HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_SESSION', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID']) delete env[key];
  }
  return new Promise((resolve, reject) => {
    execFile('herdr', [...prefix, ...args], { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, env }, (err, stdout, stderr) => {
      // Reads are plain text in the CLI (unlike the socket API). Agent-written
      // JSON must never be mistaken for a protocol envelope.
      if (!err && ['agent', 'pane'].includes(args[0]) && args[1] === 'read') return resolve({ read: { text: stdout } });
      let data;
      try { data = JSON.parse(err ? stderr : stdout); } catch {}
      if (err || data?.error) {
        const error = new Error(data?.error?.message || `Herdr: ${err?.message || 'request failed'}`);
        error.code = data?.error?.code || err?.code;
        return reject(error);
      }
      if (!data?.result) return reject(new Error('Herdr returned an invalid response'));
      resolve(data.result);
    });
  });
}

// A terminal viewport is a fixed-height grid. Its empty outer rows aren't
// message spacing; keep indentation and blank lines inside the content intact.
function withoutTerminalPadding(text) {
  const lines = text.split(/\r?\n/);
  let first = 0, last = lines.length;
  while (first < last && !lines[first].trim()) first++;
  while (last > first && !lines[last - 1].trim()) last--;
  return lines.slice(first, last).join('\n');
}

// Pi's usage widget lives just above its editor, so Herdr can include it in
// terminal reads. Only remove a recognized trailing UI block, never arbitrary
// mentions of "wk", progress bars in replies, or fenced code examples.
function withoutPiFooter(text) {
  const lines = text.split(/\r?\n/);
  const meter = /^\s{2,}wk\s+[\u2580-\u259f\u25b0\u25b1]+\s+\d+(?:\.\d+)?%\s+\([^\r\n)]{1,32}\)\s*$/u;
  const rule = /^\s*[─━]{2,}.*[─━]\s*$/u;
  const metadata = /^\s*(?:~\/|\/|[A-Za-z]:[\\/]|↑|↓)/u;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence || i < lines.length - 20 || !meter.test(lines[i])) continue;
    const tail = lines.slice(i + 1).filter((line) => line.trim());
    if (tail.length && rule.test(tail[0]) && tail.every((line) => rule.test(line) || metadata.test(line))) {
      return lines.slice(0, i).join('\n');
    }
  }
  return text;
}

// Explicit configuration selects launch destinations, not what may be viewed.
// Never accept a directory, executable or native launch arguments from the game.
export function validateHerdrConfig(config = {}) {
  const projects = config.projects || [];
  if (!Array.isArray(projects)) throw new Error('herdr.projects must be an array');
  if (config.session && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.session)) throw new Error('Invalid Herdr session name');
  const ids = new Set();
  return projects.map((p) => {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(p.id || '') || ids.has(p.id)) throw new Error('Herdr project IDs must be unique lowercase names');
    if (!/^w[A-Za-z0-9]+$/.test(p.workspace || '')) throw new Error(`Configure a Herdr workspace for project ${p.id}`);
    if (!p.cwd || !path.isAbsolute(p.cwd) || !fs.statSync(p.cwd).isDirectory()) throw new Error(`Herdr project ${p.id} needs an existing absolute cwd`);
    ids.add(p.id);
    return { id: p.id, title: String(p.name || p.id), cwd: fs.realpathSync(p.cwd), workspace: p.workspace };
  });
}

function sessionKey(agent) {
  // A new agent occupying an old pane is a new thread. Do not route saved views
  // or delayed commands to its replacement. Older Herdr versions need terminal_id.
  const identity = [agent.terminal_id, agent.agent, agent.agent ? agent.agent_session?.value || '' : ''].join('\0');
  return `herdr-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

export class HerdrBackend extends EventEmitter {
  constructor({ config, log = () => {}, run = herdrCommand, readSession = readPiSession } = {}) {
    super();
    this.settings = { ...config, session: config?.session || 'default' };
    const projects = validateHerdrConfig(config);
    this.launchProjects = new Map(projects.map((p) => [p.id, p]));
    this.projects = new Map(projects.map((p) => [p.id, { ...p, launch: true, browse: false, filterId: spaceId(p.workspace) }]));
    this.showAllTabs = true;
    this.threads = new Map();
    this.agents = new Map();
    this.visited = new Map();
    this.questions = new Map();
    this.log = log;
    this.readSession = readSession;
    this.run = (args, options = {}) => run(args, { ...options, session: this.settings.session });
    this.state = 'disconnected';
    this.error = null;
    this.origin = 'Herdr';
    this.label = 'Herdr';
    this.envs = [{ local: true }];
    this.config = { providers: [], environment: { label: 'Herdr' } };
    this.capabilities = HERDR_CAPABILITIES;
    this.stopped = true;
  }

  environments() { return [{ label: 'Herdr', local: true, state: this.state, threads: this.threads.size }]; }
  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit('state', state, error);
  }
  start() {
    this.stopped = false;
    const poll = async () => {
      await this.refresh();
      if (!this.stopped) this.timer = setTimeout(poll, 2000);
    };
    void poll();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }

  projectFor(entry) {
    return this.projects.get(spaceId(entry.workspace_id));
  }

  matchesLaunchProject(agent, project) {
    if (agent?.agent !== 'pi' || agent.workspace_id !== project.workspace) return false;
    try { return fs.realpathSync(agent.foreground_cwd || agent.cwd) === project.cwd; } catch { return false; }
  }

  ingest(agent, project, tab = {}, paneNumber = null) {
    if (!agent.terminal_id || !agent.pane_id) throw new Error('Herdr returned an agent without a terminal identity');
    const id = sessionKey(agent);
    const prev = this.threads.get(id);
    const now = new Date().toISOString();
    const status = agent.agent_status;
    const kind = agent.agent ? 'agent' : 'terminal';
    const uiStatus = kind === 'terminal' ? 'open' : status === 'working' ? 'working' : status === 'blocked' || status === 'unknown' ? 'input' : 'open';
    const agentName = { pi: 'Pi', codex: 'Codex', claude: 'Claude Code' }[agent.agent] || agent.agent || 'Terminal';
    const tabName = tab.label || agent.name || agent.title || agent.terminal_title_stripped || 'Tab';
    const title = `${tabName} · ${agentName}${paneNumber ? ` · Pane ${paneNumber}` : ''}`;
    const capabilities = { ...this.capabilities, send: PROMPT_AGENTS.has(agent.agent) };
    const changed = !prev || prev.herdrStatus !== status || prev.title !== title || prev.projectId !== project.id;
    const completed = prev?.uiStatus === 'working' && (status === 'idle' || status === 'done');
    const thread = {
      id, projectId: project.id, title, kind, closeTabId: agent.tab_id,
      uiStatus, herdrStatus: status, capabilities,
      statusLabel: kind === 'terminal' ? 'Terminal (read-only)' : status === 'blocked' ? 'Needs input in Herdr' : status === 'unknown' ? 'Check agent in Herdr' : status === 'working' ? 'Working' : 'Ready',
      updatedAt: changed ? now : prev.updatedAt,
      latestRunStartedAt: status === 'working' ? prev?.uiStatus === 'working' ? prev.latestRunStartedAt : now : prev?.latestRunStartedAt,
      latestRunCompletedAt: completed ? now : prev?.latestRunCompletedAt,
      lastVisitedAt: this.visited.get(id),
    };
    this.agents.set(id, agent);
    this.threads.set(id, thread);
    if (changed) this.emit('change', { kind: 'thread', id, thread, prev });
    return id;
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.run(['api', 'snapshot']).then(({ snapshot }) => {
      if (!snapshot || !['workspaces', 'tabs', 'panes', 'agents'].every((key) => Array.isArray(snapshot[key]))) throw new Error('Herdr returned an invalid topology snapshot');
      const beforeProjects = JSON.stringify([...this.projects.values()]);
      const projects = new Map([...this.launchProjects].map(([id, p]) => [id, { ...p, launch: true, browse: false, filterId: spaceId(p.workspace) }]));
      for (const workspace of snapshot.workspaces) {
        const id = spaceId(workspace.workspace_id);
        projects.set(id, { id, title: workspace.label || workspace.workspace_id, browse: true, launch: false });
      }
      this.projects = projects;
      const tabs = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
      const agents = new Map(snapshot.agents.map((agent) => [agent.pane_id, agent]));
      const paneCounts = new Map();
      for (const pane of snapshot.panes) paneCounts.set(pane.tab_id, (paneCounts.get(pane.tab_id) || 0) + 1);
      const paneNumbers = new Map();
      const seen = new Set();
      const beforeOrder = [...this.threads.keys()];
      // Topology arrays follow desktop order; pane discovery and Map insertion do not.
      const orderedPanes = snapshot.workspaces.flatMap((workspace) => snapshot.tabs
        .filter((tab) => tab.workspace_id === workspace.workspace_id)
        .flatMap((tab) => snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id)));
      for (const pane of orderedPanes) {
        const agent = agents.get(pane.pane_id);
        const entry = { ...pane, ...agent, agent: agent?.agent || null, agent_session: agent?.agent_session };
        const project = this.projectFor(entry);
        const tab = tabs.get(pane.tab_id);
        if (!project || !tab || tab.workspace_id !== pane.workspace_id) continue;
        const number = (paneNumbers.get(pane.tab_id) || 0) + 1;
        paneNumbers.set(pane.tab_id, number);
        seen.add(this.ingest(entry, project, tab, paneCounts.get(pane.tab_id) > 1 ? number : null));
      }
      for (const id of this.threads.keys()) if (!seen.has(id)) {
        this.threads.delete(id);
        this.agents.delete(id);
        this.questions.delete(id);
        this.emit('change', { kind: 'removed', id });
      }
      this.threads = new Map([...seen].map((id) => [id, this.threads.get(id)]));
      if (JSON.stringify(beforeOrder) !== JSON.stringify([...seen])) this.emit('change', { kind: 'snapshot' });
      if (beforeProjects !== JSON.stringify([...this.projects.values()])) this.emit('change', { kind: 'project' });
      this.setState('connected');
    }).catch((err) => { this.setState('offline', err.message); }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async resolve(id) {
    const known = this.agents.get(id);
    if (!known) throw new Error('That tab is no longer available in Herdr');
    const result = await this.run([known.agent ? 'agent' : 'pane', 'get', known.pane_id]);
    const entry = known.agent ? result.agent : result.pane;
    if (!entry || sessionKey(entry) !== id || !this.projectFor(entry)) throw new Error('The session changed; refresh the tab list');
    return entry;
  }

  async threadProjection(id) {
    const agent = await this.resolve(id);
    // Herdr cannot page alternate-screen history while an agent is working.
    // Read the viewport instead, without scrolling or interrupting that agent.
    const visible = !agent.agent || !['idle', 'done'].includes(agent.agent_status);
    const viewport = [agent.agent ? 'agent' : 'pane', 'read', agent.pane_id, '--source', 'visible'];
    let result;
    try {
      result = await this.run(visible ? viewport : ['agent', 'read', agent.pane_id, '--source', 'recent-unwrapped', '--lines', '120']);
    } catch (err) {
      if (visible || err.code !== 'agent_not_idle') throw err;
      result = await this.run(viewport); // The agent became busy after get.
    }
    const { read } = result;
    if (typeof read?.text !== 'string') throw new Error('Herdr returned no terminal output');
    const readOnly = !PROMPT_AGENTS.has(agent.agent);
    const output = agent.agent === 'pi' ? withoutPiFooter(read.text) : read.text;
    const terminalQuestion = this.questionFor(id, agent, read.text);
    const blocks = !terminalQuestion && agent.agent === 'pi' && ['idle', 'done', 'working'].includes(agent.agent_status) ? this.readSession(agent) : null;
    if (blocks) {
      const messages = blocks.filter((b) => b.kind === 'user' || b.kind === 'text').map((b) => ({ role: b.kind === 'user' ? 'user' : 'assistant', text: b.text, createdAt: b.at, updatedAt: b.at }));
      return { blocks, messages, note: 'Pi’s last saved branch. In-progress replies appear when Pi saves them. Questions and approvals still use Herdr.' };
    }
    return { terminalOutput: withoutTerminalPadding(output), terminalTruncated: read.truncated, terminalQuestion, messages: [], note: `Recent terminal output, not full conversation history. ${readOnly ? 'This tab is read-only; use Herdr to interact with it.' : terminalQuestion ? 'Question controls send keys to the displayed terminal. Review each screen before submitting. Written text is entered without submitting.' : 'Unrecognized questions and approvals must be handled in Herdr.'}` };
  }

  async sendMessage(id, text, mode = 'auto', attachments = []) {
    if (attachments.length) throw new Error('Screenshots are not supported by the Herdr backend yet');
    if (mode !== 'auto') throw new Error('Steering is not supported by the Herdr backend yet');
    const agent = await this.resolve(id);
    if (!PROMPT_AGENTS.has(agent.agent)) throw new Error('This tab is read-only; use Herdr to interact with it');
    if (!['idle', 'done'].includes(agent.agent_status)) throw new Error('The agent is busy or needs input. Open Herdr, or wait until it is ready to reply.');
    await this.run(['agent', 'prompt', agent.pane_id, text], { timeout: 15000 });
    await this.refresh();
  }

  async launchThread(projectId, text = '', attachments = []) {
    const project = this.launchProjects.get(projectId);
    if (!project) throw new Error('Pick a configured Herdr project');
    if (attachments.length) throw new Error('Screenshots are not supported by the Herdr backend yet');
    const name = `wow-pi-${randomUUID().slice(0, 8)}`;
    let created;
    try {
      created = await this.run(['tab', 'create', '--workspace', project.workspace, '--cwd', project.cwd, '--label', name, '--no-focus']);
    } catch (err) {
      throw new Error(`${err.message}. Check Herdr for tab ${name} before retrying.`);
    }
    const pane = created.root_pane?.pane_id;
    if (!pane) throw new Error('Herdr created no root pane; check Herdr before retrying');
    try {
      // New tabs may return before their interactive shell is ready. Herdr's
      // agent_pane_busy rejection occurs before any input is sent; only that
      // definite rejection is safe to retry. Never retry an uncertain startup.
      let started;
      const deadline = Date.now() + 5000;
      while (!started) {
        try {
          started = await this.run(['agent', 'start', name, '--kind', 'pi', '--pane', pane], { timeout: 40000 });
        } catch (err) {
          if (err.code !== 'agent_pane_busy' || Date.now() >= deadline) throw err;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      const { agent } = started;
      if (!this.matchesLaunchProject(agent, project)) throw new Error('Pi started outside the configured project');
      const id = spaceId(project.workspace);
      if (!this.projects.has(id)) this.projects.set(id, { id, title: project.workspace, browse: true, launch: false });
      const threadId = this.ingest(agent, this.projects.get(id), created.tab);
      // An empty new-tab request leaves a fresh Pi session ready for input.
      // Never submit an empty prompt or implicitly resume an existing session.
      if (text.trim()) await this.sendMessage(threadId, text);
      return { threadId };
    } catch (err) {
      // The operation may have partially succeeded. Keep the tab for inspection;
      // never kill a possibly-running agent or auto-retry its initial prompt.
      throw new Error(`${err.message}. Check Herdr pane ${pane} before retrying; its tab was kept.`);
    }
  }

  async visit(id) {
    await this.resolve(id);
    this.visited.set(id, new Date().toISOString());
    const thread = this.threads.get(id);
    thread.lastVisitedAt = this.visited.get(id);
    this.emit('change', { kind: 'thread', id, thread });
  }

  async closeThread(id, expectedTabId) {
    const known = this.agents.get(id);
    if (!known?.tab_id) throw new Error('That tab is no longer available in Herdr');
    if (!expectedTabId || known.tab_id !== expectedTabId) throw new Error('The tab changed; refresh the tab list before closing');
    const tabId = known.tab_id;
    const workspaceId = known.workspace_id;
    const entry = await this.resolve(id);
    // A pane can move without changing its terminal/session identity. Never
    // close a different tab because the user confirmed an older snapshot.
    if (entry.tab_id !== tabId || entry.workspace_id !== workspaceId) throw new Error('The tab changed; refresh the tab list before closing');
    await this.run(['tab', 'close', tabId]);
    await this.refresh();
  }

  interrupt() { throw new Error('Stop Pi in Herdr; in-game interruption is not supported yet'); }
  settle() { throw new Error('Settling Herdr sessions is not supported yet'); }
  unsettle() { return this.settle(); }
  archive() { throw new Error('Archive Herdr sessions on your desktop'); }
  respondApproval() { throw new Error('Handle this approval in Herdr'); }
  questionFor(id, agent, text) {
    const controls = questionControls(agent, text);
    if (!controls) { this.questions.delete(id); return undefined; }
    // Snapshot precondition, not an atomic terminal transaction. Answer screens
    // fail closed on any change; the non-answering queue opener ignores timers.
    const digest = questionDigest(text, controls);
    const previous = this.questions.get(id);
    const request = previous?.digest === digest ? previous : { id: randomUUID(), digest, ...controls };
    this.questions.set(id, request);
    return { id: request.id, actions: request.actions, textInput: request.textInput };
  }

  async respondAnswers(id, requestId, answers) {
    const request = this.questions.get(id);
    if (!request || request.id !== requestId) throw new Error('The question changed. Refresh and review it before answering.');
    const entries = Object.entries(answers);
    if (entries.length !== 1) throw new Error('Send one question action at a time');
    const [[kind, value]] = entries;
    if (typeof value !== 'string') throw new Error('Send one question action at a time');
    if (kind === 'key') {
      if (!request.actions.some((action) => action.key === value)) throw new Error('That question action is not available');
    } else if (kind !== 'text' || !request.textInput || !value.trim() || value.length > 2300 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Select a question text field first; only single-line text can be entered');
    }
    const agent = await this.resolve(id);
    const { read } = await this.run(['agent', 'read', agent.pane_id, '--source', 'visible']);
    const controls = typeof read?.text === 'string' && questionControls(agent, read.text);
    if (!controls || questionDigest(read.text, controls) !== request.digest) {
      this.questions.delete(id);
      throw new Error('The question screen changed. Refresh and review it before answering.');
    }
    // Consume before writing. A timeout may mean input arrived: never retry it.
    this.questions.delete(id);
    if (kind === 'key') await this.run(['agent', 'send-keys', agent.pane_id, value]);
    else await this.run(['pane', 'send-text', agent.pane_id, value]);
    await this.refresh();
  }
  uploadImage() { throw new Error('Screenshots are not supported by the Herdr backend yet'); }
}
