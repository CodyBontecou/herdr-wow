// Read-only Pi transcript projection. Never search for a session by cwd: only
// the exact session identity reported by Herdr may supply a transcript.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const textContent = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : '';

export function parsePiSession(source) {
  const lines = source.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { entries.push(JSON.parse(lines[i])); }
    catch {
      // A writer may be halfway through its final append. Corrupt completed
      // records are not safe to project as a conversation.
      if (i !== lines.length - 1) return null;
    }
  }
  const header = entries.shift();
  if (header?.type !== 'session' || ![2, 3].includes(header.version)) return null;
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const branch = [];
  const seen = new Set();
  let entry = entries.filter((e) => e.id).at(-1);
  while (entry) {
    if (seen.has(entry.id)) return null;
    seen.add(entry.id);
    branch.push(entry);
    if (entry.parentId == null) break;
    entry = byId.get(entry.parentId);
    if (!entry) return null;
  }
  branch.reverse();
  const blocks = [];
  const calls = new Map();
  for (const e of branch) {
    if (e.type !== 'message') continue; // No system prompts, extension state or credentials.
    const m = e.message;
    if (!m) continue;
    const base = { at: m.timestamp, id: e.id };
    if (m.role === 'user') {
      const text = textContent(m.content);
      if (text.trim()) blocks.push({ ...base, kind: 'user', text });
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      m.content.forEach((c, i) => {
        const block = { ...base, id: `${e.id}:${i}` };
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          // Fenced code is a separate card, not a colored span inside prose.
          const re = /(^|\n)[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
          let start = 0, match, n = 0;
          while ((match = re.exec(c.text))) {
            const prose = c.text.slice(start, match.index).trim();
            if (prose) blocks.push({ ...block, id: `${block.id}:${n++}`, kind: 'text', text: prose });
            blocks.push({ ...block, id: `${block.id}:${n++}`, kind: 'code', language: match[3].trim().split(/\s/)[0], text: match[4] });
            start = re.lastIndex;
          }
          const prose = c.text.slice(start).trim();
          if (prose) blocks.push({ ...block, id: `${block.id}:${n}`, kind: 'text', text: prose });
        } else if (c.type === 'thinking' && !c.redacted && typeof c.thinking === 'string' && c.thinking.trim()) {
          blocks.push({ ...block, kind: 'thinking', text: c.thinking });
        } else if (c.type === 'toolCall' && typeof c.name === 'string') {
          const args = c.arguments || {};
          const command = typeof args.command === 'string' ? args.command : JSON.stringify(args, null, 2);
          const tool = { ...block, kind: 'tool', label: c.name, text: command, status: 'pending' };
          blocks.push(tool);
          calls.set(c.id, tool);
        }
      });
    } else if (m.role === 'toolResult') {
      const tool = calls.get(m.toolCallId);
      if (tool) {
        tool.status = m.isError ? 'error' : 'done';
        const output = textContent(m.content);
        tool.text += output ? '\n\n' + output : '\n\n(no text output)';
      }
    } else if (m.role === 'bashExecution' && typeof m.command === 'string') {
      blocks.push({ ...base, kind: 'tool', label: 'shell', status: m.cancelled || m.exitCode ? 'error' : 'done', text: m.command + '\n\n' + (m.output || '') });
    }
  }
  return { header, blocks };
}

// Only retain the last viewed session; unchanged polls need not parse its
// entire history again, and visiting many tabs cannot grow an unbounded cache.
let cached = null;

export function readPiSession(agent, { sessionRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions') } = {}) {
  if (agent.agent !== 'pi' || agent.agent_session?.kind !== 'path') return null;
  const file = agent.agent_session.value;
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return null;
  let fd;
  try {
    const root = fs.realpathSync(sessionRoot);
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(root + path.sep)) return null;
    fd = fs.openSync(resolved, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return null;
    const cwd = fs.realpathSync(agent.cwd);
    const key = [resolved, cwd, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join('\0');
    if (cached?.key === key) return cached.blocks;
    const buffer = Buffer.alloc(stat.size);
    const size = fs.readSync(fd, buffer, 0, stat.size, 0);
    const parsed = parsePiSession(buffer.subarray(0, size).toString('utf8'));
    if (!parsed || fs.realpathSync(parsed.header.cwd) !== cwd) return null;
    const blocks = parsed.blocks.length ? parsed.blocks : null;
    cached = { key, blocks };
    return blocks;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
