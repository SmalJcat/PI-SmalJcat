import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign as signWith } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYLOAD_HEADER,
  SIGNATURE_ALGORITHM,
  buildManifest,
  canonicalPayload,
  validateManifest,
  verifySignature,
  verifyWithTrustStore,
} from '../src/release-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(root, 'src-tauri', 'tests', 'fixtures');
const manifestFixture = join(fixtureDir, 'release-signed.json');
const trustFixture = join(fixtureDir, 'release-trusted-keys.json');

// 固定种子派生测试密钥：Ed25519 签名是确定性的，因此夹具可重复生成。
// PKCS8 里 Ed25519 私钥的前缀是固定的 16 字节，后面接 32 字节种子。
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const seed = createHash('sha256').update('pi-release-fixture').digest();
const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
// 32 字节原始公钥（SPKI 尾部），与 Rust 侧 VerifyingKey::from_bytes 对齐
const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const spkiOf = key => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.export({ format: 'der', type: 'spki' }).subarray(-32)]);
const TEST_KEY_ID = 'release-fixture';

const baseManifest = () => ({
  version: '9.9.9',
  runtime: 'tauri',
  executable: 'Pi Desktop.exe',
  bytes: 4242,
  sha256: createHash('sha256').update('fixture-bytes').digest('hex'),
  stagedAt: '2026-01-01T00:00:00.000Z',
});

const signManifest = manifest => {
  const payload = Buffer.from(canonicalPayload(manifest), 'utf8');
  const signature = signWith(null, payload, privateKey).toString('base64');
  return buildManifest({ ...manifest, signature: { algorithm: SIGNATURE_ALGORITHM, keyId: TEST_KEY_ID, signature } });
};

test('规范载荷：字段顺序固定、以换行结尾、sha256 统一小写', () => {
  const manifest = { ...baseManifest(), sha256: baseManifest().sha256.toUpperCase() };
  const payload = canonicalPayload(manifest);
  const lines = payload.split('\n');
  assert.equal(lines[0], PAYLOAD_HEADER);
  assert.deepEqual(lines.slice(1, 6).map(line => line.split('=')[0]), ['version', 'runtime', 'executable', 'bytes', 'sha256']);
  assert.equal(lines[6], '', '必须以换行结尾');
  assert.equal(payload, payload.replace(manifest.sha256, manifest.sha256.toLowerCase()), '摘要应统一小写');
  // 空字段也要占位，避免两端拼接方式不同导致载荷不一致
  assert.match(canonicalPayload({}), /^pi-release-v1\nversion=\nruntime=\nexecutable=\nbytes=\nsha256=\n$/);
});

test('清单校验：缺字段、字节数非正、摘要格式错误都会被拒绝', () => {
  assert.equal(validateManifest(baseManifest()).ok, true);
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest({ ...baseManifest(), version: ' ' }).ok, false);
  assert.equal(validateManifest({ ...baseManifest(), runtime: '' }).ok, false);
  assert.equal(validateManifest({ ...baseManifest(), executable: '' }).ok, false);
  assert.equal(validateManifest({ ...baseManifest(), bytes: 0 }).ok, false);
  assert.equal(validateManifest({ ...baseManifest(), bytes: '42' }).ok, false);
  assert.equal(validateManifest({ ...baseManifest(), sha256: 'abc' }).ok, false);
  const traversal = validateManifest({ ...baseManifest(), executable: '../evil.exe' });
  assert.equal(traversal.ok, false, '可执行文件名不允许带路径');
  assert.throws(() => buildManifest({ ...baseManifest(), bytes: -1 }), /清单不合法/);
});

test('签名与校验：往返成功、篡改被拒、未知密钥被拒', async () => {
  const signed = signManifest(baseManifest());
  assert.equal(signed.signature.algorithm, SIGNATURE_ALGORITHM);
  assert.equal(signed.signature.keyId, TEST_KEY_ID);
  const ok = await verifySignature(signed, publicKeyBase64);
  assert.equal(ok.ok, true, ok.reason);

  // 展示字段变化不影响签名（设计如此）
  const withNotes = buildManifest({ ...signed, notes: '补充说明', stagedAt: '2026-02-02T00:00:00.000Z', source: { commit: 'diagnostic-only', authenticated: false } });
  assert.equal(withNotes.source.commit, 'diagnostic-only', '签名工具保留来源诊断字段');
  assert.equal((await verifySignature(withNotes, publicKeyBase64)).ok, true, '展示字段不应破坏签名');

  // 身份字段被改动必须失败
  for (const key of ['version', 'runtime', 'executable', 'bytes', 'sha256']) {
    const tampered = { ...signed, [key]: key === 'bytes' ? 4243 : String(signed[key]) + 'x' };
    const verdict = await verifySignature(tampered, publicKeyBase64);
    assert.equal(verdict.ok, false, '篡改 ' + key + ' 应当被拒');
  }

  const noSignature = baseManifest();
  assert.equal((await verifySignature(noSignature, publicKeyBase64)).ok, false);
  assert.match((await verifySignature(noSignature, publicKeyBase64)).reason, /未签名/);

  const wrongAlgorithm = { ...signed, signature: { ...signed.signature, algorithm: 'rsa' } };
  assert.match((await verifySignature(wrongAlgorithm, publicKeyBase64)).reason, /算法/);

  const otherKey = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, createHash('sha256').update('other').digest()]), format: 'der', type: 'pkcs8' }));
  assert.equal((await verifySignature(signed, spkiOf(otherKey).subarray(-32).toString('base64'))).ok, false, '别的密钥不应通过');
  // 公钥长度不对要明确失败，而不是抛异常
  const wrongLength = await verifySignature(signed, Buffer.alloc(44).toString('base64'));
  assert.equal(wrongLength.ok, false);
  assert.match(wrongLength.reason, /32 字节/);

  // 信任库路径
  const trust = { keys: [{ keyId: TEST_KEY_ID, algorithm: SIGNATURE_ALGORITHM, publicKey: publicKeyBase64 }] };
  assert.equal((await verifyWithTrustStore(signed, trust)).ok, true);
  assert.match((await verifyWithTrustStore(signed, { keys: [] })).reason, /不在信任库/);
  assert.equal((await verifyWithTrustStore(baseManifest(), trust)).ok, false);
});

test('生成跨语言夹具：Rust 侧据此验证两端载荷逐字节一致', () => {
  mkdirSync(fixtureDir, { recursive: true });
  const signed = signManifest(baseManifest());
  // 确定性：同一个密钥与同一份清单必须得到相同的签名
  assert.equal(JSON.stringify(signManifest(baseManifest())), JSON.stringify(signed), '夹具必须可重复生成');
  writeFileSync(manifestFixture, JSON.stringify(signed, null, 2) + '\n');
  writeFileSync(trustFixture, JSON.stringify({ keys: [{ keyId: TEST_KEY_ID, algorithm: SIGNATURE_ALGORITHM, publicKey: publicKeyBase64 }] }, null, 2) + '\n');
  const written = JSON.parse(readFileSync(manifestFixture, 'utf8'));
  assert.equal(written.signature.signature, signed.signature.signature);
  assert.equal(canonicalPayload(written), canonicalPayload(signed));
});
