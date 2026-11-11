import path from 'node:path';
import { deployRelease } from './release-files.mjs';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--to', '--from'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('用法：npm run deploy -- --to <发布目标目录> [--from <发布或备份目录>]');
  }
  options[args[index]] = args[index + 1];
}
if (!options['--to']) throw new Error('必须显式指定 --to，目标父目录必须已存在');
const source = options['--from'] || path.resolve(import.meta.dirname, '../release/tauri');
console.log(JSON.stringify(await deployRelease(source, options['--to']), null, 2));
