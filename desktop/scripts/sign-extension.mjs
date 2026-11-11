#!/usr/bin/env node
// 扩展签名工具（P1.1）：生成密钥、签名扩展、维护本地信任库、校验。
// 与 Rust 侧共用 src/extensions.mjs 的载荷规则，保证跨语言逐字节一致。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signWith, verify as verifyWith } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { payloadFor, sortPermissions } from '../src/extensions.mjs';

const usage = () => {
  console.log(`用法：
  node scripts/sign-extension.mjs keygen --out <密钥文件> [--key-id <名称>]
  node scripts/sign-extension.mjs sign   --dir <扩展目录> --key <密钥文件>
  node scripts/sign-extension.mjs trust  --root <extensions 根目录> --key <密钥文件>
  node scripts/sign-extension.mjs verify --dir <扩展目录> [--root <extensions 根目录>]`);
};

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const has = name => args.includes(`--${name}`);

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const entrySha256 = dir => {
  const manifest = readJson(join(dir, 'manifest.json'));
  const entry = join(dir, manifest.entry || 'index.mjs');
  return createHash('sha256').update(readFileSync(entry)).digest('hex');
};
const loadKeys = path => {
  const keys = readJson(path);
  return {
    keyId: keys.keyId || 'local-dev',
    privateKey: createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
    publicKey: Buffer.from(keys.publicKey, 'base64'),
  };
};

switch (command) {
  case 'keygen': {
    const out = flag('out');
    if (!out) throw new Error('缺少 --out');
    const keyId = flag('key-id', 'local-dev');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify({
      keyId,
      note: '私钥文件不要提交到仓库',
      publicKey: spki.subarray(spki.length - 32).toString('base64'),
      privateKey: der.toString('base64'),
    }, null, 2) + '\n');
    console.log(`已生成密钥 ${out}（keyId=${keyId}）`);
    break;
  }
  case 'sign': {
    const dir = resolve(flag('dir') || '.');
    const keyFile = flag('key');
    if (!keyFile) throw new Error('缺少 --key');
    const keys = loadKeys(keyFile);
    const manifest = readJson(join(dir, 'manifest.json'));
    const payload = Buffer.from(payloadFor(manifest, entrySha256(dir)), 'utf8');
    const signature = signWith(null, payload, keys.privateKey).toString('base64');
    writeFileSync(join(dir, 'signature.json'), JSON.stringify({ algorithm: 'ed25519', keyId: keys.keyId, signature }, null, 2) + '\n');
    console.log(`已签名 ${dir}（keyId=${keys.keyId}，权限 ${sortPermissions(manifest.permissions || []).join(',') || '无'}）`);
    break;
  }
  case 'trust': {
    const root = resolve(flag('root') || '.');
    const keyFile = flag('key');
    if (!keyFile) throw new Error('缺少 --key');
    const keys = loadKeys(keyFile);
    const file = join(root, 'trusted-keys.json');
    const store = existsSync(file) ? readJson(file) : {};
    store[keys.keyId] = keys.publicKey.toString('base64');
    mkdirSync(root, { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(store).sort()), null, 2) + '\n');
    console.log(`已信任 ${keys.keyId}（${file}）`);
    break;
  }
  case 'verify': {
    const dir = resolve(flag('dir') || '.');
    const root = flag('root') ? resolve(flag('root')) : dirname(dir);
    const manifest = readJson(join(dir, 'manifest.json'));
    const signatureFile = join(dir, 'signature.json');
    if (!existsSync(signatureFile)) { console.log('unsigned'); break; }
    const signature = readJson(signatureFile);
    const storeFile = join(root, 'trusted-keys.json');
    const store = existsSync(storeFile) ? readJson(storeFile) : {};
    const publicKeyBase64 = store[signature.keyId];
    if (!publicKeyBase64) { console.log('untrusted-key'); break; }
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyBase64, 'base64')]), format: 'der', type: 'spki' });
    const payload = Buffer.from(payloadFor(manifest, entrySha256(dir)), 'utf8');
    const ok = verifyWith(null, payload, publicKey, Buffer.from(signature.signature, 'base64'));
    console.log(ok ? 'verified' : 'invalid');
    break;
  }
  default:
    usage();
    if (command && !has('help')) process.exitCode = 1;
}
