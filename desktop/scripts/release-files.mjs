import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sha256File, validateManifest } from '../src/release-manifest.mjs';

export const RELEASE_FILES = ['Pi Desktop.exe', 'release.json', 'icon.ico'];

async function exists(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Validate local release bytes. This is integrity verification, not signature authentication. */
export async function readRelease(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('发布目录不能是链接或普通文件');
  for (const name of RELEASE_FILES) {
    const file = await exists(path.join(directory, name));
    if (!file && name === 'icon.ico') continue;
    if (!file?.isFile() || file.isSymbolicLink()) throw new Error(`发布文件缺失或不是普通文件：${name}`);
  }
  const manifest = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'));
  const verdict = validateManifest(manifest);
  if (!verdict.ok) throw new Error(`清单不合法：${verdict.reason}`);
  if (manifest.runtime !== 'tauri' || manifest.executable !== 'Pi Desktop.exe') throw new Error('仅支持 Pi Desktop Tauri 发布目录');
  const executable = path.join(directory, manifest.executable);
  if ((await lstat(executable)).size !== manifest.bytes || await sha256File(executable) !== manifest.sha256.toLowerCase()) {
    throw new Error('发布程序与清单的大小或 SHA-256 不一致');
  }
  return manifest;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Copy only release files, verify before switching, and retain the old directory for rollback. */
export async function deployRelease(sourceDirectory, targetDirectory, { move = rename } = {}) {
  const source = await realpath(sourceDirectory);
  // Reject a linked source before realpath erases that fact.
  await readRelease(path.resolve(sourceDirectory));
  const requested = path.resolve(targetDirectory);
  const parent = await realpath(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  if (contains(source, target) || contains(target, source)) throw new Error('来源与目标目录不能相同或互相包含');
  const lock = `${target}.deploy-lock`;
  await mkdir(lock); // Exclusive lock: concurrent deploys must not interleave directory swaps.
  let staged;
  let backup;
  let switched = false;
  try {
    if (await exists(target)) {
      await readRelease(target);
      const extra = (await readdir(target)).filter(name => !RELEASE_FILES.includes(name));
      if (extra.length) throw new Error('目标含非发布文件，拒绝替换整个目录');
    }
    staged = await mkdtemp(path.join(parent, `.${path.basename(target)}-stage-`));
    for (const name of RELEASE_FILES) {
      if (await exists(path.join(source, name))) await copyFile(path.join(source, name), path.join(staged, name));
    }
    const manifest = await readRelease(staged);
    if (await exists(target)) {
      backup = `${target}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      await move(target, backup);
    }
    try {
      await move(staged, target);
      switched = true;
    } catch (error) {
      if (backup) {
        try { await move(backup, target); } catch (restoreError) {
          throw new AggregateError([error, restoreError], `切换和自动恢复失败；旧版仍在 ${backup}`);
        }
      }
      throw error;
    }
    return { target, backup: backup ?? null, version: manifest.version, sha256: manifest.sha256, source: manifest.source ?? null };
  } finally {
    // Only remove the scratch directory created above, never target or backup.
    if (staged && !switched && path.dirname(staged) === parent && path.basename(staged).startsWith(`.${path.basename(target)}-stage-`)) {
      await rm(staged, { recursive: true, force: true });
    }
    await rmdir(lock);
  }
}
