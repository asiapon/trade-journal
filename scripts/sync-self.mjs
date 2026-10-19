/* 同步构建产物到自托管服务器（②）
   用法：SELF_HOST=user@host npm run deploy:self
   目标路径默认 /opt/stockjournal/dist（服务器上 server.js 的 ROOT 指向处） */
import { execSync } from 'node:child_process';

const SELF = process.env.SELF_HOST || '';
const DEST = process.env.SELF_PATH || '/opt/stockjournal/dist';
if (!SELF) {
  console.error('用法：SELF_HOST=user@host npm run deploy:self');
  console.error('（或在服务器上 git pull + npm run build，server.js 直接读 dist）');
  process.exit(1);
}
const cmd = `scp -r dist/* ${SELF}:${DEST}/`;
console.log('> ' + cmd);
execSync(cmd, { stdio: 'inherit' });
console.log('✓ 已同步。如需重启：ssh ' + SELF + ' "systemctl restart stockjournal"');
