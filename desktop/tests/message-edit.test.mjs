import test from 'node:test';
import assert from 'node:assert/strict';
import { editableMessage } from '../src/message-edit.mjs';
import { loadTranscript } from '../src/transcript.mjs';

test('editing preserves visible text and supported images without copying hidden blocks', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=', extra: 'internal' };
  const message = { role: 'user', _entryId: 'stable-entry', content: [
    { type: 'text', text: '你好🙂' }, image,
    { type: 'thinking', thinking: 'private' }, { type: 'toolCall', name: 'read' },
    { type: 'text', text: '第二段' },
  ] };
  const edit = editableMessage(loadTranscript([message]).messages[0]);
  assert.equal(loadTranscript([message]).messages[0]._entryId, 'stable-entry');
  assert.equal(edit.text, '你好🙂\n第二段');
  assert.deepEqual(edit.images, [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]);
  edit.images[0].data = 'changed';
  assert.equal(image.data, 'aW1hZ2U=');
  assert.deepEqual(editableMessage({ content: 'legacy string' }), { text: 'legacy string', images: [] });
  assert.deepEqual(editableMessage({ content: [{ type: 'image', mimeType: 'text/html', data: 'bad' }] }), { text: '', images: [] });
});
