import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalToWow } from '../src/format.js';

const plain = (s) => s.replace(/\|c[0-9a-f]{8}|\|r/g, '');

test('terminal tables become labeled entries with wrapped cells and separate rows', () => {
  const screen = [
    'Summary',
    '┌─────────┬──────────────┐',
    '│ Project │ Status       │',
    '├─────────┼──────────────┤',
    '│ GitSync │ Merged;      │',
    '│         │ review open  │',
    '├─────────┼──────────────┤',
    '│ Tide    │ Not released │',
    '│ Android │ Unconfirmed  │',
    '└─────────┴──────────────┘',
    'Next steps remain open.',
  ].join('\n');
  assert.equal(plain(terminalToWow(screen)), 'Summary\n\nGitSync\nStatus: Merged; review open\n\nTide\nStatus: Not released\n\nAndroid\nStatus: Unconfirmed\n\nNext steps remain open.');
});

test('terminal formatting preserves indentation, code, and WoW markup safety', () => {
  const screen = '  indented prose\n\n```\n│ raw code │\n|cffffffffunsafe|r\n```\n# Result\nUse **care** and `literal|value`.';
  const output = terminalToWow(screen);
  assert.ok(output.startsWith('  indented prose'));
  assert.ok(output.includes('│ raw code │'));
  assert.ok(output.includes('||cffffffffunsafe||r'));
  assert.ok(output.includes('|cffffd100Result|r'));
  assert.ok(output.includes('literal||value'));
});

test('partial tables stay readable without guessing columns from whitespace', () => {
  assert.equal(plain(terminalToWow('│ release │ pending │\n  alpha   beta\n└───────┘\nDone')), ' /  release  /  pending  / \n  alpha   beta\n\nDone');
  assert.equal(terminalToWow('literal | WoW markup\nsecond line'), 'literal || WoW markup\nsecond line');
});
