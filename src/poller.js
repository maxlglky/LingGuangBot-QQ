import { readFile } from 'node:fs/promises';
import { dedupeKey, toTweet } from './tweet.js';
import { XCookieClient, fetchXCookie } from './xgraphql.js';
import { fetchTweetDetail, resolveRepost } from './fx.js';
import { buildArkCard, formatTweet, formatTweetMarkdown } from './format.js';
import { sleep } from './util.js';

/**
 * 轮询多个账号的推文源 → 去重 → 推送给「订阅了该账号」的群。
 *
 * 一个账号 = { key, handle, displayName, userId, provider, includeRetweets, maxAgeHours, ... }
 * 群在 state.json 里用 accounts: ["yuna", ...] 记录订阅关系。
 */
export class Poller {
  constructor({ cfg, qq, store, logger, request }) {
    this.cfg = cfg;
    this.qq = qq;
    this.store = store;
    this.logger = logger;
    this.request = request;
    this.recent = [];
    this.metaByAccount = new Map();
    this.xStateFile = cfg.statePath ? `${cfg.statePath}.xgraphql.json` : null;
    this.translationCache = new Map();
  }

  /** 账号列表；没配置 accounts 时退化成单账号（兼容旧配置）。 */
  accounts() {
    if (Array.isArray(this.cfg.accounts) && this.cfg.accounts.length) return this.cfg.accounts;
    return [{ key: 'default', ...this.cfg.x }];
  }

  /** 单个账号的等价配置对象（feed.js 读的是 cfg.x.*）。 */
  accountCfg(account) {
    return { ...this.cfg, x: { ...this.cfg.x, ...account } };
  }

  metaFor(account) {
    const acc = account || this.accounts()[0];
    const key = acc.key || acc.handle || 'default';
    if (!this.metaByAccount.has(key)) this.metaByAccount.set(key, {});
    return this.metaByAccount.get(key);
  }

  /** 兼容旧代码：默认取第一个账号的 meta。 */
  get meta() {
    return this.metaFor(this.accounts()[0]);
  }

