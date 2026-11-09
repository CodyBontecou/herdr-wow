// Markdown -> WoW font-string markup, and markdown -> plain text for speech.

const GOLD = 'ffffd100';
const WHITE = 'ffffffff';
const CODE = 'ffa8c7fa';
const DIM = 'ff9d9d9d';

const color = (hex, s) => `|c${hex}${s}|r`;

// WoW treats "|" as an escape character; double it so text can't inject markup.
export function escapeWow(s) {
  return String(s ?? '').replace(/\|/g, '||');
}

function inline(line) {
  let s = escapeWow(line);
  // Inline code first so its contents aren't formatted further.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[image: $1]');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text) => text);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, b) => color(WHITE, b));
  s = s.replace(/__([^_]+)__/g, (_, b) => color(WHITE, b));
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, '$1$2');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => color(CODE, codes[Number(i)]));
  return s;
}

export function markdownToWow(md, { maxChars = 3500 } = {}) {
  let text = String(md ?? '').replace(/\r\n/g, '\n');
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  const out = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    const fence = /^\s*```/.test(raw);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(color(CODE, '  ' + escapeWow(raw)));
      continue;
    }
    let m;
    if ((m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(raw))) {
      out.push(color(GOLD, inline(m[2])));
    } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(raw))) {
      const depth = Math.min(3, Math.floor(m[1].length / 2));
      out.push('  '.repeat(depth) + color(GOLD, '•') + ' ' + inline(m[2]));
    } else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw))) {
      const depth = Math.min(3, Math.floor(m[1].length / 2));
      out.push('  '.repeat(depth) + color(GOLD, m[2] + '.') + ' ' + inline(m[3]));
    } else if (/^\s*>\s?/.test(raw)) {
      out.push(color(DIM, inline(raw.replace(/^\s*>\s?/, ''))));
    } else if (/^\s*([-*_]\s*){3,}$/.test(raw)) {
      out.push(color(DIM, '—————'));
    } else if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue; // table separator row
      out.push(inline(raw.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('  ·  ')));
    } else {
      out.push(inline(raw));
    }
  }
  let s = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (truncated) s += '\n' + color(DIM, '… (open the thread in T3 Code for the rest)');
  return s;
}

// Terminal screens are grids, not paragraphs. Flatten only explicitly bordered
// tables; guessing columns from spaces would corrupt prose and command output.
// This is display-only: guarded terminal controls still inspect the raw screen.
export function terminalToWow(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const rule = (line) => /^\s*[┌┬┐├┼┤└┴┘╭╮╰╯╔╦╗╠╬╣╚╩╝─━═┏┳┓┣╋┫┗┻┛\s]+$/u.test(line) && /[─━═]/u.test(line);
  const cells = (line) => {
    const s = line.trim();
    if (!/^[│┃║].*[│┃║]$/u.test(s)) return null;
    return s.slice(1, -1).split(/[│┃║]/u).map((c) => c.trim());
  };
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      out.push(color(DIM, escapeWow(raw)));
      continue;
    }
    if (fence) {
      out.push(color(CODE, escapeWow(raw)));
      continue;
    }
    // A header, divider and equally sized body rows establish a table. Border
    // separators group wrapped cell lines into one logical row.
    const header = cells(raw);
    if (header && header.length > 1 && rule(lines[i + 1] || '')) {
      const rows = [];
      let row = null;
      let j = i + 2;
      for (; j < lines.length; j++) {
        if (rule(lines[j])) {
          row = null;
          continue;
        }
        const next = cells(lines[j]);
        if (!next || next.length !== header.length) break;
        if (!row || next[0]) { row = next; rows.push(row); }
        else next.forEach((c, k) => { if (c) row[k] += (row[k] ? ' ' : '') + c; });
      }
      if (rows.length) {
        for (const entry of rows) {
          out.push('', color(GOLD, escapeWow(entry[0] || header[0])));
          entry.slice(1).forEach((value, k) => {
            if (value) out.push(color(DIM, escapeWow(header[k + 1]) + ': ') + escapeWow(value));
          });
        }
        out.push('');
        i = j - 1;
        continue;
      }
    }
    if (rule(raw)) { out.push(''); continue; }
    // Never send unsupported box glyphs to the game font, even for incomplete
    // tables at the edge of a terminal viewport.
    const safe = raw.replace(/[│┃║]/gu, ' / ').replace(/[\u2500-\u257f]/gu, '-');
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(safe);
    out.push(heading ? color(GOLD, inline(heading[1])) : inline(safe));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

export function markdownToSpeech(md, { maxChars = 1500 } = {}) {
  let s = String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>|]/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (s.length > maxChars) {
    const cut = s.lastIndexOf('. ', maxChars);
    s = s.slice(0, cut > maxChars / 2 ? cut + 1 : maxChars);
  }
  return s;
}

export function firstLine(md, max = 140) {
  const plain = markdownToSpeech(md, { maxChars: max * 3 }).split('\n').find((l) => l.trim()) || '';
  return plain.length > max ? plain.slice(0, max - 1) + '…' : plain;
}
