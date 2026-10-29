/** 群指令解析：去掉 @ 占位与零宽字符后做关键词匹配。 */

export const DEFAULT_COMMANDS = {
  enable: ['订阅', '订阅推文', '开推', '开启推送', '/订阅', '/rss on', 'rss on', 'x2qq on', '/x2qq on'],
  disable: ['退订', '取消订阅', '关推', '关闭推送', '/退订', '/rss off', 'rss off', 'x2qq off', '/x2qq off'],
  latest: ['最新', '最新推文', '看看推文', '推文', '拉取', 'latest', '/最新'],
  pullCount: 3,
  reply: true,
};

export function normalizeCommand(text) {
  return String(text || '')
    .replace(/<@!?[^>]*>/g, ' ')
    // 只去掉开头的 @提及（QQ 可能把它和后面的文字粘在一起，如「@凌光姬/订阅」）
    .replace(/^(\s*@[^\s/@]+)+/, ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function matchKeyword(text, keywords = []) {
  const norm = normalizeCommand(text);
  if (!norm) return false;
  return keywords.some((word) => {
    const key = String(word).toLowerCase().trim();
    if (!key) return false;
    if (norm === key) return true;
    // 允许「订阅 @账号」「/rss on 这个群」这类带参数的写法
    return norm.startsWith(`${key} `);
  });
}

/** 取出指令后面的参数（已归一化）；没有参数返回空串，不是该指令返回 null。 */
export function extractCommandArg(text, keywords = []) {
  const norm = normalizeCommand(text);
  if (!norm) return null;
  for (const word of keywords) {
    const key = String(word).toLowerCase().trim();
    if (!key) continue;
    if (norm === key) return '';
    if (norm.startsWith(`${key} `)) return norm.slice(key.length).trim();
  }
  return null;
}

/** 用 key / handle / 显示名匹配账号。 */
export function resolveAccount(accounts = [], arg) {
  const q = String(arg || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
  if (!q) return null;
  const key = (a) => String(a.key || '').toLowerCase();
  const handle = (a) => String(a.handle || '').toLowerCase();
  const name = (a) => String(a.displayName || '').toLowerCase();
  return (
    accounts.find((a) => key(a) === q) ||
    accounts.find((a) => handle(a) === q) ||
    accounts.find((a) => name(a) === q) ||
    accounts.find((a) => name(a).includes(q)) ||
    null
  );
}
