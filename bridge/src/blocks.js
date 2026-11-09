// Block styling is generated from raw text; never colorize already escaped WoW
// markup, or cut a formatted string in the middle of a color escape.
import { escapeWow, markdownToWow } from './format.js';

const color = (hex, text) => `|c${hex}${escapeWow(text)}|r`;
const KEYWORDS = new Set(('const let var function return if else for while do break continue async await import export from class new throw try catch finally true false null undefined local end then elseif nil and or not in def pass lambda with as yield None True False public private static void int string bool package func type struct select case switch default').split(' '));

export function highlightCode(text, language = '') {
  const lang = language.toLowerCase();
  const shell = /^(sh|bash|zsh|shell)$/.test(lang);
  const hashComment = shell || /^(py|python|ruby|rb|yaml|yml)$/.test(lang);
  const lua = lang === 'lua';
  const diff = /^(diff|patch)$/.test(lang);
  return text.split('\n').map((line) => {
    if ((diff || !lang) && /^[+-]/.test(line)) return color(line[0] === '+' ? 'ff8ed6a0' : 'fff08b8b', line);
    if (diff && /^@@/.test(line)) return color('ff80c9d8', line);
    // A small lexical highlighter, not a parser: strings/comments are consumed
    // before identifiers so keywords inside them cannot acquire nested colors.
    const tokens = line.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|--.*|#.*|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*|[^A-Za-z_$\d"'`/#-]+|./g) || [];
    return tokens.map((token) => {
      if (token.startsWith('//') && !shell || lua && token.startsWith('--') || hashComment && token.startsWith('#')) return color('ff8b97a8', token);
      if (/^["'`]/.test(token)) return color('ffa8cf91', token);
      if (/^\d/.test(token)) return color('ffe4b77b', token);
      if (KEYWORDS.has(token)) return color('ffc6a0ee', token);
      return escapeWow(token);
    }).join('');
  }).join('\n');
}

export function wowBlocks(blocks) {
  const out = [];
  let budget = 60000;
  for (const block of blocks.slice(-60).reverse()) {
    const raw = block.text.slice(0, 5000);
    const preview = raw.split('\n').slice(0, block.kind === 'thinking' ? 3 : 10).join('\n').slice(0, 900);
    const code = block.kind === 'code' || block.kind === 'tool';
    const format = (s) => code ? highlightCode(s, block.language || '') : markdownToWow(s, { maxChars: 5000 });
    const clipped = raw.length < block.text.length;
    const suffix = clipped ? '\n[More output is available in Pi.]' : '';
    const full = format(raw) + (suffix ? color('ff9d9d9d', suffix) : '');
    const collapsed = preview.length < raw.length;
    const t = collapsed ? format(preview) : full;
    const labels = { user: 'you', text: 'Pi', thinking: 'Thinking', code: block.language || 'Code' };
    const label = block.kind === 'tool' ? `${block.label} · ${block.status === 'error' ? 'Failed' : block.status === 'done' ? 'Completed' : 'Awaiting result'}` : labels[block.kind];
    const row = { id: block.id, kind: block.kind, r: block.kind === 'user' ? 'u' : 'a', label: escapeWow(label || 'Pi'), t, full: collapsed ? full : undefined, at: block.at ? Math.floor(block.at / 1000) : undefined, error: block.status === 'error' || undefined };
    const cost = t.length + (row.full?.length || 0);
    if (cost > budget && out.length) break;
    budget -= cost;
    out.unshift(row);
    if (out.length >= 40) break;
  }
  return out;
}
