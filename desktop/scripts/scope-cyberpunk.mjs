#!/usr/bin/env node
// 把 cyberpunk.css 的选择器收进 :root[data-ui="cyberpunk"] 作用域。
// 目的：让界面 preset（见 src/ui-theme.mjs）互不干扰——原先 cyberpunk.css 是无条件覆盖层，
// 任何新 preset 都要和它的硬编码颜色对打。转换是纯机械的，可重复执行（已转换的文件不会二次加前缀）。
// 用法：node scripts/scope-cyberpunk.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../src/cyberpunk.css', import.meta.url));
const SCOPE = ':root[data-ui="cyberpunk"]';
const check = process.argv.includes('--check');

const findClose = (text, open) => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

// 选择器文本里可能带前导注释；注释不是选择器的一部分，必须先摘掉再前缀，
// 否则会生成 ":root[data-ui=...] /* 注释 */ :root" 这种永远匹配不到的后代选择器。
const splitLeadingComments = selector => {
  let rest = selector.replace(/^\s+/, '');
  const comments = [];
  for (;;) {
    if (!rest.startsWith('/*')) break;
    const end = rest.indexOf('*/');
    if (end < 0) break;
    comments.push(rest.slice(0, end + 2));
    rest = rest.slice(end + 2).replace(/^\s+/, '');
  }
  return { comments: comments.join('\n'), selector: rest };
};

const scopeSelectorText = selector => {
  const { comments, selector: bare } = splitLeadingComments(selector);
  const scoped = bare
    .split(',')
    .map(part => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      if (trimmed.startsWith(SCOPE)) return trimmed;
      if (trimmed === ':root') return SCOPE;
      return `${SCOPE} ${trimmed}`;
    })
    .filter(Boolean)
    .join(', ');
  if (!scoped) return comments;
  return comments ? `${comments}\n${scoped}` : scoped;
};

function scope(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const brace = text.indexOf('{', index);
    if (brace < 0) { out += text.slice(index); break; }
    const selector = text.slice(index, brace);
    const close = findClose(text, brace);
    if (close < 0) { out += text.slice(index); break; }
    const body = text.slice(brace + 1, close);
    const trimmed = selector.trim();
    if (!trimmed) { out += text.slice(index, close + 1); index = close + 1; continue; }
    if (trimmed.startsWith('@')) {
      const nested = /^@(media|supports|container|layer)/.test(trimmed);
      out += `${selector}{${nested ? scope(body) : body}}`;
    } else {
      const leading = selector.slice(0, selector.length - selector.trimStart().length);
      const trailing = selector.slice(selector.trimEnd().length);
      out += `${leading}${scopeSelectorText(trimmed)}${trailing}{${body}}`;
    }
    index = close + 1;
  }
  return out;
}

const original = readFileSync(target, 'utf8');
const scoped = scope(original);
const changed = scoped !== original;
if (check) {
  console.log(changed ? '需要转换' : '已经是作用域化版本');
  process.exitCode = changed ? 1 : 0;
} else {
  writeFileSync(target, scoped);
  console.log(`${changed ? '已转换' : '无需转换'}：${target}`);
}
