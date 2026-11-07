// Completion ranges use UTF-16 offsets, matching textarea.selectionStart/End.
export function completionAt(text, start, end = start) {
  if (start !== end || start < 0 || start > text.length) return null;
  const command = /^\/([^\s]*)/.exec(text);
  if (command && start > 0 && start <= command[0].length) {
    return { kind: 'command', query: text.slice(1, start), start: 0, end: command[0].length };
  }
  const match = /(?:^|\s)@([^\s@"]*)$/.exec(text.slice(0, start));
  if (!match) return null;
  // Replace the rest of the token when completing from the middle of a word.
  const remainder = /^[^\s@"]*/.exec(text.slice(start))[0];
  return { kind: 'file', query: match[1], start: start - match[1].length - 1, end: start + remainder.length };
}

export function commandSuggestions(commands, query) {
  const search = query.toLowerCase();
  return commands
    .filter(command => command.name.toLowerCase().includes(search))
    .map((command, index) => ({ command, index, rank: command.name.toLowerCase() === search ? 0 : command.name.toLowerCase().startsWith(search) ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, 7)
    .map(({ command }) => command);
}

export function applyCompletion(text, range, value) {
  const token = range.kind === 'command' ? `/${value}` : /\s/.test(value) ? `@"${value}"` : `@${value}`;
  const after = text.slice(range.end);
  const separator = after.startsWith(' ') ? '' : ' ';
  return { text: text.slice(0, range.start) + token + separator + after, cursor: range.start + token.length + 1 };
}

export function completionKeyAction(event, kind, count, loading, exactCommand = false) {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (event.key === 'Escape') return 'dismiss';
  if (count && event.key === 'ArrowDown') return 'next';
  if (count && event.key === 'ArrowUp') return 'previous';
  if (event.key === 'Enter' || event.key === 'Tab') {
    if (kind === 'file' && loading) return 'wait';
    if (count && !(event.key === 'Enter' && kind === 'command' && exactCommand)) return 'accept';
  }
  return null;
}
