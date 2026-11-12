import { parseArguments, formatCallResult } from './mcp.mjs';

export function parsePromptArguments(text, prompt) {
  const parsed = parseArguments(text);
  if (!parsed.ok) return parsed;
  if (Object.values(parsed.value).some(value => typeof value !== 'string')) {
    return { ok: false, error: '提示词参数的值必须是字符串。' };
  }
  for (const argument of prompt?.arguments || []) {
    if (argument.required && !Object.hasOwn(parsed.value, argument.name)) {
      return { ok: false, error: `缺少必填参数：${argument.name}` };
    }
  }
  return parsed;
}

export function defaultPromptArguments(prompt) {
  return JSON.stringify(Object.fromEntries((prompt?.arguments || []).filter(argument => argument.required).map(argument => [argument.name, ''])), null, 2);
}

function resourceText(content) {
  const heading = [content?.uri, content?.mimeType].filter(Boolean).join(' · ');
  const body = typeof content?.text === 'string' ? content.text
    : typeof content?.blob === 'string' ? `[二进制内容，Base64 ${content.blob.length} 字符]`
      : '[不支持的资源内容]';
  return [heading, body].filter(Boolean).join('\n');
}

export function formatResourceResult(result) {
  return (result?.contents || []).map(resourceText).join('\n\n') || '资源内容为空。';
}

export function formatPromptResult(result) {
  const messages = (result?.messages || []).map(message => {
    const content = message.content;
    const text = content?.type === 'resource' ? resourceText(content.resource)
      : formatCallResult({ content: [content] }).text;
    return `${message.role || 'unknown'}\n${text}`;
  });
  return [result?.description, ...messages].filter(Boolean).join('\n\n') || '提示词消息为空。';
}
