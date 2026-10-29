import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 从 Clash 订阅生成一份「只监听本机」的独立代理配置。
 *
 * 用法：
 *   node scripts/prepare-local-proxy.mjs <订阅/配置文件路径> [httpPort] [controllerPort]
 *
 * 例：
 *   node scripts/prepare-local-proxy.mjs ~/.config/clash/profiles/xxx.yml 17899 17898
 *
 * 生成到 .proxy/config.yaml，只改端口与局域网开关，不动订阅内容。
 */
const root = resolve(import.meta.dirname, '..');
const profile = process.argv[2] || process.env.CLASH_PROFILE;
const dir = join(root, '.proxy');
const httpPort = Number(process.argv[3] || process.env.PROXY_PORT || 17899);
const controllerPort = Number(process.argv[4] || process.env.PROXY_CONTROLLER_PORT || 17898);

if (!profile) {
  console.error('用法: node scripts/prepare-local-proxy.mjs <clash配置文件> [httpPort] [controllerPort]');
  console.error('也可以设置环境变量 CLASH_PROFILE / PROXY_PORT / PROXY_CONTROLLER_PORT');
  process.exit(1);
}

if (!existsSync(profile)) {
  console.error(`找不到订阅文件: ${profile}`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });

let yaml = readFileSync(profile, 'utf8');
yaml = yaml
  .replace(/^mixed-port:\s*\d+/m, `mixed-port: ${httpPort}`)
  .replace(/^port:\s*\d+/m, `port: ${httpPort + 1}`)
  .replace(/^socks-port:\s*\d+/m, `socks-port: ${httpPort + 2}`)
  .replace(/^allow-lan:\s*\w+/m, 'allow-lan: false')
  .replace(/^external-controller:.*$/m, `external-controller: '127.0.0.1:${controllerPort}'`);

writeFileSync(join(dir, 'config.yaml'), yaml, 'utf8');

// Country.mmdb 与订阅同目录时一起带过来（GeoIP 规则需要）
const mmdb = join(profile, '..', 'Country.mmdb');
if (existsSync(mmdb)) copyFileSync(mmdb, join(dir, 'Country.mmdb'));

console.log(`已生成 ${join(dir, 'config.yaml')} (mixed-port=${httpPort}, controller=${controllerPort})`);
console.log('把 config.json 的 net.proxy 指向 http://127.0.0.1:' + httpPort + ' 即可。');
