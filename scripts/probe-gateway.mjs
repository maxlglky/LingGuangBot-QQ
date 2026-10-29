import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { GroupWatcher } from '../src/gateway.js';
import { QQClient } from '../src/qq.js';
import { createLogger } from '../src/util.js';

const root = resolve(import.meta.dirname, '..');
const cfg = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const logger = createLogger('debug');
const qq = new QQClient(cfg, logger);

let events = 0;
const watcher = new GroupWatcher({
  cfg,
  logger,
  getToken: () => qq.token(),
  onReady: () => logger.info('READY 收到'),
  onAdd: (openid, meta) => {
    events += 1;
    logger.info(`事件登记群: ${openid} (${meta.source})`);
  },
  onRemove: (openid) => logger.info(`事件移除群: ${openid}`),
});

watcher.start();
setTimeout(() => {
  watcher.stop();
  logger.info(`探测结束，收到 ${events} 个群事件`);
  process.exit(0);
}, 12000);
