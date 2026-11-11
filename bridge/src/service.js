// Process supervision and single-instance ownership, independent of transport state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export async function acquireInstance(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // A loopback listener is an OS-owned lock: crashes release it without stale PID
  // files. Include the user and canonical state directory in its stable identity.
  const identity = `${os.userInfo().uid}:${fs.realpathSync(stateDir)}`;
  const port = 20000 + crypto.createHash('sha256').update(identity).digest().readUInt32BE() % 40000;
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(err.code === 'EADDRINUSE'
      ? `Bridge instance lock is occupied on 127.0.0.1:${port}. Stop the existing bridge (or check for a port conflict).`
      : err.message)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return () => new Promise((resolve) => server.close(resolve));
}

export const AGENT_LABEL = 'io.herdr.wow.bridge';
export const agentFile = () => path.join(os.homedir(), 'Library/LaunchAgents', `${AGENT_LABEL}.plist`);
const xml = (text) => String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function launchAgent({ node, script, stateDir, envPath, env = process.env }) {
  const string = (s) => `<string>${xml(s)}</string>`;
  // Preserve path overrides, not credentials or the entire invoking shell.
  const variables = { PATH: envPath };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'HERDR_CONFIG_PATH', 'T3CODE_HOME']) {
    if (env[key]) variables[key] = env[key];
  }
  const environment = Object.entries(variables).map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(AGENT_LABEL)}
<key>ProgramArguments</key><array>${[node, script, 'run'].map(string).join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict>${environment}</dict>
<key>StandardOutPath</key>${string(path.join(stateDir, 'bridge.log'))}
<key>StandardErrorPath</key>${string(path.join(stateDir, 'bridge.log'))}
</dict></plist>
`;
}

export async function installAgent(options) {
  fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(agentFile()), { recursive: true });
  const domain = `gui/${process.getuid()}`;
  // Validate before replacing a working service definition.
  const temp = `${agentFile()}.new`;
  fs.writeFileSync(temp, launchAgent(options), { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', temp], { stdio: 'pipe' });
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${AGENT_LABEL}`]);
  // Give a stopped agent time to release its OS-owned instance lock.
  let release;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { release = await acquireInstance(options.stateDir); break; } catch (err) {
      if (attempt === 49) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await release();
  fs.renameSync(temp, agentFile());
  execFileSync('/bin/launchctl', ['bootstrap', domain, agentFile()], { stdio: 'pipe' });
}

export function removeAgent() {
  if (!fs.existsSync(agentFile())) return;
  spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${AGENT_LABEL}`]);
  fs.rmSync(agentFile());
}
