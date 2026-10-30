import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_COMMANDS,
  extractCommandArg,
  matchKeyword,
  normalizeCommand,
  resolveAccount,
} from '../src/commands.js';
import { dedupeKey, toTweet } from '../src/tweet.js';
import { formatTweet } from '../src/format.js';
import { request } from '../src/http.js';
import { Poller } from '../src/poller.js';
import { GroupRateLimiter, QQClient } from '../src/qq.js';
import { Store } from '../src/store.js';

const SAMPLE_ITEMS = [
  {
    id: 'x:1111111111',
    title: '今天的拍摄结束啦！',
    text: '今天的拍摄结束啦！',
    link: 'https://x.com/yunachan_akb48/status/1111111111',
    published: '2026-10-26T10:00:00.000Z',
    images: ['https://pbs.twimg.com/media/a.jpg'],
    author: '秋山由奈',
  },
  {
    id: 'x:2222222222',
    title: 'RT by @fan: 好想去现场',
    text: 'RT @fan: 好想去现场',
    link: 'https://x.com/other/status/2222222222',
    published: '2026-10-26T09:00:00.000Z',
    images: [],
    author: '秋山由奈',
  },
  {
    id: 'x:3333333333',
    title: '回复 @someone',
    text: 'Replying to @someone: 谢谢！',
    link: 'https://x.com/yunachan_akb48/status/3333333333',
    published: '2026-10-26T08:00:00.000Z',
    images: [],
    author: '秋山由奈',
  },
];

function baseConfig(overrides = {}) {
  return {
    logLevel: 'error',
    qq: {
      appId: 'app',
      appSecret: 'secret',
      apiBase: 'http://127.0.0.1:1',
      tokenBase: 'http://127.0.0.1:1',
      ...(overrides.qq || {}),
    },
    x: {
      handle: 'yunachan_akb48',
      displayName: '秋山由奈',
      provider: 'file',
      file: overrides.file,
      includeReplies: false,
      includeRetweets: false,
      maxAgeHours: 0,
      ...(overrides.x || {}),
    },
    forward: {
      intervalSec: 300,
      includeLink: true,
      maxChars: 1200,
      maxPerRun: 5,
      maxPushAgeHours: 0, // 测试用固定日期，关闭陈旧推文过滤
      sendImages: false,
      maxImages: 1,
      perMinute: 15,
      perDay: 200,
      timeZone: 'Asia/Shanghai',
      ...(overrides.forward || {}),
    },
    net: { proxy: '' },
    commands: DEFAULT_COMMANDS,
    localRss: { enabled: false, maxItems: 50 },
  };
}

function captureLogger() {
  const lines = [];
  return {
    lines,
    debug: () => {},
    info: (...args) => lines.push(args.join(' ')),
    warn: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
  };
}

async function startMockQq(onCall) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/app/getAppAccessToken') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'token-1', expires_in: 7200 }));
        return;
      }
      onCall?.(req.url, body ? JSON.parse(body) : null);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.endsWith('/files')) {
        res.end(JSON.stringify({ file_info: 'FILE_INFO_1' }));
      } else {
        res.end(JSON.stringify({ id: 'msg-1', timestamp: Date.now() }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('toTweet 过滤规则：转推与回复可识别', () => {
  const items = SAMPLE_ITEMS.map((item) => toTweet(item, { displayName: '秋山由奈' }));
  assert.equal(items[0].isRetweet, false);
  assert.equal(items[1].isRetweet, true);
  assert.equal(items[2].isReply, true);
});

test('dedupeKey 用推文数字 id 去重', () => {
  assert.equal(dedupeKey({ link: 'https://x.com/a/status/12345', id: 'x' }), 'x:12345');
});

test('formatTweet 含账号名、正文和链接', () => {
  const cfg = baseConfig();
  cfg.x.displayName = '秋山由奈';
  const text = formatTweet(
    {
      text: '今天的拍摄结束啦！',
      link: 'https://x.com/yunachan_akb48/status/1111111111',
      published: new Date('2026-10-26T10:00:00Z'),
      isReply: false,
      isRetweet: false,
    },
    cfg,
  );
  assert.match(text, /^秋山由奈$/m);
  assert.match(text, /今天的拍摄结束啦/);
  assert.match(text, /查看原帖 ↗ https:\/\/x\.com\/yunachan_akb48\/status\/1111111111/);
  assert.match(text, /10-26 18:00$/m);

  const legacy = formatTweet(
    {
      text: '今天的拍摄结束啦！',
      link: 'https://x.com/yunachan_akb48/status/1111111111',
      published: new Date('2026-10-26T10:00:00Z'),
      isReply: false,
      isRetweet: false,
    },
    { ...cfg, forward: { ...cfg.forward, compact: false } },
  );
  assert.match(legacy, /【秋山由奈】新推文/);
  assert.match(legacy, /🕒 2026-10-26 18:00/);
});

test('GroupRateLimiter 每日上限会抛错', () => {
  const limiter = new GroupRateLimiter({ perMinute: 100, perDay: 1 });
  assert.equal(limiter.acquire('g1'), 0);
  assert.throws(() => limiter.acquire('g1'), /上限/);
});

test('端到端：拉取 → 推送 → 去重', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'x2qq-'));
  const rssFile = join(dir, 'feed.xml');
  await writeFile(rssFile, JSON.stringify(SAMPLE_ITEMS), 'utf8');

  const sent = [];
  const { server, port } = await startMockQq((url, body) => sent.push({ url, body }));

  try {
    const cfg = baseConfig({
      file: rssFile,
      qq: { apiBase: `http://127.0.0.1:${port}`, tokenBase: `http://127.0.0.1:${port}` },
    });
    const store = new Store(join(dir, 'state.json'));
    await store.load();
    store.addGroup('GROUP_A', { source: 'test', enabled: true });

    const qq = new QQClient(cfg, captureLogger());
    const poller = new Poller({ cfg, qq, store, logger: captureLogger(), request });

    const first = await poller.tick();
    assert.equal(first.sent, 1, '只应推送 1 条原创推文（转推/回复被过滤）');
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/v2\/groups\/GROUP_A\/messages$/);
    assert.equal(sent[0].body.msg_type, 0);
    assert.match(sent[0].body.content, /今天的拍摄结束啦/);

    const second = await poller.tick();
    assert.equal(second.sent, 0, '第二条 tick 不应重复推送');
    assert.equal(sent.length, 1);
  } finally {
    server.close();
  }
});

