// Deliberately narrow terminal UI recognition, not a transcript parser. Unknown
// layouts and approvals stay desktop-only. Keys are explicit player actions.
export function questionControls(agent, text) {
  if (!['codex', 'claude'].includes(agent.agent)) return null;
  const screen = text.replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).join('\n').trimEnd();
  const tail = screen.split('\n').slice(-35).join('\n');
  if (/(?:Do you want to (?:proceed|run|make)|Would you like to run the following command|Yes, proceed|Allow once|Allow for this session)/i.test(tail)) return null;
  const actions = [];
  const add = (key, label) => actions.push({ key, label });
  let textInput = false;
  let mode;
  if (agent.agent === 'codex' && ['working', 'blocked'].includes(agent.agent_status)) {
    // A queued request may be present while Codex is still working.
    const collapsed = tail.match(/^\s*\?\s+\d+ questions?(?: ·[^\n]*)?\s*\n\s*(⇧←|shift\+left|⇥|↹|tab) to answer/im);
    if (collapsed) {
      mode = 'collapsed';
      add(/^(?:⇧←|shift)/i.test(collapsed[1]) ? 'shift+left' : 'tab', 'Open questions');
    } else if (/\benter submit\b/i.test(tail) && /⌃\] skip/.test(tail)
      && /(?:main prompt|prev question)/.test(tail)) {
      mode = 'question';
      const selected = tail.match(/^\s*›\s*(\d+)\. (.*)$/m);
      const count = tail.match(/option \d+\/(\d+)/);
      const numbered = [...tail.matchAll(/^\s*[› ]?\s*(\d+)\. /gm)];
      // A literal suggested option called Other gets a separate custom row
      // named "Other (write an answer)". Only the last option is a text field.
      const lastOption = selected && (count ? selected[1] === count[1] : selected[1] === numbered.at(-1)?.[1]);
      textInput = selected ? lastOption && (selected[2] === 'Other (write an answer)'
        || selected[2] === 'Other' && !tail.includes('Other (write an answer)')) : /Type your answer/.test(tail);
      add('up', 'Previous option');
      add('down', 'Next option');
      if (/⇧→ prev question/.test(tail)) add('shift+right', 'Previous question');
      if (/⇧← next question/.test(tail)) add('shift+left', 'Next question');
      add('enter', 'Select / submit answer');
    } else if (/^\s*Question \d+\/\d+[^\n]*$/m.test(tail) && /\benter to submit (?:answer|all)\b/i.test(tail)) {
      mode = 'question';
      textInput = /(?:›\s*(?:Type your answer|Add notes)|tab or esc to clear notes)/i.test(tail);
      if (!textInput) {
        add('up', 'Previous option');
        add('down', 'Next option');
      }
      if (/tab to add notes/i.test(tail)) add('tab', 'Add a written answer');
      if (/←\/→ to navigate questions/.test(tail)) {
        add('left', 'Previous question');
        add('right', 'Next question');
      }
      add('enter', 'Select / submit answer');
    }
  } else if (agent.agent === 'claude' && agent.agent_status === 'blocked') {
    // AskUserQuestion's distinctive custom-answer/chat row plus its footer.
    // Do not recognize generic permission/approval menus by "Enter" alone.
    if (/^\s*[❯›>]?\s*\d+\. (?:Chat about this|Type something\.?)[ \t]*$/m.test(tail)
      && /enter to select/i.test(tail) && /(?:to navigate|keys to navigate)/i.test(tail)) {
      mode = 'question';
      textInput = /^\s*[❯›>]\s*\d+\. Type something\.?\s*$/m.test(tail);
      add('up', 'Previous option');
      add('down', 'Next option');
      add('space', 'Toggle choice (multiple choice)');
      add('tab', 'Next question / field');
      add('enter', 'Select / submit answer');
    } else if (/Ready to submit your answers\?/.test(tail) && /Submit answers/.test(tail)) {
      mode = 'confirm';
      add('enter', 'Submit answers');
    }
  }
  if (!mode) return null;
  return { mode, actions, textInput };
}
