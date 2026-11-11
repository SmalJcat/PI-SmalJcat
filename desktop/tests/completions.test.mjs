import test from 'node:test';
import assert from 'node:assert/strict';
import { completionAt, applyCompletion, commandSuggestions, completionKeyAction } from '../src/completions.mjs';

test('command completion follows the caret and preserves arguments after the token', () => {
  const text = '/rev keep these arguments';
  const range = completionAt(text, 4);
  assert.deepEqual(range, { kind: 'command', query: 'rev', start: 0, end: 4 });
  assert.deepEqual(applyCompletion(text, range, 'review'), { text: '/review keep these arguments', cursor: 8 });
  assert.equal(completionAt(text, text.length), null);
  assert.equal(completionAt('normal /rev', 11), null);
  assert.equal(completionAt('/rev', 0, 4), null);
});

test('file completion handles mid-token edits and quoted filenames without consuming surrounding text', () => {
  const text = '看 @src/old.ts 后续';
  const range = completionAt(text, 8);
  assert.equal(range.query, 'src/o');
  assert.deepEqual(applyCompletion(text, range, 'src/new file.ts'), { text: '看 @"src/new file.ts" 后续', cursor: '看 @"src/new file.ts" '.length });
  assert.equal(completionAt('mail@example.com', 16), null);
  assert.equal(completionAt('@"src/file name.ts" ', 20), null);
  assert.equal(completionAt('检查 @src', 3, 7), null);
});

test('exact commands and prefixes sort before substring matches; command kinds remain usable', () => {
  const commands = [{ name: 'skill:review' }, { name: 'preview' }, { name: 'review-all' }, { name: 'review' }];
  assert.deepEqual(commandSuggestions(commands, 'rev').map(c => c.name), ['review-all', 'review', 'skill:review', 'preview']);
  assert.equal(commandSuggestions(commands, 'review')[0].name, 'review');
  assert.equal(commandSuggestions(commands, 'SKILL:')[0].name, 'skill:review');
  assert.equal(commandSuggestions(commands, 'missing').length, 0);
});

test('IME and newline keys never accept a suggestion; Escape closes loading and empty menus', () => {
  assert.equal(completionKeyAction({ key: 'Enter', isComposing: true }, 'file', 2, false), null);
  assert.equal(completionKeyAction({ key: 'Enter', keyCode: 229 }, 'command', 2, false), null);
  assert.equal(completionKeyAction({ key: 'Enter', shiftKey: true }, 'file', 2, false), null);
  assert.equal(completionKeyAction({ key: 'Tab', shiftKey: true }, 'command', 2, false), null);
  assert.equal(completionKeyAction({ key: 'Escape' }, 'file', 0, true), 'dismiss');
  assert.equal(completionKeyAction({ key: 'Escape' }, 'file', 0, false), 'dismiss');
  assert.equal(completionKeyAction({ key: 'Enter' }, 'file', 0, true), 'wait');
});

test('partial commands accept without executing, exact command Enter keeps existing send behavior', () => {
  assert.equal(completionKeyAction({ key: 'Enter' }, 'command', 2, false), 'accept');
  assert.equal(completionKeyAction({ key: 'Enter' }, 'command', 1, false, true), null);
  assert.equal(completionKeyAction({ key: 'Tab' }, 'command', 1, false, true), 'accept');
  assert.equal(completionKeyAction({ key: 'ArrowUp' }, 'file', 2, false), 'previous');
});