test('seed 模式只标记已读，不发送', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'x2qq-'));
  const rssFile = join(dir, 'feed.xml');
  await writeFile(rssFile, JSON.stringify(SAMPLE_ITEMS), 'utf8');

  let calls = 0;
  const { server, port } = await startMockQq(() => {
    calls += 1;
  });

  try {
    const cfg = baseConfig({
      file: rssFile,
      qq: { apiBase: `http://127.0.0.1:${port}`, tokenBase: `http://127.0.0.1:${port}` },
    });
    const store = new Store(join(dir, 'state.json'));
    await store.load();
    store.addGroup('GROUP_A', { source: 'test', enabled: true });

    const qq = new QQClient(cfg, captureLogger());
    const poller = new Poller({ cfg, qq, store, logger: captureLogger(), request });

    const result = await poller.tick({ seed: true });
    assert.equal(result.sent, 0);
    assert.ok(result.seeded >= 1);
    assert.equal(calls, 0, 'seed 模式不应调用发送接口');
  } finally {
    server.close();
  }
});

test('发送图片：先上传 file_info 再发 msg_type=7', async () => {
  const calls = [];
  const { server, port } = await startMockQq((url, body) => calls.push({ url, body }));

  try {
    const cfg = baseConfig({
      qq: { apiBase: `http://127.0.0.1:${port}`, tokenBase: `http://127.0.0.1:${port}` },
    });
    const qq = new QQClient(cfg, captureLogger());
    const result = await qq.deliver('GROUP_B', 'hello', ['https://pbs.twimg.com/media/x.jpg'], {
      sendImages: true,
      maxImages: 1,
    });

    assert.equal(result.text, true);
    assert.equal(result.images, 1);
    assert.equal(calls.length, 3, '应有：文本、上传、富媒体三条请求');
    assert.match(calls[0].url, /messages$/);
    assert.equal(calls[0].body.msg_type, 0);
    assert.match(calls[1].url, /\/files$/);
    assert.equal(calls[1].body.file_type, 1);
    assert.equal(calls[2].body.msg_type, 7);
    assert.equal(calls[2].body.media.file_info, 'FILE_INFO_1');
  } finally {
    server.close();
  }
});

test('群指令匹配：@占位符、空格、大小写都能识别', () => {
  assert.equal(normalizeCommand('<@!BOT123> 订阅'), '订阅');
  assert.equal(matchKeyword('<@!BOT123> 订阅', DEFAULT_COMMANDS.enable), true);
  assert.equal(matchKeyword('  订阅  ', DEFAULT_COMMANDS.enable), true);
  assert.equal(matchKeyword('RSS ON', DEFAULT_COMMANDS.enable), true);
  assert.equal(matchKeyword('订阅 @yunachan_akb48', DEFAULT_COMMANDS.enable), true);
  assert.equal(matchKeyword('退订', DEFAULT_COMMANDS.disable), true);
  assert.equal(matchKeyword('今天天气怎么样', DEFAULT_COMMANDS.enable), false);
  assert.equal(matchKeyword('你好', DEFAULT_COMMANDS.disable), false);
});

