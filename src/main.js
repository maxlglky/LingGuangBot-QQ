#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArkCard, formatTweet, formatTweetMarkdown } from './format.js';
import {
  DEFAULT_COMMANDS,
  extractCommandArg,
  matchKeyword,
  normalizeCommand,
  parseTweetId,
  resolveAccount,
} from './commands.js';
import { fetchTweetDetail, fetchTweetMedia, resolveRepost } from './fx.js';
import { GroupWatcher } from './gateway.js';
import { request } from './http.js';
import { Poller } from './poller.js';
import { QQClient } from './qq.js';
import { Store } from './store.js';
import { createLogger, readJson, truncate } from './util.js';
import { XCookieClient, extractTimelineItems } from './xgraphql.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.LINGGUANGBOT_QQ_CONFIG || process.env.X2QQ_CONFIG || join(ROOT, 'config.json');

const DEFAULTS = {
  logLevel: 'info',
  watchGroups: true,
  stateFile: 'state.json',
  qq: {
    appId: '',
    appSecret: '',
    apiBase: 'https://api.sgroup.qq.com',
    tokenBase: 'https://bots.qq.com',
  },
  x: {
    handle: '',
    displayName: '',
    provider: 'xcookie',
    file: '',
    includeReplies: false,
    includeRetweets: false,
    maxAgeHours: 24,
  },
  forward: {
    intervalSec: 300,
    intervalJitterSec: 60,
    accountStaggerSec: 3,
    includeLink: true,
    compact: true,
    maxChars: 1200,
    maxMarkdownChars: 4000,
    style: 'media',
    arkTemplate: 24,
    maxPerRun: 5,
    sendImages: true,
    maxImages: 6,
    // imageMode: inline = 图内嵌进卡片（走素材库，100 张上限）
    //            message = 图单独发（不占配额，图不会失效）
    //            auto = 素材库还宽裕就内嵌，快满了自动降级成单独发（默认）
    imageMode: 'auto',
    mediaInlineUntil: 80,
    headerCacheHours: 12,
    avatarCacheHours: 168,
    mediaCacheHours: 6,
    mediaPruneAt: 88,
    mediaKeep: 70,
    mediaPruneKeepNewest: 4,
    perMinute: 15,
    perDay: 200,
    timeZone: 'Asia/Shanghai',
  },
  net: { proxy: '' },
  commands: DEFAULT_COMMANDS,
};

