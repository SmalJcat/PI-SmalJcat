// Pure helpers for `npm run ui:capture`. The browser-side audit is a self-contained
// function so it can be passed to page.evaluate without closures.

export const THEMES = ['chatgpt', 'cyberpunk', 'classic'];
export const DEFAULT_VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }];

export function parseArgs(argv) {
  const options = { only: [], viewports: DEFAULT_VIEWPORTS, themes: ['chatgpt'], build: 'auto', out: '', list: false, audit: true };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} 需要参数`);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--only') options.only = value(index++, flag).split(',').map(item => item.trim()).filter(Boolean);
    else if (flag === '--widths' || flag === '--viewports') options.viewports = parseViewports(value(index++, flag));
    else if (flag === '--themes') options.themes = parseThemes(value(index++, flag));
    else if (flag === '--out') options.out = value(index++, flag);
    else if (flag === '--build') options.build = 'always';
    else if (flag === '--no-build') options.build = 'never';
    else if (flag === '--list') options.list = true;
    else if (flag === '--no-audit') options.audit = false;
    else throw new Error(`未知参数：${flag}`);
  }
  return options;
}

export function parseViewports(text) {
  const viewports = text.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const match = /^(\d{3,4})(?:x(\d{3,4}))?$/i.exec(item);
    if (!match) throw new Error(`无效视口：${item}（格式 1440x900 或 1440）`);
    const width = Number(match[1]);
    const height = match[2] ? Number(match[2]) : Math.round(width * 0.625);
    if (width < 640 || width > 3840 || height < 480 || height > 2160) throw new Error(`视口超出范围：${item}`);
    return { width, height };
  });
  if (!viewports.length) throw new Error('至少需要一个视口');
  return viewports;
}

export function parseThemes(text) {
  if (text === 'all') return [...THEMES];
  const themes = [...new Set(text.split(',').map(item => item.trim()).filter(Boolean))];
  for (const theme of themes) if (!THEMES.includes(theme)) throw new Error(`未知主题：${theme}（可选 ${THEMES.join(' / ')} / all）`);
  if (!themes.length) throw new Error('至少需要一个主题');
  return themes;
}

// `--only settings` selects `settings` and every capture named `settings-*`.
export const matchesOnly = (only, id) => !only.length || only.some(filter => id === filter || id.startsWith(`${filter}-`));

// Decide whether the fixture build reflects the current source tree.
export function freshness({ stamp, sourceSha, exeSha, exeMtimeMs, newestSourceMtimeMs }) {
  if (!exeSha) return { fresh: false, reason: '尚未构建测试程序' };
  if (stamp) {
    if (stamp.exe !== exeSha) return { fresh: false, reason: '测试程序在记录之后被其他构建替换' };
    if (stamp.source !== sourceSha) return { fresh: false, reason: '源码在上次构建之后有改动' };
    return { fresh: true, reason: '构建记录与当前源码指纹一致' };
  }
  if (Number.isFinite(exeMtimeMs) && Number.isFinite(newestSourceMtimeMs) && exeMtimeMs >= newestSourceMtimeMs) {
    return { fresh: true, reason: '无构建记录；测试程序比所有源码文件新（按修改时间判断）' };
  }
  return { fresh: false, reason: '无构建记录，且存在比测试程序更新的源码文件' };
}

export const SEVERITY = { high: 3, medium: 2, low: 1 };
export const FINDING_TYPES = {
  'page-overflow': { severity: 'high', label: '页面整体溢出窗口' },
  'text-overlap': { severity: 'high', label: '文字被非不透明元素覆盖（重叠/透字）' },
  'offscreen': { severity: 'high', label: '元素超出窗口边界' },
  'overflow': { severity: 'medium', label: '内容溢出容器（未裁切）' },
  'wrapped-control': { severity: 'medium', label: '短标签/控件文字折行' },
  'low-contrast': { severity: 'medium', label: '文字对比度不足' },
  'small-text': { severity: 'low', label: '字号小于 12px' },
  'small-target': { severity: 'low', label: '可点击区域小于 24×24' },
};

// Merge findings of one capture id across viewports/themes, keeping where each occurred.
export function mergeFindings(captures) {
  const merged = new Map();
  for (const capture of captures) {
    for (const finding of capture.findings || []) {
      const key = `${finding.type}\u0000${finding.selector}\u0000${finding.detail || ''}`;
      const existing = merged.get(key) || { ...finding, where: [], count: 0 };
      existing.where.push(capture.variant);
      existing.count += finding.count || 1;
      merged.set(key, existing);
    }
  }
  return [...merged.values()].sort((a, b) => (SEVERITY[FINDING_TYPES[b.type]?.severity] || 0) - (SEVERITY[FINDING_TYPES[a.type]?.severity] || 0) || b.count - a.count);
}

export function severityCounts(captures) {
  const counts = {};
  for (const capture of captures) for (const finding of capture.findings || []) counts[finding.type] = (counts[finding.type] || 0) + 1;
  return counts;
}

const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderReport(manifest) {
  const lines = [];
  const build = manifest.build || {};
  lines.push(`# Pi Desktop 界面截图巡检`, '');
  lines.push(`- 采集时间：${manifest.capturedAt}`);
  lines.push(`- 版本：${manifest.version}；提交 \`${(manifest.source?.commit || '').slice(0, 8)}\`${manifest.source?.dirty ? '（含未提交改动）' : ''}`);
  lines.push(`- 源码指纹：\`${manifest.source?.sha256 || '-'}\``);
  lines.push(`- 测试程序：\`${manifest.executable}\`，SHA-256 \`${build.exeSha || '-'}\``);
  lines.push(`- 构建判定：${build.fresh ? '✅ 最新' : '⚠️ 可能过期'}（${build.reason || '-'}${build.rebuilt ? '；本次已重新构建' : ''}）`);
  lines.push(`- 视口：${manifest.viewports.map(v => `${v.width}×${v.height}`).join('、')}；主题：${manifest.themes.join('、')}`);
  lines.push(`- 数据：隔离临时目录 + 确定性 Pi/ACP 夹具，不读写用户会话，不调用模型`, '');

  const all = manifest.captures.flatMap(group => group.shots);
  const counts = severityCounts(all);
  lines.push('## 自动检查汇总', '');
  if (!Object.keys(counts).length) lines.push('未发现自动可检测的问题。', '');
  else {
    lines.push('| 级别 | 类型 | 出现次数 |', '|---|---|---|');
    for (const [type, count] of Object.entries(counts).sort((a, b) => (SEVERITY[FINDING_TYPES[b[0]]?.severity] || 0) - (SEVERITY[FINDING_TYPES[a[0]]?.severity] || 0))) {
      const info = FINDING_TYPES[type] || { severity: 'low', label: type };
      lines.push(`| ${info.severity} | ${info.label} | ${count} |`);
    }
    lines.push('');
  }
  lines.push('> 自动检查只发现几何与样式层面的问题；视觉层级、信息架构等需结合截图人工判断。', '');

  if (manifest.failures?.length) {
    lines.push('## 未完成的场景', '');
    for (const failure of manifest.failures) lines.push(`- **${failure.id}**：${cell(failure.error)}${failure.screenshot ? `（[失败截图](${failure.screenshot})）` : ''}`);
    lines.push('');
  }

  lines.push('## 各界面', '');
  for (const group of manifest.captures) {
    lines.push(`### ${group.title}（\`${group.id}\`）`, '');
    lines.push(group.shots.map(shot => `[${shot.variant}](${shot.file})`).join(' · '), '');
    const findings = mergeFindings(group.shots);
    if (!findings.length) { lines.push('自动检查：无问题。', ''); continue; }
    lines.push('| 级别 | 类型 | 元素 | 说明 | 出现于 |', '|---|---|---|---|---|');
    for (const finding of findings.slice(0, 25)) {
      const info = FINDING_TYPES[finding.type] || { severity: 'low', label: finding.type };
      lines.push(`| ${info.severity} | ${info.label} | \`${cell(finding.selector)}\` | ${cell(finding.detail)} | ${cell([...new Set(finding.where)].join(', '))} |`);
    }
    if (findings.length > 25) lines.push('', `另有 ${findings.length - 25} 项，见 manifest.json。`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// Runs inside the WebView. Must stay self-contained (no outer references).
export function auditPage() {
  const vw = innerWidth, vh = innerHeight;
  const raw = [];
  const add = (type, el, detail) => raw.push({ type, selector: describe(el), detail });
  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && node !== document.body && depth < 3; depth++, node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) part += `#${node.id}`;
      const classes = [...node.classList].filter(name => !/^(active|selected|open|spin)$/.test(name)).slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      const aria = node.getAttribute('aria-label');
      if (aria && depth === 0) part += `[aria-label="${aria.slice(0, 24)}"]`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }
  const snippet = text => text.replace(/\s+/g, ' ').trim().slice(0, 32);
  const shown = el => el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0;
  function color(value) {
    if (!value || value === 'transparent') return null;
    let match = /^rgba?\(([^)]+)\)$/.exec(value);
    if (match) {
      const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(part => part.endsWith('%') ? parseFloat(part) / 100 : Number(part));
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    }
    match = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(value);
    if (match) return [match[1] * 255, match[2] * 255, match[3] * 255, match[4] === undefined ? 1 : Number(match[4])];
    return null;
  }
  const blend = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3]));
  const luminance = rgb => rgb.map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  const doc = document.documentElement;
  if (doc.scrollWidth > vw + 1) raw.push({ type: 'page-overflow', selector: 'html', detail: `横向多出 ${doc.scrollWidth - vw}px` });
  if (doc.scrollHeight > vh + 1) raw.push({ type: 'page-overflow', selector: 'html', detail: `纵向多出 ${doc.scrollHeight - vh}px` });

  const modals = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(shown);
  const scopes = modals.length ? modals : [document.body];
  const inScope = el => scopes.some(scope => scope.contains(el));

  const clipCache = new Map();
  function clipBox(el) {
    if (!el || el === document.documentElement) return { left: 0, top: 0, right: vw, bottom: vh };
    if (clipCache.has(el)) return clipCache.get(el);
    const style = getComputedStyle(el);
    let box;
    if (style.position === 'fixed') box = { left: 0, top: 0, right: vw, bottom: vh };
    else box = { ...clipBox(el.parentElement) };
    const parent = el.parentElement;
    if (parent && style.position !== 'fixed') {
      const ps = getComputedStyle(parent);
      if (ps.overflowX !== 'visible' || ps.overflowY !== 'visible') {
        const r = parent.getBoundingClientRect();
        box = { left: Math.max(box.left, r.left), top: Math.max(box.top, r.top), right: Math.min(box.right, r.right), bottom: Math.min(box.bottom, r.bottom) };
      }
    }
    clipCache.set(el, box);
    return box;
  }
  const intersect = (r, b) => ({ left: Math.max(r.left, b.left), top: Math.max(r.top, b.top), right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) });
  const area = r => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const opaqueCover = (hit, under) => {
    for (let node = hit; node && !node.contains(under); node = node.parentElement) {
      const s = getComputedStyle(node);
      const bg = color(s.backgroundColor);
      if ((bg && bg[3] >= 0.9) || s.backgroundImage !== 'none' || s.backdropFilter !== 'none') return true;
    }
    return false;
  };

  const seenSmall = new Set(), seenContrast = new Set();
  let textNodes = 0;
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode: node => node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    while (walker.nextNode() && textNodes < 3000) {
      const node = walker.currentNode, el = node.parentElement;
      if (!el || el.closest('script,style,noscript,option') || !shown(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const clip = clipBox(el);
      const rects = [...range.getClientRects()].map(r => intersect(r, clip)).filter(r => area(r) >= 6);
      if (!rects.length) continue;
      textNodes++;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const text = snippet(node.nodeValue);

      // Text drawn under a layer that does not hide it (bleed-through or text-on-text).
      for (const r of rects.slice(0, 2)) {
        const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
        if (!inScope(hit) && modals.length) continue;
        if (opaqueCover(hit, el)) continue;
        add('text-overlap', el, `「${text}」被 ${describe(hit)} 覆盖`);
        break;
      }
      if (size < 12) {
        const key = describe(el) + size;
        if (!seenSmall.has(key)) { seenSmall.add(key); add('small-text', el, `${size}px「${text}」`); }
      }
      // Short labels wrapping onto several lines usually mean a cramped control.
      if (node.nodeValue.trim().length <= 40 && el.closest('button,a,[role=tab],[role=menuitem],[role=option],label,summary,th,header,nav,[class*=badge],[class*=pill],[class*=chip],[class*=branch]')) {
        const tops = new Set([...range.getClientRects()].filter(r => r.width > 1).map(r => Math.round(r.top / 3)));
        if (tops.size > 1 && style.whiteSpace !== 'pre-wrap') add('wrapped-control', el, `「${text}」折成 ${tops.size} 行`);
      }
      if (!el.closest(':disabled,[aria-disabled="true"]')) {
        let uncertain = false;
        const layers = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.backgroundImage !== 'none') { uncertain = true; break; }
          const bg = color(s.backgroundColor);
          if (bg && bg[3] > 0) { layers.push(bg); if (bg[3] >= 1) break; }
        }
        const fg = color(style.color);
        if (!uncertain && fg && layers.length && layers[layers.length - 1][3] >= 1) {
          let bg = layers[layers.length - 1].slice(0, 3);
          for (let i = layers.length - 2; i >= 0; i--) bg = blend(layers[i], bg);
          const value = ratio(blend(fg, bg), bg);
          const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
          if (value < (large ? 3 : 4.5)) {
            const key = describe(el);
            if (!seenContrast.has(key)) { seenContrast.add(key); add('low-contrast', el, `${value.toFixed(2)}:1「${text}」`); }
          }
        }
      }
    }
  }

  let elements = 0;
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll('*')) {
      if (++elements > 6000) break;
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const clip = clipBox(el);
      if (area(intersect(r, clip)) < 1) continue;
      const interactive = el.matches('button,a[href],[role=button],[role=tab],select,input:not([type=hidden]),summary');
      if ((interactive || el.childElementCount === 0) && clip.right >= vw - 1 && (r.right > vw + 1 || r.left < -1)) add('offscreen', el, `位置 ${Math.round(r.left)}–${Math.round(r.right)}，窗口宽 ${vw}`);
      if (interactive && (r.width < 24 || r.height < 24) && !el.closest('p,li,.markdown')) add('small-target', el, `${Math.round(r.width)}×${Math.round(r.height)}`);
      const s = getComputedStyle(el);
      if (s.overflowX === 'visible' && s.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && clip.right > r.right + 2) add('overflow', el, `内容宽 ${el.scrollWidth}px，容器 ${el.clientWidth}px`);
    }
  }

  // Collapse duplicates within this capture.
  const grouped = new Map();
  for (const item of raw) {
    const key = `${item.type}\u0000${item.selector}\u0000${item.type === 'small-target' || item.type === 'small-text' ? '' : item.detail}`;
    const existing = grouped.get(key);
    if (existing) existing.count++;
    else grouped.set(key, { ...item, count: 1 });
  }
  const findings = [...grouped.values()];
  const perType = {};
  return {
    findings: findings.filter(item => (perType[item.type] = (perType[item.type] || 0) + 1) <= 40),
    stats: { textNodes, elements, modal: modals.length > 0, viewport: `${vw}x${vh}` },
  };
}