test('只推送给已开启推送的群', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'x2qq-'));
  const rssFile = join(dir, 'feed.json');
  await writeFile(
    rssFile,
    JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      items: [
        {
          id: 'h1',
          url: 'https://x.com/yunachan_akb48/status/1234567890',
          title: '新推文一条',
          date_published: '2026-10-27T01:03:00.000Z',
        },
      ],
    }),
    'utf8',
  );

  const sent = [];
  const { server, port } = await startMockQq((url) => sent.push(url));

  try {
    const cfg = baseConfig({
      file: rssFile,
      qq: { apiBase: `http://127.0.0.1:${port}`, tokenBase: `http://127.0.0.1:${port}` },
    });
    const store = new Store(join(dir, 'state.json'));
    await store.load();
    store.addGroup('GROUP_OFF', { enabled: false });
    store.addGroup('GROUP_ON', { enabled: true });

    const qq = new QQClient(cfg, captureLogger());
    const poller = new Poller({ cfg, qq, store, logger: captureLogger(), request });
    const result = await poller.tick();

    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /GROUP_ON/);
    assert.ok(!sent.some((u) => u.includes('GROUP_OFF')), '未开启的群不应收到推送');
  } finally {
    server.close();
  }
});

test('指令参数解析与账号匹配', () => {
  const accounts = [
    { key: 'yuna', handle: 'yunachan_akb48', displayName: '秋山由奈' },
    { key: 'ami', handle: '_maeshima_ami', displayName: '前島亜美' },
  ];
  assert.equal(extractCommandArg('/订阅 yuna', DEFAULT_COMMANDS.enable), 'yuna');
  assert.equal(extractCommandArg('订阅', DEFAULT_COMMANDS.enable), '');
  assert.equal(extractCommandArg('你好', DEFAULT_COMMANDS.enable), null);
  assert.equal(resolveAccount(accounts, 'yuna')?.key, 'yuna');
  assert.equal(resolveAccount(accounts, '@Yunachan_AKB48')?.key, 'yuna');
  assert.equal(resolveAccount(accounts, '前島')?.key, 'ami');
  assert.equal(resolveAccount(accounts, '不存在'), null);
});

test('群只收到自己订阅的账号', () => {
  const store = new Store('unused.json');
  store.groups = [
    { openid: 'A', enabled: true, accounts: ['yuna'] },
    { openid: 'B', enabled: true, accounts: ['ami'] },
    { openid: 'C', enabled: false, accounts: ['yuna'] },
  ];
  const poller = new Poller({
    cfg: baseConfig(),
    qq: null,
    store,
    logger: captureLogger(),
    request,
  });
  assert.deepEqual(
    poller.groupsFor({ key: 'yuna' }).map((g) => g.openid),
    ['A'],
  );
  assert.deepEqual(
    poller.groupsFor({ key: 'ami' }).map((g) => g.openid),
    ['B'],
  );
});

test('素材缓存带有效期：过期后重新上传，不再引用已失效的链接', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { etag: '"etag"' });
      res.end('');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  let uploaded = 0;
  const stubApi = async (method, path) => {
    if (path === '/v2/media-images') return { total: 1, images: [] };
    if (path.endsWith('/prepare')) {
      return { presigned_url: `http://127.0.0.1:${port}/put`, upload_id: 'u1' };
    }
    if (path.endsWith('/complete')) {
      uploaded += 1;
      return { url: `qqbot-media://image/v1/test${uploaded}` };
    }
    return {};
  };

  const qq = new QQClient({ ...baseConfig(), forward: { mediaCacheHours: 6 } }, captureLogger());
  qq.mediaCacheFile = null;
  qq.api = stubApi;

  const buf = Buffer.from('same-image-bytes');
  const md5 = createHash('md5').update(buf).digest('hex');
  const first = await qq.uploadMarkdownImage(buf, {});
  const again = await qq.uploadMarkdownImage(buf, {});
  assert.equal(again.url, first.url, '有效期内应命中缓存');
  assert.equal(uploaded, 1);

  // 缓存过期（等价于素材被 QQ 淘汰）：必须重新上传，而不是继续用旧链接
  qq.mediaCache.get(md5).at = Date.now() - 7 * 3600_000;
  const third = await qq.uploadMarkdownImage(buf, {});
  assert.notEqual(third.url, first.url, '过期后必须重新上传');
  assert.equal(uploaded, 2);

  // mediaCacheHours: 0 表示完全不复用缓存
  qq.mediaCacheTtlMs = 0;
  await qq.uploadMarkdownImage(buf, {});
  assert.equal(uploaded, 3);

  // 老格式（纯字符串、没有时间戳）的缓存一律当作已过期
  const dir = await mkdtemp(join(tmpdir(), 'lgq-media-'));
  const mediaFile = join(dir, 'state.media.json');
  await writeFile(mediaFile, JSON.stringify({ [md5]: 'qqbot-media://image/v1/legacy' }), 'utf8');
  const legacy = new QQClient({ ...baseConfig(), forward: { mediaCacheHours: 6 } }, captureLogger());
  legacy.mediaCacheFile = mediaFile;
  legacy.api = stubApi;
  const before = uploaded;
  const after = await legacy.uploadMarkdownImage(buf, {});
  assert.notEqual(after.url, 'qqbot-media://image/v1/legacy', '老格式缓存必须重传');
  assert.equal(uploaded, before + 1);

  await new Promise((r) => server.close(r));
});
