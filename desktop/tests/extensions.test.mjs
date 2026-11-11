import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  highestRisk,
  isPermission,
  isTrusted,
  matchesQuery,
  normalizePermissions,
  payloadFor,
  permissionInfo,
  sortExtensions,
  sortPermissions,
  summaryOf,
  verdictInfo,
} from '../src/extensions.mjs';

const manifest = {
  id: 'com.example.demo',
  name: '示例扩展',
  version: '1.2.3',
  entry: 'index.mjs',
  permissions: ['network', 'tools'],
  pi: '>=1.5.0',
};

test('payload matches the documented format byte for byte', () => {
  const digest = createHash('sha256').update("export default () => 'fixture';").digest('hex');
  const payload = payloadFor(manifest, digest);
  assert.equal(
    payload,
    [
      'pi-extension-v1',
      'id=com.example.demo',
      'name=示例扩展',
      'version=1.2.3',
      'entry=index.mjs',
      'permissions=network,tools',
      'pi=>=1.5.0',
      'sha256=' + digest,
      '',
    ].join('\n'),
  );
  assert.ok(payload.endsWith('\n'), 'payload must end with LF');
  assert.equal(payload.split('\n').length, 9);
});

test('payload sorts permissions so argument order cannot change the signature', () => {
  const forward = payloadFor({ ...manifest, permissions: ['tools', 'network'] }, 'a'.repeat(64));
  const reverse = payloadFor({ ...manifest, permissions: ['network', 'tools'] }, 'a'.repeat(64));
  assert.equal(forward, reverse);
  const deduped = payloadFor({ ...manifest, permissions: ['tools', 'network', 'tools'] }, 'a'.repeat(64));
  assert.equal(deduped, forward);
  assert.ok(forward.includes('permissions=network,tools\n'));
});

test('payload normalizes missing optional fields to empty rather than undefined', () => {
  const payload = payloadFor({ id: 'com.example.demo', name: 'x', version: '1.0.0', entry: 'index.mjs' }, 'AB'.repeat(32));
  assert.ok(payload.includes('\npermissions=\n'));
  assert.ok(payload.includes('\npi=\n'));
  assert.ok(payload.includes('sha256=' + 'ab'.repeat(32)), 'digest must be lowercased');
  assert.ok(!payload.includes('undefined'));
});

test('permission metadata covers the known vocabulary and fails closed for the rest', () => {
  for (const permission of ['read', 'tools', 'fs:workspace', 'fs:any', 'exec', 'network', 'secrets']) {
    assert.equal(isPermission(permission), true, permission);
    assert.ok(permissionInfo(permission).label, permission);
  }
  assert.equal(isPermission('root'), false);
  assert.equal(permissionInfo('root').risk, 'unknown');
  assert.equal(highestRisk(['read', 'secrets']), 'high');
  assert.equal(highestRisk(['read', 'network']), 'medium');
  assert.equal(highestRisk(['read', 'tools']), 'low');
  assert.equal(highestRisk(['root']), 'unknown');
  assert.equal(highestRisk([]), 'low');
});

test('permissions display high risk first and stay stable within a risk level', () => {
  const sorted = sortPermissions(['read', 'secrets', 'tools', 'fs:any', 'network']);
  assert.deepEqual(sorted.slice(0, 2).sort(), ['fs:any', 'secrets']);
  assert.deepEqual(sorted.slice(3), ['read', 'tools']);
  assert.deepEqual(normalizePermissions([' tools ', 'tools', '', 'exec']), ['exec', 'tools']);
});

test('verdicts map to user facing tones and trusted is only verified', () => {
  for (const verdict of ['verified', 'untrusted-key', 'invalid', 'unsigned', 'broken']) {
    assert.ok(verdictInfo(verdict).label, verdict);
    assert.ok(['ok', 'warn', 'error'].includes(verdictInfo(verdict).tone), verdict);
  }
  assert.equal(isTrusted('verified'), true);
  for (const verdict of ['unsigned', 'invalid', 'untrusted-key', 'broken', undefined]) {
    assert.equal(isTrusted(verdict), false, String(verdict));
  }
  assert.equal(verdictInfo('nonsense').tone, 'idle');
});

test('list helpers sort untrusted first and summarise risk', () => {
  const list = [
    { id: 'b', verdict: 'unsigned', permissions: ['read'] },
    { id: 'a', verdict: 'verified', permissions: ['exec'] },
    { id: 'c', verdict: 'broken', permissions: [] },
  ];
  assert.deepEqual(sortExtensions(list).map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(summaryOf(list), { total: 3, verified: 1, needsAttention: 2, highRisk: 1 });
  assert.deepEqual(summaryOf([]), { total: 0, verified: 0, needsAttention: 0, highRisk: 0 });
  assert.equal(matchesQuery(list[0], 'UNSIGNED'), true);
  assert.equal(matchesQuery(list[0], 'com.example'), false);
  assert.equal(matchesQuery(list[0], ''), true);
});

test('signing tool and verification share one payload implementation', () => {
  // scripts/sign-extension.mjs 必须从 src/extensions.mjs 导入 payloadFor，避免两套规则。
  const script = readFileSync(new URL('../scripts/sign-extension.mjs', import.meta.url), 'utf8');
  assert.match(script, /from '\.\.\/src\/extensions\.mjs'/);
  assert.match(script, /payloadFor\(/);
  assert.match(script, /createPrivateKey|generateKeyPairSync/);
});
