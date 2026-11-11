// 展示用的格式化助手（纯函数，前后端无关）。
// 放在单独模块里，避免像 formatBytes 这样的小工具在多个面板里各写一份。
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 || unit === 0 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
  return text + ' ' + units[unit];
}
