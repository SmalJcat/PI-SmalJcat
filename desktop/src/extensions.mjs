// 扩展清单与签名的规范化规则：Rust 侧实现必须与这里逐字节一致。
// 载荷格式（LF 换行，字段顺序固定，缺省字段写空值）：
//   pi-extension-v1
//   id=<id>
//   name=<name>
//   version=<version>
//   entry=<entry>
//   permissions=<按字节序排序并去重，逗号分隔>
//   pi=<pi 版本要求>
//   sha256=<entry 文件字节的 SHA-256 小写十六进制>
export const PAYLOAD_HEADER = 'pi-extension-v1';

export const PERMISSIONS = {
  read: { label: '读取会话', risk: 'low' },
  tools: { label: '调用工具', risk: 'low' },
  'fs:workspace': { label: '工作区文件读写', risk: 'medium' },
  'fs:any': { label: '任意路径文件读写', risk: 'high' },
  exec: { label: '执行外部命令', risk: 'high' },
  network: { label: '网络访问', risk: 'medium' },
  secrets: { label: '读取凭据', risk: 'high' },
};

export const VERDICTS = {
  verified: { label: '已签名并受信任', tone: 'ok' },
  'untrusted-key': { label: '签名有效但密钥不受信任', tone: 'warn' },
  invalid: { label: '签名无效', tone: 'error' },
  unsigned: { label: '未签名', tone: 'warn' },
  broken: { label: '清单无效', tone: 'error' },
};

export const isPermission = value => Object.prototype.hasOwnProperty.call(PERMISSIONS, value);

export const permissionInfo = value => PERMISSIONS[value] || { label: value, risk: 'unknown' };

export const riskLevel = permission => permissionInfo(permission).risk;

// 高风险权限优先展示，风险并列时保持清单原顺序。
const RISK_ORDER = { high: 0, medium: 1, low: 2, unknown: 3 };

export const sortPermissions = permissions => [...permissions].sort((a, b) => {
  const delta = RISK_ORDER[riskLevel(a)] - RISK_ORDER[riskLevel(b)];
  return delta !== 0 ? delta : String(a).localeCompare(String(b), 'en');
});

export const highestRisk = permissions => {
  const risks = permissions.map(riskLevel);
  return risks.includes('high') ? 'high' : risks.includes('medium') ? 'medium' : risks.includes('unknown') ? 'unknown' : 'low';
};

export const normalizePermissions = permissions => [...new Set((permissions || []).map(value => String(value).trim()).filter(Boolean))].sort();

export function payloadFor(manifest, entrySha256) {
  const permissions = normalizePermissions(manifest.permissions).join(',');
  const value = field => (manifest[field] === undefined || manifest[field] === null ? '' : String(manifest[field]));
  return [
    PAYLOAD_HEADER,
    'id=' + value('id'),
    'name=' + value('name'),
    'version=' + value('version'),
    'entry=' + value('entry'),
    'permissions=' + permissions,
    'pi=' + value('pi'),
    'sha256=' + String(entrySha256 || '').toLowerCase(),
    '',
  ].join('\n');
}

export const verdictInfo = verdict => VERDICTS[verdict] || { label: '未知状态', tone: 'idle' };

export const isTrusted = verdict => verdict === 'verified';

// 列表展示：默认受信任优先，然后按 id 排序，保证顺序稳定。
export const sortExtensions = list => [...(list || [])].sort((a, b) => {
  const rank = verdict => (verdict === 'verified' ? 0 : verdict === 'broken' ? 2 : 1);
  const delta = rank(a?.verdict) - rank(b?.verdict);
  return delta !== 0 ? delta : String(a?.id || '').localeCompare(String(b?.id || ''), 'en');
});

export const summaryOf = list => {
  const items = list || [];
  return {
    total: items.length,
    verified: items.filter(item => item?.verdict === 'verified').length,
    needsAttention: items.filter(item => item?.verdict !== 'verified').length,
    highRisk: items.filter(item => highestRisk(item?.permissions || []) === 'high').length,
  };
};

export const matchesQuery = (item, query) => {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return [item?.id, item?.name, item?.version, item?.verdict].filter(Boolean).some(value => String(value).toLowerCase().includes(needle));
};

export const signatureLabel = summary => {
  if (!summary) return '未签名';
  const keyId = String(summary.keyId || '').trim();
  const algorithm = String(summary.algorithm || 'ed25519').trim();
  return keyId ? `${algorithm} · ${keyId}` : algorithm;
};