function mergeConfig(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object') {
      out[key] = mergeConfig(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

async function loadConfig() {
  const raw = await readJson(CONFIG_PATH, null);
  if (!raw) throw new Error(`找不到配置文件: ${CONFIG_PATH}（可从 config.example.json 复制）`);
  const cfg = mergeConfig(DEFAULTS, raw);
  if (!cfg.qq.appId || !cfg.qq.appSecret) {
    throw new Error('config.qq.appId / config.qq.appSecret 未填写');
  }
  if (process.env.LINGGUANGBOT_QQ_PROXY || process.env.X2QQ_PROXY) cfg.net.proxy = process.env.LINGGUANGBOT_QQ_PROXY || process.env.X2QQ_PROXY;
  cfg.assetsDir = resolve(ROOT, 'assets');
  if (cfg.forward.verifiedBadge !== false && !cfg.forward.verifiedBadgePath) {
    cfg.forward.verifiedBadgePath = join(cfg.assetsDir, 'verified.png');
  }
  cfg.statePath = resolve(ROOT, cfg.stateFile);
  return cfg;
}

async function buildContext() {
  const cfg = await loadConfig();
  // 按天分文件，避免单个 run.log 被外部程序占用时整份日志写不进去
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const logger = createLogger(cfg.logLevel, {
    file: join(ROOT, 'logs', `run-${day}.log`),
  });
  const store = new Store(cfg.statePath);
  await store.load();

  // 账号表：没配 accounts 时用 x 作为唯一账号
  if (!Array.isArray(cfg.accounts) || !cfg.accounts.length) {
    cfg.accounts = [{ key: 'default', ...cfg.x }];
  }
  // 老数据迁移：已开启但没有账号订阅的群，默认订阅第一个账号
  for (const g of store.listGroups()) {
    if (!Array.isArray(g.accounts)) {
      g.accounts = g.enabled !== false ? [cfg.accounts[0].key] : [];
    }
  }
  await store.save();

  const qq = new QQClient(cfg, logger);
  const poller = new Poller({ cfg, qq, store, logger, request });
  return { cfg, logger, store, qq, poller };
}

function printGroups(store, logger) {
  const groups = store.listGroups();
  if (!groups.length) {
    logger.warn('暂无已登记的群。在群里 @ 机器人并发送「订阅」即可开启推送。');
    return;
  }
  logger.info(`已登记 ${groups.length} 个群：`);
  for (const g of groups) {
    const flag = g.enabled ? '推送:开' : '推送:关';
    const subs = Array.isArray(g.accounts) && g.accounts.length ? g.accounts.join(',') : '（无订阅）';
    console.log(`  - ${g.openid}  ${flag}  订阅=${subs}  source=${g.source}`);
  }
}

async function cmdDoctor() {
  const { cfg, logger, store, qq, poller } = await buildContext();
  let ok = true;

  process.stdout.write('\n[1/4] 检查 QQ 凭据 ... ');
  try {
    const token = await qq.token(true);
    console.log(`OK (token ${truncate(token, 8)}…, 有效期约 1 小时)`);
  } catch (err) {
    ok = false;
    console.log(`失败: ${err.message}`);
  }

  process.stdout.write('[2/4] 检查推文源 ... ');
  try {
    const collected = await poller.collectTweets();
    console.log(`OK，拿到 ${collected.length} 条候选推文`);
    for (const { tweet } of collected.slice(-3)) {
      console.log(`      · ${truncate(tweet.text || '(无正文)', 70)}`);
      console.log(`        ${tweet.link}`);
    }
  } catch (err) {
    ok = false;
    console.log(`失败: ${err.message}`);
    console.log('      检查 config.json：');
    console.log('        1) net.xCookie 是否填了浏览器里的 auth_token（建议连同 ct0）');
    console.log('        2) accounts[].userId 是否是数字 ID（可用 xprobe 自动查）');
    console.log('        3) net.proxy 是否能出网访问 x.com（默认 127.0.0.1:17899）');
  }

  process.stdout.write('[3/4] 检查群名单 ... ');
  const groups = store.listGroups();
  console.log(groups.length ? `OK，${groups.length} 个群` : '为空（需要先 @ 一次机器人）');
  if (groups.length) printGroups(store, logger);


  console.log('');
  if (ok) logger.info('基础检查通过。下一步：node src/main.js run 常驻，然后在群里 @ 机器人发送「订阅」');
  else logger.error('检查未通过，请按上面的错误修复配置');
  return ok ? 0 : 1;
}

/** 「最新」指令：用被动回复把最近几条推文发出来（主动消息没权限时的兜底）。 */
/**
 * 「最新」指令：只发一条推文，且必须是 Markdown 卡片（走被动回复通道）。
 * - /最新        取本会话已订阅账号里最新的一条
 * - /最新 <账号>  取指定账号最新的一条（不要求已订阅）
 */
async function replyLatest({ cfg, qq, poller, store, logger, openid, msgId, accountKey = '' }) {
  if (!msgId) return;

  try {
    let account = null;
    if (accountKey) {
      account = resolveAccount(cfg.accounts, accountKey);
      if (!account) {
        const keys = (cfg.accounts || []).map((a) => a.key).join(' / ');
        await qq.sendGroupReply(openid, `找不到账号「${accountKey}」。可用：${keys}`, msgId, 1);
        return;
      }
    }

    // 没有指定账号时，只在本会话已订阅的账号里找
    const keys = account ? [account.key] : store.subscribedAccounts(openid);
    const candidates = (cfg.accounts || []).filter((a) => keys.includes(a.key));
    if (!candidates.length) {
      await qq.sendGroupReply(
        openid,
        '本会话还没有订阅任何账号。先发 /订阅 <账号>，或者用 /最新 <账号> 指定一个。',
        msgId,
        1,
      );
      return;
    }

    let latestPick = null;
    for (const acc of candidates) {
      const collected = await poller.collectTweets(acc).catch(() => []);
      for (const item of collected) {
        const t = item.tweet.published?.getTime() || 0;
        if (!latestPick || t > latestPick.time) latestPick = { account: acc, tweet: item.tweet, time: t };
      }
    }

    if (!latestPick) {
      await qq.sendGroupReply(openid, '暂时没抓到推文，稍后再试。', msgId, 1);
      return;
    }

    const r = await poller.sendTweetToGroup(latestPick.account, latestPick.tweet, openid, {
      replyTo: { msgId, seq: 1 },
    });
    if (r?.errors?.length) logger.warn(`/最新 部分失败: ${r.errors.join('; ')}`);
    logger.info(`会话 ${openid} 拉取最新推文：${latestPick.account.key} ${latestPick.tweet.link}`);
  } catch (err) {
    logger.warn(`拉取最新推文失败: ${err.message}`);
    try {
      await qq.sendGroupReply(openid, `拉取失败：${err.message}`, msgId, 1);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 「/转推 <推文id>」：把指定 id 的推文立刻发到本会话。
 * 不受订阅状态限制，也不需要这条推文是「新的」。
 */
async function replyTweet({ cfg, qq, poller, logger, openid, msgId, arg }) {
  if (!msgId) return;

  const id = parseTweetId(arg);
  if (!id) {
    await qq
      .sendGroupReply(
        openid,
        '用法：/转推 <推文id>\n例：/转推 2115790539924918461\n推文 id 就是链接里 status/ 后面那串数字。',
        msgId,
        1,
      )
      .catch(() => {});
    return;
  }

  try {
    const detail = await fetchTweetDetail(id);
    if (!detail) {
      await qq
        .sendGroupReply(openid, `没取到 id=${id} 的推文，可能已删除，或者 id 抄错了。`, msgId, 1)
        .catch(() => {});
      return;
    }

    const accounts = cfg.accounts || [];
    if (!accounts.length) {
      await qq.sendGroupReply(openid, 'config.json 里还没有配置任何账号。', msgId, 1).catch(() => {});
      return;
    }

    const authorHandle = String(detail.screenName || '').toLowerCase();
    const reposter = detail.repostedBy?.screenName || '';
    // 转推时以「谁转的」为准：卡片抬头、头像、样式都跟着转发的人
    const handle = (reposter || authorHandle).toLowerCase();
    const known = accounts.find((a) => String(a.handle || '').toLowerCase() === handle);
    // 账号没配过时，借用第一个账号的样式，但名字/头像用推文自己那一位
    const account =
      known ||
      {
        ...accounts[0],
        key: handle || accounts[0].key,
        displayName: (reposter ? detail.repostedBy.name : detail.author) || accounts[0].displayName,
        avatarUrl:
          (reposter ? detail.repostedBy.avatarUrl : detail.authorAvatar) || accounts[0].avatarUrl,
      };

    // 属于已配账号的推文：用账号自己的源拿原始对象，转推 / 回复的语义才完整
    let tweet = null;
    if (known) {
      const collected = await poller.collectTweets(known).catch(() => []);
      tweet =
        collected.find(
          ({ tweet: t }) => String(t.link || '').includes(id) || String(t.id || '').endsWith(id),
        )?.tweet || null;
    }
    if (!tweet) {
      tweet = {
        id: detail.id,
        text: detail.text,
        link: detail.url,
        // 转推时不知道「转帖时间」，留空就不会显示「转帖于 …」
        published: !reposter && detail.createdAt ? new Date(detail.createdAt) : undefined,
        images: (detail.photos || []).map((p) => p.url),
        isReply: Boolean(detail.replyToStatusId),
        isRetweet: Boolean(reposter),
        title: reposter ? `RT by @${reposter}` : '',
        replyTo: detail.replyTo || '',
        replyToStatusId: detail.replyToStatusId || '',
      };
    }

    const r = await poller.sendTweetToGroup(account, tweet, openid, {
      replyTo: { msgId, seq: 1 },
    });
    if (r?.errors?.length) logger.warn(`/转推 部分失败: ${r.errors.join('; ')}`);
    logger.info(`会话 ${openid} 手动转推 ${id}（${account.key}）`);
  } catch (err) {
    logger.warn(`手动转推失败: ${err.message}`);
    try {
      await qq.sendGroupReply(openid, `转推失败：${err.message}`, msgId, 1);
    } catch {
      /* ignore */
    }
  }
}

/** 建群事件监听：入群只登记，@ 机器人发指令才开启推送。 */
function createWatcher({ cfg, logger, store, qq, poller }) {
  const commands = cfg.commands || {};
  const enableWords = commands.enable || [];
  const disableWords = commands.disable || [];
  const latestWords = commands.latest || [];
  const retweetWords = commands.retweet || [];

  return new GroupWatcher({
    cfg,
    logger,
    getToken: () => qq.token(),
    onAdd: async (openid, meta) => {
      const added = store.addGroup(openid, { ...meta, enabled: false });
      await store.save();
      logger.info(added ? `机器人入群，已登记（未开启推送）: ${openid}` : `群已在名单: ${openid}`);
    },
    onRemove: async (openid) => {
      if (store.removeGroup(openid)) {
        await store.save();
        logger.info(`群已移除: ${openid}`);
      }
    },
    onMessage: async (openid, msg) => {
      const norm = normalizeCommand(msg.content);

      // 「/回复 aimi 关」「/转贴 aimi 关」：按账号控制是否转发回复 / 转贴
      const kindMatch = norm.match(
        /^\/?(回复|转贴|转帖)(?:\s+([^\s]+))?(?:\s*(开|开启|启用|on|关|关闭|停用|off))?$/,
      );
      if (kindMatch) {
        logger.info(`收到指令 [${openid.slice(0, 8)}] ${JSON.stringify(msg.content)}`);
        const kind = kindMatch[1] === '回复' ? 'replies' : 'retweets';
        const kindName = kind === 'replies' ? '回复' : '转贴';
        const argAccount = kindMatch[2] || '';
        const argSwitch = kindMatch[3] || '';
        const target = argAccount ? resolveAccount(cfg.accounts, argAccount) : null;

        let replyText;
        if (target && argSwitch) {
          const wantOn = ['开', '开启', '启用', 'on'].includes(argSwitch);
          store.setItemFlag(openid, target.key, kind, wantOn);
          await store.save();
          replyText = wantOn
            ? `✅ 已开启 ${target.key}（${target.displayName}）的「${kindName}」转发`
            : `🔕 已关闭 ${target.key}（${target.displayName}）的「${kindName}」转发`;
          logger.info(`会话 ${openid} ${target.key} ${kindName} -> ${wantOn ? '开' : '关'}`);
        } else {
          const lines = ['ℹ️ 当前「' + kindName + '」转发状态：'];
          for (const acc of cfg.accounts) {
            const f = store.getItemFlags(openid, acc.key);
            lines.push(`  ${f[kind] ? '✅' : '🔕'} ${acc.key} · ${acc.displayName}`);
          }
          lines.push(`
用法：/ ${kindMatch[1]} <账号> 开|关`.replace('/ ', '/'));
          replyText = lines.join('\n');
        }

        if (commands.reply !== false && msg.msgId) {
          qq.sendGroupReply(openid, replyText, msg.msgId).catch((err) =>
            logger.warn(`指令回复失败: ${err.message}`),
          );
        }
        return;
      }

      // 「/翻译 开」「/翻译 关」是群级开关，先单独处理
      const trMatch = norm.match(/^\/?翻译(?:\s+(开|开启|启用|on|关|关闭|停用|off))?$/);
      if (trMatch) {
        logger.info(`收到指令 [${openid.slice(0, 8)}] ${JSON.stringify(msg.content)}`);
        const arg = trMatch[1] || '';
        const wantOn = ['开', '开启', '启用', 'on'].includes(arg);
        const wantOff = ['关', '关闭', '停用', 'off'].includes(arg);
        let replyText;
        if (wantOn || wantOff) {
          store.setTranslate(openid, wantOn);
          await store.save();
          replyText = wantOn
            ? '✅ 已开启翻译：之后推送的推文会使用 X 自带的中文翻译，并标注「由X自动翻译」。'
            : '🔕 已关闭翻译：之后推送的推文保留原文。';
          logger.info(`群 ${openid} 翻译开关 -> ${wantOn ? '开' : '关'}`);
        } else {
          const here = String(openid).startsWith('c2c:') ? '本会话' : '本群';
          replyText = store.isTranslateOn(openid)
            ? `ℹ️ ${here}翻译：已开启（发「/翻译 关」关闭）`
            : `ℹ️ ${here}翻译：已关闭（发「/翻译 开」开启）`;
        }
        if (commands.reply !== false && msg.msgId) {
          qq.sendGroupReply(openid, replyText, msg.msgId).catch((err) =>
            logger.warn(`指令回复失败: ${err.message}`),
          );
        }
        return;
      }

      // 「/转推 <推文id>」：立刻把这条推文发出来（不看订阅、不看新旧）
      if (matchKeyword(msg.content, retweetWords)) {
        logger.info(`收到指令 [${openid.slice(0, 8)}] ${JSON.stringify(msg.content)}`);
        await replyTweet({
          cfg,
          qq,
          poller,
          logger,
          openid,
          msgId: msg.msgId,
          arg: extractCommandArg(msg.content, retweetWords) || '',
        });
        return;
      }

      const enable = matchKeyword(msg.content, enableWords);
      const disable = matchKeyword(msg.content, disableWords);
      const latest = matchKeyword(msg.content, latestWords);

      // 大群开了「全量消息」会收到每条聊天，只在命中指令时打 info 日志
      if (enable || disable || latest) {
        logger.info(`收到指令 [${openid.slice(0, 8)}] ${JSON.stringify(msg.content)}`);
      } else {
        logger.debug(`收到群消息 [${openid.slice(0, 8)}] ${JSON.stringify(msg.content)}`);
      }

      if (!enable && !disable && !latest) {
        // 普通 @：只登记，不改变订阅
        if (store.addGroup(openid, { source: 'at' })) await store.save();
        return;
      }

      if (latest && !enable && !disable) {
        const arg = extractCommandArg(msg.content, latestWords) || '';
        await replyLatest({
          cfg,
          qq,
          poller,
          store,
          logger,
          openid,
          msgId: msg.msgId,
          accountKey: arg.trim(),
        });
        return;
      }

      const accounts = cfg.accounts || [];
      const arg = extractCommandArg(msg.content, enable ? enableWords : disableWords);
      const account = resolveAccount(accounts, arg);
      store.addGroup(openid, { source: 'command' });

      if (!arg) {
        const subs = store.subscribedAccounts(openid);
        const list = accounts
          .map(
            (a) =>
              `${subs.includes(a.key) ? '✅' : '▫️'} ${a.key} · ${a.displayName} (@${a.handle})`,
          )
          .join('\n');
        await store.save();
        if (msg.msgId) {
          qq.sendGroupReply(openid, `用法：/订阅 <账号>\n${list}`, msg.msgId).catch(() => {});
        }
        return;
      }

      if (!account) {
        await store.save();
        if (msg.msgId) {
          qq.sendGroupReply(
            openid,
            `找不到账号「${arg}」\n可用：${accounts.map((a) => a.key).join('、')}`,
            msg.msgId,
          ).catch(() => {});
        }
        return;
      }

      store.setAccountSub(openid, account.key, enable);
      if (enable) {
        store.setEnabled(openid, true);
        // 新订阅默认开启「回复」和「转贴」转发
        store.setItemFlag(openid, account.key, 'replies', true);
        store.setItemFlag(openid, account.key, 'retweets', true);
      }
      await store.save();
      logger.info(
        `群 ${openid} ${enable ? '订阅' : '退订'} ${account.key}（${account.displayName}）`,
      );

      let greet = null;
      if (enable && poller) {
        try {
          greet = await poller.subscribeGreet(account, openid);
          if (greet.delivered) {
            logger.info(`已向群 ${openid} 推送 ${account.key} 的最新一条推文`);
          } else {
            logger.info(`订阅 ${account.key}：最新推文未能送达，已把 ${greet.total} 条历史标记为已读`);
          }
        } catch (err) {
          logger.warn(`订阅欢迎推送失败（不影响后续推送）: ${err.message}`);
        }
      }

      const isC2C = String(openid).startsWith('c2c:');

      if (commands.reply !== false && msg.msgId) {
        let hint = '';
        if (enable && !String(openid).startsWith('c2c:')) {
          // 群聊才需要检查「主动推送消息」权限；私聊没有这个限制
          let needHint = true;
          try {
            const state = await qq.api('GET', `/v2/groups/${openid}/bot_state`);
            needHint = state?.allow_proactive_msg !== true;
          } catch {
            needHint = true;
          }
          if (needHint) {
            hint =
              '\n\n⚠️ 本群还没给机器人开启「主动推送消息」，不开的话收不到推文。' +
              '\n请群主在手机QQ → 本群 → 设置 → 群机器人 → 凌光姬 → 设置权限 → 打开「主动推送消息」。';
          }
        }
        const greetLine = greet
          ? greet.delivered
            ? `\n📌 已把该账号最新一条推文发到${isC2C ? '这里' : '群里'}。`
            : '\n📌 最新推文发送失败（见下方权限提示）。'
          : '';
        const text = enable
          ? `✅ 已订阅 ${account.displayName}\n有新推会发到${isC2C ? '这里' : '本群'}；发「/退订 ${account.key}」可取消。${greetLine}${hint}`
          : `🔕 已退订 ${account.displayName}`;
        qq.sendGroupReply(openid, text, msg.msgId).catch((err) =>
          logger.warn(`指令回复失败: ${err.message}`),
        );
      }
    },
  });
}

async function cmdWatch() {
  const { cfg, logger, store, qq, poller } = await buildContext();
  const watcher = createWatcher({ cfg, logger, store, qq, poller });

  watcher.start();
  const words = (cfg.commands?.enable || []).join(' / ');
  logger.info(`正在监听群事件… 在群里 @ 机器人并发送「${words}」即可开启推送（Ctrl+C 退出）`);
  await new Promise((resolvePromise) => {
    process.on('SIGINT', () => {
      watcher.stop();
      resolvePromise();
    });
  });
  logger.info('已停止监听');
  return 0;
}

async function cmdOnce(args) {
  const { cfg, logger, store, qq, poller } = await buildContext();
  const seed = args.includes('--seed');
  const dryRun = args.includes('--dry-run');
  if (dryRun) logger.info('dry-run 模式：只打印，不发送');
  const result = await poller.tick({ seed, dryRun });
  logger.info(`本轮结果: ${JSON.stringify(result)}`);
  return 0;
}

/** 单实例锁：避免 DSH 里跑一份、计划任务又跑一份，两边抢同一个网关会话。 */
async function acquireSingleInstance(logger) {
  const lockPath = join(ROOT, '.run.lock');
  try {
    const prev = JSON.parse(await readFile(lockPath, 'utf8'));
    if (prev?.pid) {
      try {
        process.kill(prev.pid, 0);
        logger.error(`已有实例在运行 (pid=${prev.pid}，启动于 ${prev.startedAt})，本进程退出`);
        return null;
      } catch {
        /* 旧进程已不存在，接管 */
      }
    }
  } catch {
    /* 没有锁文件 */
  }

  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  await writeFile(lockPath, payload, 'utf8');
  const release = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => {
    release();
    process.exit(0);
  });
  return release;
}

async function cmdRun() {
  const { cfg, logger, store, qq, poller } = await buildContext();

  const release = await acquireSingleInstance(logger);
  if (!release) return 2;

  if (cfg.watchGroups) {
    const watcher = createWatcher({ cfg, logger, store, qq, poller });
    watcher.start();
    process.on('SIGINT', () => {
      watcher.stop();
      process.exit(0);
    });
  }

  // 只对「还没有任何已读记录」的账号做 seed：
  // 全新安装、或刚加的账号，先把存量标记为已读，避免把历史推文当成新推补发。
  for (const account of cfg.accounts) {
    const key = account.key || account.handle || 'default';
    const hasSeen = store.seen.some((k) => String(k).startsWith(`${key}|`));
    if (!hasSeen) {
      try {
        await poller.tickAccount(account, { seed: true });
      } catch (err) {
        logger.warn(`账号 ${key} 初始化已读失败: ${err.message}`);
      }
    }
  }
  try {
    const n = await poller.primeRecent(10);
    if (n) logger.info(`已预热最近 ${n} 条推文`);
  } catch (err) {
    logger.warn(`预热最近推文失败: ${err.message}`);
  }
  await poller.runLoop();
  return 0;
}


async function cmdProbe(args) {
  const { cfg, logger } = await buildContext();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--provider' && value) cfg.x.provider = value;
    else if (flag === '--proxy' && value) cfg.net.proxy = value;
    else if (flag === '--cookie' && value) cfg.net.xCookie = value;
    else if (flag === '--handle' && value) cfg.x.handle = value;
  }

  logger.info(`provider=${cfg.x.provider} proxy=${cfg.net.proxy || '(无)'} handle=@${cfg.x.handle}`);
  const poller = new Poller({ cfg, qq: null, store: null, logger, request });
  const collected = await poller.collectTweets();
  logger.info(`解析到 ${collected.length} 条有效推文（已按转推/回复/时效过滤）`);
  for (const { tweet } of collected.slice(-5).reverse()) {
    console.log(`\n--- ${tweet.published ? tweet.published.toISOString() : '无时间'} ---`);
    console.log(tweet.text || '(无正文)');
    console.log(tweet.link);
    if (tweet.images.length) console.log(`图片: ${tweet.images[0]}`);
  }
  return 0;
}

async function cmdSendTest(args) {
  const { cfg, logger, store, qq, poller } = await buildContext();
  const accIdx = args.indexOf('--account');
  const account = resolveAccount(cfg.accounts, accIdx >= 0 ? args[accIdx + 1] : '') || cfg.accounts[0];
  cfg.x = { ...cfg.x, ...account };
  const idx = args.indexOf('--group');
  const only = idx >= 0 ? args[idx + 1] : null;
  const groups = store.listEnabledGroups().filter((g) => !only || g.openid === only);
  if (!groups.length) {
    logger.error(
      only ? `群 ${only} 不在已开启名单里（先 groups enable）` : '没有已开启推送的群：先在群里 @ 机器人发送「订阅」',
    );
    return 1;
  }

  const collected = await poller.collectTweets(account);
  if (!collected.length) {
    logger.error('推文源里没有可用推文');
    return 1;
  }
  const pick = args.includes('--oldest')
    ? collected[0]
    : (() => {
        const idx = args.indexOf('--id');
        const id = idx >= 0 ? args[idx + 1] : null;
        if (id) {
          const hit = collected.find((c) => (c.tweet.link || '').includes(id));
          if (!hit) throw new Error(`推文源里找不到 id=${id} 的推文`);
          return hit;
        }
        return collected[collected.length - 1];
      })();
  const statusId = (pick.tweet.link || '').match(/status\/(\d+)/)?.[1] || pick.tweet.id;
  const media = await fetchTweetDetail(statusId).catch(() => null);
  const { displayTweet, repost } = resolveRepost(pick.tweet, media, cfg);

  const text = formatTweet(displayTweet, cfg);

  console.log(`\n=== 试发到 ${groups.length} 个群 ===\n${text}\n`);
  if (displayTweet.images.length) console.log(`图片: ${displayTweet.images[0]}\n`);
  if (repost) console.log(`转推自 ${repost.name}，原推 ${displayTweet.link}\n`);

  let ok = 0;
  for (const group of groups) {
    try {
      // 统一走 poller 的发送路径，头像/引用/转推/回复上下文都不会漏
      const result = await poller.sendTweetToGroup(account, pick.tweet, group.openid);
      console.log(
        `群 ${group.openid}: 文本=${result.text ? '成功' : '失败'}` +
          `(${result.styleUsed || (result.markdown ? 'markdown' : 'text')}) 图片=${result.images}` +
          (result.errors.length ? ` 错误=${result.errors.join('; ')}` : ''),
      );
      if (result.text) ok += 1;
    } catch (err) {
      const hint =
        err.code === 40034105
          ? '（主动消息无权限：需要群主在手机QQ里给机器人开启「主动推送消息」权限，详见官方 FAQ）'
          : '';
      console.log(`群 ${group.openid}: 发送失败 ${err.message}${hint}`);
    }
  }
  console.log(`\n完成：${ok}/${groups.length} 个群成功`);
  return ok === groups.length ? 0 : 1;
}

async function cmdSendTweet(args) {
  const { cfg, logger, store, qq, poller } = await buildContext();
  const accIdx = args.indexOf('--account');
  const account = resolveAccount(cfg.accounts, accIdx >= 0 ? args[accIdx + 1] : '') || cfg.accounts[0];
  cfg.x = { ...cfg.x, ...account };
  const url = args.find((a) => /x\.com|twitter\.com/.test(a));
  if (!url) {
    logger.error('用法: node src/main.js send-tweet <推文链接> [--group <openid>]');
    return 1;
  }
  const statusId = url.match(/status\/(\d+)/)?.[1];
  if (!statusId) {
    logger.error('链接里没有 status id');
    return 1;
  }

  const detail = await fetchTweetDetail(statusId);
  if (!detail) {
    logger.error(`fxtwitter 拉取失败: ${statusId}`);
    return 1;
  }

  const tweet = {
    id: detail.id,
    text: detail.text,
    link: detail.url,
    published: detail.createdAt ? new Date(detail.createdAt) : undefined,
    images: detail.photos.map((p) => p.url),
    isReply: false,
    isRetweet: false,
  };

  const idx = args.indexOf('--group');
  const only = idx >= 0 ? args[idx + 1] : null;
  const groups = store.listEnabledGroups().filter((g) => !only || g.openid === only);
  if (!groups.length) {
    logger.error('没有已开启推送的群');
    return 1;
  }

  let header = null;
  if ((cfg.forward.style || 'text') === 'markdown') {
    header = await qq
      .prepareHeader({
        avatarUrls: [cfg.x.avatarUrl, detail.authorAvatar, poller.meta.avatar],
        badgePath: cfg.forward.verifiedBadge === false ? null : cfg.forward.verifiedBadgePath,
      })
      .catch(() => null);
  }

  const text = formatTweet(tweet, cfg);
  const quoteBlock = detail.quote
    ? await qq.prepareQuote(detail.quote).catch(() => null)
    : null;
  console.log(`\n=== 发送单条推文到 ${groups.length} 个群 ===\n${text}\n`);
  console.log(
    `图片 ${detail.photos.length} 张，视频 ${detail.videos.length} 个，引用 ${detail.quote ? 1 : 0} 条`,
  );

  let ok = 0;
  for (const group of groups) {
    try {
      const result = await qq.deliver(group.openid, text, tweet.images, {
        sendImages: cfg.forward.sendImages !== false,
        maxImages: cfg.forward.maxImages ?? 6,
        style: cfg.forward.style || 'text',
        markdownImage: cfg.forward.markdownImage === true,
        header,
        photos: detail.photos,
        videos: detail.videos,
        quote: quoteBlock,
        markdownBuilder: (ctx) => formatTweetMarkdown(tweet, cfg, ctx || {}),
        arkBuilder: (imageUrl) => buildArkCard(tweet, cfg, imageUrl),
      });
      console.log(
        `群 ${group.openid}: ${result.text ? '成功' : '失败'}` +
          `(${result.styleUsed || (result.markdown ? 'markdown' : 'text')})` +
          ` 图片=${result.images} 视频=${result.videos || 0}` +
          (result.errors.length ? ` 错误=${result.errors.join('; ')}` : ''),
      );
      if (result.text) ok += 1;
    } catch (err) {
      console.log(`群 ${group.openid}: 失败 ${err.message}`);
    }
  }
  console.log(`\n完成：${ok}/${groups.length} 个群成功`);
  return ok === groups.length ? 0 : 1;
}

/** 验证 X cookie 是否可用：解析 queryId → 查 userId → 拉时间线，打印最新几条。 */
async function cmdXprobe() {
  const cfg = await loadConfig();
  const logger = createLogger(cfg.logLevel);
  const client = new XCookieClient(cfg, {
    request,
    logger,
    stateFile: `${cfg.statePath}.xgraphql.json`,
  });

  if (!client.enabled) {
    logger.error('没有配置 net.xCookie（浏览器里的 auth_token）');
    return 1;
  }
  logger.info(`cookie: auth_token ${client.cookie.authToken ? '已读取' : '缺失'}${client.cookie.ct0 ? ' + ct0' : '（无 ct0）'}`);

  await client.ensureQueryIds();
  logger.info(
    `queryId: UserTweets=${client.queryIds.UserTweets} UserByScreenName=${client.queryIds.UserByScreenName}`,
  );

  for (const account of cfg.accounts) {
    const handle = String(account.handle || '').replace(/^@/, '');
    try {
      const userId = account.userId || (await client.userId(handle));
      const json = await client.userTweets(userId, 10);
      const items = extractTimelineItems(json, handle);
      if (!items.length) {
        logger.warn(`[${account.key}] 时间线为空`);
        continue;
      }
      items.sort((a, b) => new Date(a.published) - new Date(b.published));
      logger.info(`[${account.key}] 拉到 ${items.length} 条，最新 3 条：`);
      for (const it of items.slice(-3)) {
        console.log(`  ${it.published}  ${it.link}`);
        console.log(`    ${(it.text || '').slice(0, 50).replace(/\n/g, ' ')}`);
      }
    } catch (err) {
      logger.error(`[${account.key}] 失败: ${err.message}`);
    }
  }
  return 0;
}

async function cmdStatus() {
  const { store } = await buildContext();
  const h = store.health;
  const rel = (iso) => {
    if (!iso) return '';
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    return `${Math.floor(minutes / 60)} 小时前`;
  };
  const fmt = (iso) =>
    iso
      ? `${new Date(iso).toLocaleString('zh-CN', { hour12: false })}（${rel(iso)}）`
      : '—';

  console.log('\n=== 服务状态 ===');
  console.log(`  轮询轮次 : ${h.rounds}`);
  console.log(`  上次轮询 : ${fmt(h.lastPollAt)}`);
  console.log(`  上次成功 : ${fmt(h.lastSuccessAt)}`);
  console.log(`  连续失败 : ${h.consecutiveFailures} 次`);
  console.log(`  累计     : 推送 ${h.sent} 条 / 失败 ${h.failed} 条`);
  if (h.lastError) console.log(`  最近错误 : ${h.lastError}`);

  const accounts = Object.entries(h.accounts || {});
  if (accounts.length) {
    console.log('  账号明细 :');
    for (const [key, v] of accounts) {
      console.log(
        `    ${key.padEnd(6)} 推送 ${String(v.sent).padStart(3)}  失败 ${String(v.failed).padStart(3)}  上次成功 ${fmt(v.lastSuccessAt)}`,
      );
    }
  }

  const groups = store.listGroups();
  console.log(`  群聊     : ${groups.length} 个（开启 ${groups.filter((g) => g.enabled !== false).length}）`);
  console.log('');
  return 0;
}

async function cmdGroups(args) {
  const { store, logger } = await buildContext();
  const [action, openid] = args;
  if (action === 'add' && openid) {
    store.addGroup(openid, { source: 'manual', enabled: true });
    await store.save();
    logger.info(`已手动添加并开启推送: ${openid}`);
  } else if (action === 'enable' && openid) {
    store.addGroup(openid, { source: 'manual' });
    store.setEnabled(openid, true);
    await store.save();
    logger.info(`已开启推送: ${openid}`);
  } else if (action === 'disable' && openid) {
    store.setEnabled(openid, false);
    await store.save();
    logger.info(`已关闭推送: ${openid}`);
  } else if (action === 'remove' && openid) {
    const removed = store.removeGroup(openid);
    await store.save();
    logger.info(removed ? `已移除: ${openid}` : '该群不在名单里');
  }
  printGroups(store, logger);
  return 0;
}

/** 素材库状态：张数、缓存过期情况；`--clean` 会把库回收到 mediaKeep 以下。 */
async function cmdMedia(args = []) {
  const { cfg, qq } = await buildContext();
  await qq.loadMediaCache();
  const keep = cfg.forward.mediaKeep ?? 70;

  if (args.includes('--clean')) {
    const deleted = await drainMedia(qq, keep);
    console.log(`素材回收完成：共删除 ${deleted} 张旧素材（目标 ≤ ${keep} 张）`);
  }

  const list = await qq.api('GET', '/v2/media-images');
  const total = Number(list?.total || 0);
  const images = list?.images || [];
  console.log(`素材库: ${total} / 100 张（列表接口一页只返回 ${images.length} 条，且不支持翻页）`);
  const ttl = cfg.forward.mediaCacheHours ?? 6;
  console.log(
    `素材缓存有效期: ${ttl}h   回收阈值: ${cfg.forward.mediaPruneAt ?? 88} 张` +
      `（回收时保留最新 ${cfg.forward.mediaPruneKeepNewest ?? 4} 张）`,
  );
  const mode = cfg.forward.imageMode || (cfg.forward.markdownImage ? 'inline' : 'message');
  const until = cfg.forward.mediaInlineUntil ?? 80;
  console.log(
    `图片模式: ${mode}` +
      (mode === 'auto'
        ? `（素材库 < ${until} 张时内嵌进卡片，否则改成单独发图片消息）`
        : mode === 'inline'
          ? '（内嵌进卡片，受 100 张素材上限影响）'
          : '（单独发图片消息，不占素材配额）'),
  );
  const ts = images.map((i) => Number(i.created_at || 0)).filter(Boolean).sort((a, b) => a - b);
  if (ts.length) {
    const fmt = (s) => new Date(s * 1000).toLocaleString('zh-CN', { timeZone: cfg.forward.timeZone });
    console.log(`可见素材: ${fmt(ts[0])} ～ ${fmt(ts[ts.length - 1])}`);
  }
  const entries = [...qq.mediaCache.values()];
  const ttlMs = qq.mediaCacheTtlMs;
  const expired = entries.filter((e) => !ttlMs || Date.now() - Number(e.at || 0) > ttlMs).length;
  console.log(`本地缓存: ${entries.length} 条，其中已过期 ${expired} 条（过期的下次会自动重传）`);
  if (total >= 88) {
    console.log(
      '提示: 素材库快满了（上限 100 张）。可以运行 `node src/main.js media --clean` 回收旧素材。',
    );
  }
  return 0;
}

/** 反复回收，直到库内张数降到 keep 以下（列表接口一次只给 20 条，得多跑几轮）。 */
async function drainMedia(qq, keep, maxRounds = 10) {
  let deleted = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const total = Number((await qq.api('GET', '/v2/media-images'))?.total || 0);
    if (total <= keep) break;
    const freed = await qq.pruneMediaIfNeeded({ force: true });
    if (!freed) break;
    deleted += freed;
  }
  return deleted;
}

function usage() {
  console.log(`LingGuangBot-QQ（凌光姬-QQ） — 把 X 账号的推文转发到 QQ 群

用法:
  node src/main.js doctor            体检：凭据 / 推文源 / 群名单
  node src/main.js watch             只监听群事件，自动登记机器人所在的群
  node src/main.js once [--seed]     跑一轮（--seed 把现有推文标记为已读）
  node src/main.js once --dry-run    跑一轮但不发送
  node src/main.js xprobe            验证 X cookie 并打印每个账号最新推文
  node src/main.js media             素材库状态（张数 / 缓存 / 回收阈值）
  node src/main.js media --clean     回收素材到 mediaKeep 以下（图片又发不出去时用）
  node src/main.js send-test [--oldest] [--id <推文id>]
                                     把最新（或指定）一条推文试发到已开启的群
  node src/main.js send-tweet <推文链接> [--group <openid>]
                                     按链接发送单条推文（含多图/视频）
  node src/main.js run               常驻：监听群 + 轮询推文 + 推送
  node src/main.js groups [add|enable|disable|remove <group_openid>]

配置文件: ${CONFIG_PATH}
`);
}

const [command = 'help', ...rest] = process.argv.slice(2);

try {
  let code = 0;
  switch (command) {
    case 'doctor':
      code = await cmdDoctor();
      break;
    case 'watch':
      code = await cmdWatch();
      break;
    case 'once':
      code = await cmdOnce(rest);
      break;
    case 'run':
      code = await cmdRun();
      break;
    case 'status':
      code = await cmdStatus();
      break;
    case 'xprobe':
      code = await cmdXprobe();
      break;
    case 'media':
      code = await cmdMedia(rest);
      break;
    case 'groups':
      code = await cmdGroups(rest);
      break;
    case 'probe':
      code = await cmdProbe(rest);
      break;
    case 'send-test':
      code = await cmdSendTest(rest);
      break;
    case 'send-tweet':
      code = await cmdSendTweet(rest);
      break;
    default:
      usage();
      break;
  }
  process.exit(code);
} catch (err) {
  console.error(`\n执行失败: ${err.message}`);
  if (process.env.LINGGUANGBOT_QQ_DEBUG) console.error(err.stack);
  process.exit(1);
}

