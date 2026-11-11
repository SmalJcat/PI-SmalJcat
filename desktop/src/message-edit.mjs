import { textContent } from './transcript.mjs';

export function editableMessage(message) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return {
    text: textContent(message.content),
    images: blocks
      .filter(block => block?.type === 'image' && typeof block.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType))
      .map(block => ({ type: 'image', mimeType: block.mimeType, data: block.data })),
  };
}
