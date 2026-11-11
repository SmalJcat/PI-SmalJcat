// 发布清单的规范形式与签名（纯函数，便于测试与跨语言对齐）。
// 规范载荷只覆盖"身份字段"：version / runtime / executable / bytes / sha256。
// stagedAt、notes、url 属于展示信息，改动它们不应让签名失效。
import { createHash } from 'node:crypto';

export const PAYLOAD_HEADER = 'pi-release-v1';
export const SIGNATURE_ALGORITHM = 'ed25519';

/** 流式计算文件摘要（大文件不占内存）。 */
export async function sha256File(path) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

/** 规范载荷：字段顺序固定、以换行结尾，两端必须逐字节一致。 */
export function canonicalPayload(manifest) {
  const lines = [
    PAYLOAD_HEADER,
    'version=' + String(manifest.version ?? ''),
    'runtime=' + String(manifest.runtime ?? ''),
    'executable=' + String(manifest.executable ?? ''),
    'bytes=' + String(manifest.bytes ?? ''),
    'sha256=' + String(manifest.sha256 ?? '').toLowerCase(),
    '',
  ];
  return lines.join('\n');
}

const isSha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value.toLowerCase());

/** 校验清单本身是否自洽（不涉及文件与签名）。 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: '清单不是对象' };
  if (!String(manifest.version || '').trim()) return { ok: false, reason: '缺少 version' };
  if (!String(manifest.runtime || '').trim()) return { ok: false, reason: '缺少 runtime' };
  if (!String(manifest.executable || '').trim()) return { ok: false, reason: '缺少 executable' };
  if (!Number.isInteger(manifest.bytes) || manifest.bytes <= 0) return { ok: false, reason: 'bytes 必须是正整数' };
  if (!isSha256(manifest.sha256)) return { ok: false, reason: 'sha256 必须是 64 位十六进制' };
  const name = String(manifest.executable);
  if (name.includes('/') || name.includes('\\')) return { ok: false, reason: 'executable 只能是文件名' };
  return { ok: true, reason: '' };
}

/** 组装清单：把文件真实长度与摘要写进去，而不是信任调用方给的数字。 */
export function buildManifest({ version, runtime = 'tauri', executable, bytes, sha256, stagedAt, notes, url, signature, source }) {
  const manifest = { version, runtime, executable, bytes, sha256: String(sha256).toLowerCase() };
  if (stagedAt) manifest.stagedAt = stagedAt;
  if (notes) manifest.notes = notes;
  if (url) manifest.url = url;
  if (signature) manifest.signature = signature;
  // Diagnostic provenance is preserved, but is NOT covered by pi-release-v1.
  if (source) manifest.source = source;
  const verdict = validateManifest(manifest);
  if (!verdict.ok) throw new Error('清单不合法：' + verdict.reason);
  return manifest;
}

/** 读取清单里的签名块。 */
export const signatureOf = manifest => (manifest && typeof manifest === 'object' ? manifest.signature || null : null);

// Ed25519 公钥的 SPKI 前缀（12 字节）。信任库里存的是 32 字节原始公钥，
// 与扩展签名（trusted-keys.json）保持一致，Rust 侧 VerifyingKey::from_bytes 直接吃原始字节。
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 用给定公钥验证签名（公钥为 base64 的 32 字节原始 Ed25519 公钥）。 */
export async function verifySignature(manifest, publicKeyBase64) {
  const signature = signatureOf(manifest);
  if (!signature) return { ok: false, reason: '清单未签名' };
  if (signature.algorithm !== SIGNATURE_ALGORITHM) return { ok: false, reason: '不支持的签名算法：' + signature.algorithm };
  const { createPublicKey, verify } = await import('node:crypto');
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== 32) return { ok: false, reason: '公钥应为 32 字节 Ed25519 公钥，实际 ' + raw.length + ' 字节' };
  let key;
  try {
    key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return { ok: false, reason: '公钥不可解析' };
  }
  const payload = Buffer.from(canonicalPayload(manifest), 'utf8');
  const ok = verify(null, payload, key, Buffer.from(signature.signature, 'base64'));
  return { ok, reason: ok ? '' : '签名与清单不匹配' };
}

/** 从信任库中挑出签名所用的公钥并验证。 */
export async function verifyWithTrustStore(manifest, trustStore) {
  const signature = signatureOf(manifest);
  if (!signature) return { ok: false, reason: '清单未签名' };
  const keys = Array.isArray(trustStore?.keys) ? trustStore.keys : [];
  const entry = keys.find(item => item?.keyId === signature.keyId);
  if (!entry) return { ok: false, reason: '签名密钥不在信任库：' + signature.keyId };
  return verifySignature(manifest, entry.publicKey);
}
