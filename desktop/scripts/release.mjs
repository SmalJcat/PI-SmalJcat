#!/usr/bin/env node
// 发布工具：生成/签名/校验 release/tauri/release.json（应用更新流程读取的就是它）。
// 用法：
//   node scripts/release.mjs keygen                生成签名密钥与信任库（已存在则不覆盖）
//   node scripts/release.mjs sign [--notes 说明]    校验暂存产物的 sha256，然后签名清单
//   node scripts/release.mjs verify                用信任库校验清单与暂存产物
//   node scripts/release.mjs show                  打印当前清单
import { createPrivateKey, generateKeyPairSync, randomBytes, sign as signWith } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYLOAD_HEADER,
  SIGNATURE_ALGORITHM,
  buildManifest,
  canonicalPayload,
  sha256File,
  signatureOf,
  validateManifest,
  verifyWithTrustStore,
} from '../src/release-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, 'release', 'tauri');
const manifestPath = join(stage, 'release.json');
const keysPath = join(root, 'release', 'keys.json');
const trustPath = join(root, 'release', 'trusted-keys.json');

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const args = process.argv.slice(2);
const command = args[0] || 'show';
const flag = name => {
  const index = args.indexOf('--' + name);
  return index >= 0 ? args[index + 1] : undefined;
};

function keygen() {
  if (existsSync(keysPath)) {
    console.log('密钥已存在，未覆盖：' + keysPath);
    return 0;
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = 'release-' + randomBytes(4).toString('hex');
  writeJson(keysPath, {
    keyId,
    algorithm: SIGNATURE_ALGORITHM,
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    // 存 32 字节原始公钥：与扩展信任库一致，Rust 侧直接按原始字节解析
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  });
  writeJson(trustPath, { keys: [readJson(keysPath)].map(({ keyId: id, algorithm, publicKey: value }) => ({ keyId: id, algorithm, publicKey: value })) });
  console.log('已生成签名密钥：' + keysPath);
  console.log('信任库（随应用分发）：' + trustPath);
  console.log('密钥 ID：' + keyId);
  return 0;
}

async function sign() {
  if (!existsSync(manifestPath)) {
    console.error('找不到清单，请先运行 npm run package：' + manifestPath);
    return 1;
  }
  if (!existsSync(keysPath)) {
    console.error('找不到签名密钥，请先运行：node scripts/release.mjs keygen');
    return 1;
  }
  const manifest = readJson(manifestPath);
  const verdict = validateManifest(manifest);
  if (!verdict.ok) {
    console.error('清单不合法：' + verdict.reason);
    return 1;
  }
  const executable = join(stage, manifest.executable);
  const actual = await sha256File(executable);
  if (actual !== manifest.sha256.toLowerCase()) {
    console.error('暂存产物与清单不一致，拒绝签名：清单 ' + manifest.sha256 + '，实际 ' + actual);
    return 1;
  }
  const keys = readJson(keysPath);
  const payload = Buffer.from(canonicalPayload(manifest), 'utf8');
  const signature = signWith(null, payload, createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64'), format: 'der', type: 'pkcs8' }));
  const signed = buildManifest({
    ...manifest,
    notes: flag('notes') || manifest.notes,
    signature: { algorithm: SIGNATURE_ALGORITHM, keyId: keys.keyId, signature: signature.toString('base64') },
  });
  writeJson(manifestPath, signed);
  console.log('已签名：' + manifestPath);
  console.log('版本 ' + signed.version + ' · ' + signed.bytes + ' 字节 · ' + signed.sha256.slice(0, 16) + '…');
  console.log('载荷头 ' + PAYLOAD_HEADER + ' · 算法 ' + SIGNATURE_ALGORITHM + ' · 密钥 ' + keys.keyId);
  return 0;
}

async function verify() {
  const manifest = readJson(manifestPath);
  const verdict = validateManifest(manifest);
  if (!verdict.ok) {
    console.error('清单不合法：' + verdict.reason);
    return 1;
  }
  const executable = join(stage, manifest.executable);
  if (existsSync(executable)) {
    const actual = await sha256File(executable);
    if (actual !== manifest.sha256.toLowerCase()) {
      console.error('产物摘要与清单不一致：' + actual);
      return 1;
    }
    console.log('产物摘要一致：' + actual.slice(0, 16) + '…');
  } else {
    console.log('暂存产物不在本机，跳过摘要核对：' + executable);
  }
  if (!signatureOf(manifest)) {
    console.log('清单未签名（仅覆盖完整性，不含来源认证）');
    return 0;
  }
  if (!existsSync(trustPath)) {
    console.error('清单已签名但找不到信任库：' + trustPath);
    return 1;
  }
  const result = await verifyWithTrustStore(manifest, readJson(trustPath));
  if (!result.ok) {
    console.error('签名校验失败：' + result.reason);
    return 1;
  }
  console.log('签名校验通过：' + signatureOf(manifest).keyId);
  return 0;
}

function show() {
  if (!existsSync(manifestPath)) {
    console.error('找不到清单：' + manifestPath);
    return 1;
  }
  console.log(readFileSync(manifestPath, 'utf8').trim());
  return 0;
}

const handlers = { keygen, sign, verify, show };
const handler = handlers[command];
if (!handler) {
  console.error('未知命令：' + command + '（可用：keygen / sign / verify / show）');
  process.exit(2);
}
process.exit(await handler());
