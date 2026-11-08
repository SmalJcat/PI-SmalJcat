export const permissionModes = [
  { id:'ask', name:'请求批准', short:'请求批准', detail:'工作区读取直接允许，其余操作确认' },
  { id:'smart', name:'帮我批准', short:'帮我批准', detail:'工作区常规读写自动批准' },
  { id:'full-access', name:'完全访问权限', short:'完全访问', detail:'跳过桌面工具确认' },
  { id:'custom', name:'自定义', short:'自定义', detail:'按工具规则允许、拒绝或确认' },
];
export const defaultPermissionRules = () => ({allowTools:[],denyTools:[],allowWorkspaceEdits:false,allowExternalReads:false});
const count = value => Number.isSafeInteger(value) && value>=0 ? value : null;
export function contextMeasurement(raw, fallbackWindow) {
  const used = count(raw?.used ?? raw?.tokens), size = count(raw?.size ?? raw?.contextWindow) || count(fallbackWindow);
  const known = used!==null && size!==null && size>0;
  return { used, size, known, percent:known ? used/size*100 : null, remaining:known ? Math.max(0,size-used) : null };
}
export function compactTokens(value) {
  if (count(value)===null) return '—';
  if (value>=1e6) return `${Number((value/1e6).toFixed(1))}m`;
  if (value>=1e3) return `${Number((value/1e3).toFixed(1))}k`;
  return String(value);
}