  async fetchRaw(acfg, meta) {
    const provider = acfg.x.provider || 'xcookie';
    switch (provider) {
      case 'xcookie':
        return fetchXCookie(acfg, {
          request: this.request,
          meta,
          logger: this.logger,
          stateFile: this.xStateFile,
        });
      case 'file': {
        // 本地 JSON 文件，仅用于测试/调试：数组元素是已归一化的 item
        const raw = await readFile(acfg.x.file, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : parsed.items || [];
      }
      default:
        throw new Error(`未知的 provider: ${provider}（可选 xcookie / file）`);
    }
  }

  /** 用 X 自带翻译拿简体中文译文；带内存缓存，失败返回空串。 */
  async translateTweet(acfg, tweetId) {
    if (!tweetId) return '';
    const cached = this.translationCache.get(tweetId);
    if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.text;
    try {
      const client = new XCookieClient(acfg, {
        request: this.request,
        logger: this.logger,
        stateFile: this.xStateFile,
      });
      if (!client.enabled) return '';
      const text = await client.translateTweet(tweetId);
      if (text) this.translationCache.set(tweetId, { text, at: Date.now() });
      return text;
    } catch (err) {
      this.logger.warn(`翻译失败（本条用原文）: ${err.message}`);
      return '';
    }
  }

  /** 回复类型：把被回复的原推也拉下来，作为缩进块附在卡片里（拉不到就跳过）。 */
  /**
   * 图片是内嵌进卡片，还是单独发「图片消息」。
   * 具体规则在 QQClient.wantInlineImages（inline / message / auto）。
   */
  async wantInlineImages(acfg) {
    if (!this.qq?.wantInlineImages) {
      return acfg?.forward?.imageMode ? acfg.forward.imageMode === 'inline' : acfg?.forward?.markdownImage === true;
    }
    return this.qq.wantInlineImages(acfg?.forward || this.cfg.forward || {});
  }

  /** 实际生效的图片模式（把 auto 解析成 inline / message）。 */
  effectiveImageMode(acfg) {
    const mode = acfg?.forward?.imageMode || (acfg?.forward?.markdownImage ? 'inline' : 'message');
    if (mode === 'auto') return this.qq?.lastInlineDecision === false ? 'message' : 'inline';
    return mode;
  }

  async buildReplyContext(displayTweet, acfg) {
    const parentId = displayTweet?.replyToStatusId;
    if (!parentId) return null;
    try {
      const parent = await fetchTweetDetail(parentId);
      if (!parent) return null;
      const photos = await this.wantInlineImages(acfg).catch(() => false);
      return await this.qq.prepareQuote(
        {
          ...parent,
          // 原推按它自己的账号名显示，和一张普通卡片一致
          author: parent.author || parent.screenName || displayTweet.replyTo || '对方',
        },
        { photos },
      );
    } catch (err) {
      this.logger.warn(`拉取原推失败（不影响主卡片）: ${err.message}`);
      return null;
    }
  }

  async collectTweets(account) {
    const acc = account || this.accounts()[0];
    const acfg = this.accountCfg(acc);
    const meta = this.metaFor(acc);
    const raw = await this.fetchRaw(acfg, meta);
    const maxAgeMs = (acfg.x.maxAgeHours ?? 0) * 3600_000;
    const now = Date.now();

    const tweets = [];
    for (const item of raw) {
      const tweet = toTweet(item, acfg.x);
      if (!tweet.id && !tweet.link) continue;
      if (tweet.isRetweet && !acfg.x.includeRetweets) continue;
      if (tweet.isReply && !acfg.x.includeReplies) continue;
      if (maxAgeMs > 0 && tweet.published) {
        const age = now - tweet.published.getTime();
        if (age > maxAgeMs) continue;
      }
      tweets.push(tweet);
    }

    const unique = new Map();
    for (const tweet of tweets) {
      const key = dedupeKey(tweet);
      if (!unique.has(key)) unique.set(key, { tweet, key });
    }

    return [...unique.values()].sort((a, b) => {
      const ta = a.tweet.published?.getTime() ?? 0;
      const tb = b.tweet.published?.getTime() ?? 0;
      return ta - tb;
    });
  }

  /** 订阅了该账号、且推送开启的群。 */
  groupsFor(account) {
    const key = account.key || account.handle || 'default';
    return this.store
      .listGroups()
      .filter((g) => g.enabled !== false)
      .filter((g) => !Array.isArray(g.accounts) || g.accounts.includes(key));
  }

  seenKey(account, key) {
    return `${account.key || account.handle || 'default'}|${key}`;
  }

  async tick(options = {}) {
    const summary = {
      accounts: 0,
      fetched: 0,
      seeded: 0,
      sent: 0,
      failed: 0,
      remaining: 0,
      lastError: null,
    };
    const staggerMs = Math.max(0, (this.cfg.forward.accountStaggerSec ?? 3) * 1000);
    let firstAccount = true;
    for (const account of this.accounts()) {
      try {
        if (!firstAccount && staggerMs) {
          await sleep(Math.floor(Math.random() * staggerMs));
        }
        firstAccount = false;
        const r = await this.tickAccount(account, options);
        summary.accounts += 1;
        summary.fetched += r.fetched;
        summary.seeded += r.seeded;
        summary.sent += r.sent;
        summary.failed += r.failed || 0;
        summary.remaining += r.remaining || 0;
        if (r.lastError) summary.lastError = r.lastError;
      } catch (err) {
        summary.failed += 1;
        summary.lastError = err.message;
        this.logger.error(`账号 ${account.key || account.handle} 拉取失败: ${err.message}`);
      }
    }
    this.store.recordRound(summary);
    await this.store.save();
    return summary;
  }

  async tickAccount(account, { seed = false, dryRun = false } = {}) {
    const acfg = this.accountCfg(account);
    const label = account.key || account.handle || 'default';
    const collected = await this.collectTweets(account);
    const fresh = collected.filter(({ key }) => !this.store.hasSeen(this.seenKey(account, key)));

    if (seed) {
      for (const { key } of fresh) this.store.markSeen(this.seenKey(account, key));
      await this.store.save();
      this.logger.info(`[${label}] 已把现有 ${fresh.length} 条推文标记为已读`);
      return { fetched: collected.length, seeded: fresh.length, sent: 0 };
    }

    if (fresh.length === 0) {
      this.store.recordAccount(label, {});
      this.logger.debug(`[${label}] 本轮无新推文（源内 ${collected.length} 条，均已读）`);
      return { fetched: collected.length, seeded: 0, sent: 0 };
    }

    const groups = this.groupsFor(account);
    if (groups.length === 0) {
      this.store.recordAccount(label, {});
      this.logger.debug(`[${label}] 没有订阅该账号的群`);
      return { fetched: collected.length, seeded: 0, sent: 0, groups: 0 };
    }

    // 陈旧推文过滤：停机一晚上再启动时，别把十几小时前的推当"新推"补发
    const maxPushAgeHours = acfg.forward.maxPushAgeHours ?? 6;
    const maxPushAgeMs = maxPushAgeHours * 3600_000;
    const nowMs = Date.now();
    const stale = [];
    const usable = [];
    for (const item of fresh) {
      const t = item.tweet.published?.getTime();
      if (maxPushAgeMs > 0 && t && nowMs - t > maxPushAgeMs) stale.push(item);
      else usable.push(item);
    }
    if (stale.length) {
      for (const { key } of stale) this.store.markSeen(this.seenKey(account, key));
      await this.store.save();
      this.logger.info(
        `[${label}] 跳过 ${stale.length} 条超过 ${maxPushAgeHours} 小时的陈旧推文（不再补发）`,
      );
    }
    if (usable.length === 0) {
      this.store.recordAccount(label, {});
      return { fetched: collected.length, seeded: 0, sent: 0, stale: stale.length };
    }

    const maxPerRun = acfg.forward.maxPerRun ?? 5;
    const batch = usable.slice(0, maxPerRun);
    let sent = 0;
    let failed = 0;
    let lastError = null;

    for (const { tweet, key } of batch) {
      const statusId = (tweet.link || '').match(/status\/(\d+)/)?.[1] || tweet.id;
      const detail = await fetchTweetDetail(statusId).catch(() => null);
      const { displayTweet, repost } = resolveRepost(tweet, detail, acfg);
      const text = formatTweet(displayTweet, acfg);

      if (dryRun) {
        this.logger.info(`[dry-run][${label}] 将推送 ${key}\n${text}\n`);
        this.pushRecent(displayTweet);
        sent += 1;
        continue;
      }

      let anySuccess = false;
      let header = null;
      const photos = detail?.photos?.length
        ? detail.photos
        : (tweet.images || []).map((url) => ({ url }));
      const videos = detail?.videos || [];

      if (acfg.forward.style === 'markdown') {
        try {
          // 转推时卡片显示的是被转账号，但蓝标跟随本账号的配置，避免「原推作者没认证就没标」
          const badgeAllowed = acfg.forward.verifiedBadge !== false;
          header = await this.qq.prepareHeader({
            avatarUrls: repost
              ? [detail?.authorAvatar]
              : [acfg.x.avatarUrl, this.metaFor(account).avatar, detail?.authorAvatar],
            badgePath: badgeAllowed ? acfg.forward.verifiedBadgePath || null : null,
          });
        } catch (err) {
          this.logger.warn(`[${label}] 准备头像/徽章失败: ${err.message}`);
        }
      }

      let quoteBlock = null;
      if (detail?.quote && acfg.forward.quote !== false) {
        try {
          quoteBlock = await this.qq.prepareQuote(detail.quote, {
            photos: await this.wantInlineImages(acfg).catch(() => false),
          });
        } catch (err) {
          this.logger.warn(`[${label}] 准备引用推文失败: ${err.message}`);
        }
      }

      let translatedText = '';
      let translatedQuoteText = '';
      if (groups.some((g) => g.translate === true)) {
        translatedText = await this.translateTweet(acfg, detail?.id || statusId);
        if (detail?.quote?.id) {
          translatedQuoteText = await this.translateTweet(acfg, detail.quote.id);
        }
      }

      for (const group of groups) {
        const flags = this.store?.getItemFlags?.(group.openid, label) || { replies: true, retweets: true };
        if (tweet.isReply && !flags.replies) continue;
        if (tweet.isRetweet && !flags.retweets) continue;

        try {
          const replyContext = displayTweet?.isReply
            ? await this.buildReplyContext(displayTweet, acfg)
            : null;
          const result = await this.qq.deliver(
            group.openid,
            text,
            displayTweet.images || [],
            {
              sendImages: acfg.forward.sendImages !== false,
              style: acfg.forward.style || 'text',
              markdownImage: await this.wantInlineImages(acfg).catch(() => false),
              imageMode: this.effectiveImageMode(acfg),
              quotePhotos: detail?.quote?.photos || [],
              header,
              photos,
              videos,
              quote: quoteBlock,
              repost,
              name: repost ? detail?.author : undefined,
              maxImages: acfg.forward.maxImages ?? 6,
              markdownBuilder: (ctx) =>
                formatTweetMarkdown(displayTweet, acfg, {
                  ...(ctx || {}),
                  replyContext,
                  translatedText: group.translate ? translatedText : '',
                  translatedQuoteText: group.translate ? translatedQuoteText : '',
                }),
              arkBuilder: (imageUrl) => buildArkCard(tweet, acfg, imageUrl),
            },
          );
          if (result.text) {
            anySuccess = true;
            sent += 1;
            this.logger.info(
              `[${label}] 已推送 ${key} → 群 ${group.openid}` +
                `${result.images ? ` (+${result.images} 图)` : ''}`,
            );
          }
          for (const err of result.errors) {
            this.logger.warn(`群 ${group.openid} 部分失败: ${err}`);
          }
        } catch (err) {
          failed += 1;
          lastError = err.message;
          if (err.code === 40034105) {
            this.warnPermissionOnce();
          } else {
            this.logger.error(`推送 ${key} → 群 ${group.openid} 失败: ${err.message}`);
          }
        }
      }

      if (anySuccess) {
        this.store.markSeen(this.seenKey(account, key));
        // 转推的「转帖 id」和「原推 id」是两个 id，同一内容只该推一次：
        // 两个 id 都记为已读，避免换源后重复推送
        const originalId = detail?.id ? `x:${detail.id}` : null;
        if (originalId && originalId !== key) this.store.markSeen(this.seenKey(account, originalId));
        this.pushRecent(displayTweet);
      }
    }

    this.store.recordAccount(label, { sent, failed, error: lastError });
    await this.store.save();
    if (fresh.length > batch.length) {
      this.logger.info(`[${label}] 还有 ${fresh.length - batch.length} 条新推文留到下一轮`);
    }
    return {
      fetched: collected.length,
      seeded: 0,
      sent,
      failed,
      lastError,
      remaining: Math.max(0, usable.length - batch.length),
      stale: stale.length,
    };
  }

  /** 主动消息无权限时，每小时只提醒一次，且不标记已读（权限开通后自动补推）。 */
  warnPermissionOnce() {
    const now = Date.now();
    if (!this.permissionWarnedAt || now - this.permissionWarnedAt > 3600_000) {
      this.permissionWarnedAt = now;
      this.logger.warn(
        '主动消息无权限（40034105）：需要群主在手机QQ → 群设置 → 群机器人 → 该机器人 → 「设置权限」里开启「主动推送消息」。' +
          '当前不标记已读，权限开通后会自动补推。',
      );
    }
  }

  /** 预热最近推文（给「最新」指令用）。 */
  async primeRecent(limit = 10) {
    for (const account of this.accounts()) {
      try {
        const collected = await this.collectTweets(account);
        for (const { tweet } of collected.slice(-limit)) this.pushRecent(tweet);
      } catch {
        /* 单个账号失败不影响其他账号 */
      }
    }
    return this.recent.length;
  }

  /**
   * 订阅某个账号时：先把该账号最新一条推文推到群里，再把其余推文标记为已读。
   * 新订阅的群能立刻看到效果，又不会被历史推文刷屏。
   */
  async subscribeGreet(account, groupOpenid) {
    const collected = await this.collectTweets(account);
    const latest = collected[collected.length - 1];
    let delivered = false;

    if (latest) {
      try {
        const result = await this.sendTweetToGroup(account, latest.tweet, groupOpenid);
        delivered = Boolean(result?.text);
      } catch (err) {
        this.logger.warn(`最新推文推送失败: ${err.message}`);
      }
    }

    for (const { key } of collected) this.store.markSeen(this.seenKey(account, key));
    await this.store.save();
    if (latest) this.pushRecent(latest.tweet);
    return { delivered, total: collected.length, tweet: latest?.tweet || null };
  }

  /** 把单条推文按当前卡片样式发给指定群（订阅欢迎、手动补推用）。 */
  async sendTweetToGroup(account, tweet, groupOpenid, options = {}) {
    const acfg = this.accountCfg(account);
    const statusId = (tweet.link || '').match(/status\/(\d+)/)?.[1] || tweet.id;
    const detail = await fetchTweetDetail(statusId).catch(() => null);
    const { displayTweet, repost } = resolveRepost(tweet, detail, acfg);
    const text = formatTweet(displayTweet, acfg);

    let header = null;
    if (acfg.forward.style === 'markdown') {
      try {
        const badgeAllowed = acfg.forward.verifiedBadge !== false;
        header = await this.qq.prepareHeader({
          avatarUrls: repost
            ? [detail?.authorAvatar]
            : [acfg.x.avatarUrl, this.metaFor(account).avatar, detail?.authorAvatar],
          badgePath: badgeAllowed ? acfg.forward.verifiedBadgePath || null : null,
        });
      } catch (err) {
        this.logger.warn(`准备头像/徽章失败: ${err.message}`);
      }
    }

    let quoteBlock = null;
    if (detail?.quote && acfg.forward.quote !== false) {
      try {
        quoteBlock = await this.qq.prepareQuote(detail.quote, {
          photos: await this.wantInlineImages(acfg).catch(() => false),
        });
      } catch {
        /* 引用块失败不影响主卡片 */
      }
    }

    const photos = detail?.photos?.length
      ? detail.photos
      : (tweet.images || []).map((url) => ({ url }));

    const replyContext = displayTweet?.isReply
      ? await this.buildReplyContext(displayTweet, acfg)
      : null;
    const wantTranslate = this.store?.isTranslateOn?.(groupOpenid) === true;
    const translatedText = wantTranslate
      ? await this.translateTweet(acfg, detail?.id || statusId)
      : '';
    const translatedQuoteText =
      wantTranslate && detail?.quote?.id ? await this.translateTweet(acfg, detail.quote.id) : '';

    return this.qq.deliver(groupOpenid, text, displayTweet.images || [], {
      replyTo: options.replyTo || null,
      sendImages: acfg.forward.sendImages !== false,
      style: acfg.forward.style || 'text',
      markdownImage: await this.wantInlineImages(acfg).catch(() => false),
      imageMode: this.effectiveImageMode(acfg),
      quotePhotos: detail?.quote?.photos || [],
      header,
      photos,
      videos: detail?.videos || [],
      quote: quoteBlock,
      repost,
      name: repost ? detail?.author : undefined,
      maxImages: acfg.forward.maxImages ?? 6,
      markdownBuilder: (ctx) =>
        formatTweetMarkdown(displayTweet, acfg, {
          ...(ctx || {}),
          replyContext,
          translatedText,
          translatedQuoteText,
        }),
      arkBuilder: (imageUrl) => buildArkCard(tweet, acfg, imageUrl),
    });
  }

  /** 把某个账号当前源里的推文全部标记为已读（订阅时避免刷屏）。 */
  async syncSeen(account) {
    let marked = 0;
    for (const acc of account ? [account] : this.accounts()) {
      try {
        const collected = await this.collectTweets(acc);
        for (const { key } of collected) {
          if (this.store.markSeen(this.seenKey(acc, key))) marked += 1;
        }
      } catch (err) {
        this.logger.warn(`同步 ${acc.key || acc.handle} 已读失败: ${err.message}`);
      }
    }
    if (marked) await this.store.save();
    return marked;
  }

  pushRecent(tweet) {
    this.recent.unshift(tweet);
    const max = this.cfg.forward?.recentMax ?? 50;
    if (this.recent.length > max) this.recent.length = max;
  }

  async runLoop() {
    const intervalMs = (this.cfg.forward.intervalSec ?? 300) * 1000;
    // 随机抖动：避免每小时整点、固定秒数地打 X 接口（容易被风控）
    const jitterMs = Math.max(0, (this.cfg.forward.intervalJitterSec ?? 60) * 1000);
    this.logger.info(
      `开始轮询 ${this.accounts().length} 个账号，间隔 ${Math.round(intervalMs / 1000)}s` +
        (jitterMs ? `（随机抖动 0~${Math.round(jitterMs / 1000)}s）` : ''),
    );
    for (;;) {
      const startedAt = Date.now();
      try {
        const summary = await this.tick();
        this.logger.debug(
          `本轮结束：账号 ${summary.accounts} 个，源内 ${summary.fetched} 条，` +
            `推送 ${summary.sent} 条，失败 ${summary.failed} 条，剩余 ${summary.remaining} 条`,
        );
      } catch (err) {
        this.logger.error(`本轮轮询失败: ${err.message}`);
      }
      const elapsed = Date.now() - startedAt;
      const jitter = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;
      const waitMs = Math.max(5000, intervalMs - elapsed) + jitter;
      if (jitter) this.logger.debug(`下一轮将在 ${(waitMs / 1000).toFixed(1)}s 后开始`);
      await sleep(waitMs);
    }
  }
}
