import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
export async function sourceIdentity(root) {
  const git = async args => (await exec('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const dirty = Boolean((await git(['status', '--porcelain', '--untracked-files=all'])).trim());
  const names = [...new Set((await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'])).split('\0'))]
    .filter(name => name && !/^(docs\/|tests\/|README\.md$|VERIFICATION\.md$)/.test(name)).sort();
  const hash = createHash('sha256');
  let files = 0;
  for (const name of names) {
    const filename = path.join(root, name);
    let stat;
    try { stat = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`构建来源包含非普通文件：${name}`);
    const digest = createHash('sha256').update(await readFile(filename)).digest('hex');
    hash.update(`${name}\0${digest}\n`);
    files++;
  }
  return { commit, dirty, sha256: hash.digest('hex'), files, scope: 'desktop git-visible files excluding docs, JS tests, README and VERIFICATION', authenticated: false };
}
