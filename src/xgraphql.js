/**
 * X（Twitter）网页版 GraphQL 客户端：用登录 cookie 直接拉用户时间线。
 *
 * 为什么这么做：第三方 RSS（rss.app）入库延迟不可控，公共 RSSHub 实例已关闭
 * Twitter 路由，付费 API 按条计费很贵。用自己账号的 cookie 直接调 X 的接口，
 * 延迟等于我们的轮询间隔，且免费。
 *
 * 代价：auth_token 会过期，queryId 会随 X 前端改版变化 —— 这里都做了自动处理。
 */
import { readFile, writeFile } from 'node:fs/promises';

// X 网页版长期使用的公开 bearer（前端包里就有，不是账号凭据）
const WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const HOME_URL = 'https://x.com/home';
const BUNDLE_HOST = 'https://abs.twimg.com/responsive-web/client-web';

/** 从 cookie 字符串或单个 auth_token 里解析出需要的字段。 */
export function parseXCookie(raw) {
  const text = String(raw || '').trim();
  if (!text) return { authToken: '', ct0: '' };
  if (!text.includes('=')) return { authToken: text, ct0: '' };
  const map = {};
  for (const part of text.split(';')) {
    const [k, ...rest] = part.split('=');
    if (!k) continue;
    map[k.trim()] = rest.join('=').trim();
  }
  return { authToken: map.auth_token || '', ct0: map.ct0 || '' };
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// X 对缺少浏览器指纹头的请求会直接回 401，这里补齐一套常见的
const BROWSER_HEADERS = {
  'user-agent': UA,
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-site': 'same-origin',
};

function baseHeaders(cookie) {
  const { authToken, ct0 } = cookie;
  const headers = {
    ...BROWSER_HEADERS,
    authorization: `Bearer ${WEB_BEARER}`,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'x-twitter-auth-type': 'OAuth2Session',
    accept: '*/*',
    'content-type': 'application/json',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    referer: 'https://x.com/',
    origin: 'https://x.com',
    cookie: [`auth_token=${authToken}`, ct0 ? `ct0=${ct0}` : ''].filter(Boolean).join('; '),
  };
  if (ct0) headers['x-csrf-token'] = ct0;
  return headers;
}

/** 取 HTML 页面（首页）时要用 document 语义的头，否则 X 会返回 401。 */
function documentHeaders(cookie) {
  const { authToken, ct0 } = cookie;
  return {
    ...BROWSER_HEADERS,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
    cookie: [`auth_token=${authToken}`, ct0 ? `ct0=${ct0}` : ''].filter(Boolean).join('; '),
  };
}

export class XCookieClient {
  constructor(cfg, { request, logger, stateFile } = {}) {
    this.cfg = cfg;
    this.request = request;
    this.logger = logger;
    this.stateFile = stateFile;
    this.cookie = parseXCookie(cfg.net?.xCookie);
    this.queryIds = { ...(cfg.net?.xGraphqlIds || {}) };
  }

  get enabled() {
    return Boolean(this.cookie.authToken);
  }

  async loadState() {
    if (!this.stateFile) return;
    try {
      const data = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (data?.queryIds) this.queryIds = { ...data.queryIds, ...this.queryIds };
      if (data?.queryIdsAt) this.queryIdsAt = data.queryIdsAt;
    } catch {
      /* 没有缓存文件 */
    }
  }

  async saveState() {
    if (!this.stateFile) return;
    try {
      await writeFile(
        this.stateFile,
        JSON.stringify({ queryIds: this.queryIds, queryIdsAt: this.queryIdsAt }, null, 2),
        'utf8',
      );
    } catch {
      /* 写缓存失败不影响主流程 */
    }
  }

  async api(path, params) {
    const url = `https://x.com${path}?${new URLSearchParams(params)}`;
    const res = await this.request(url, {
      proxy: this.cfg.net?.proxyForX || this.cfg.net?.proxy,
      timeoutMs: 25000,
      headers: baseHeaders(this.cookie),
    });
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`X 拒绝了请求（${res.status}），cookie 可能已失效`), {
        code: res.status,
      });
    }
    if (res.status === 429) {
      throw Object.assign(new Error('X 限流（429），稍后重试'), { code: 429 });
    }
    if (res.status !== 200) {
      throw new Error(`X 接口返回 HTTP ${res.status}: ${res.text.slice(0, 160)}`);
    }
    try {
      return JSON.parse(res.text);
    } catch (err) {
      throw new Error(`X 接口响应解析失败: ${err.message}`);
    }
  }

  /** 抓首页引用的前端 JS 包地址（浏览器指纹头不对会被 401）。 */
  async listBundles() {
    const res = await this.request(HOME_URL, {
      proxy: this.cfg.net?.proxyForX || this.cfg.net?.proxy,
      timeoutMs: 25000,
      headers: documentHeaders(this.cookie),
    });
    if (res.status !== 200) {
      throw new Error(`获取 X 首页失败 HTTP ${res.status}（cookie 失效？）`);
    }
    return [
      ...new Set(
        [...res.text.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"']+\.js/g)].map(
          (m) => m[0],
        ),
      ),
    ];
  }

  /** 从 X 的前端 JS 包里抓当前生效的 queryId（X 改版后会自动更新）。 */
  async refreshQueryIds() {
    const res = await this.request(HOME_URL, {
      proxy: this.cfg.net?.proxyForX || this.cfg.net?.proxy,
      timeoutMs: 25000,
      headers: documentHeaders(this.cookie),
    });
    if (res.status !== 200) {
      throw new Error(`获取 X 首页失败 HTTP ${res.status}（cookie 失效？）`);
    }

    const scripts = [...res.text.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"']+\.js/g)]
      .map((m) => m[0])
      .filter((u, i, arr) => arr.indexOf(u) === i);
    const bundles = scripts.filter((u) => /main|bundle|client-web/i.test(u)).slice(0, 24);

    const found = {};
    const candidates = {};
    const addCandidate = (op, id) => {
      if (!op || !id) return;
      const list = candidates[op] || (candidates[op] = []);
      if (!list.includes(id)) list.push(id);
      found[op] = id;
    };
    for (const url of bundles) {
      const bundle = await this.request(url, {
        proxy: this.cfg.net?.proxyForX || this.cfg.net?.proxy,
        timeoutMs: 20000,
        headers: {
          ...BROWSER_HEADERS,
          accept: '*/*',
          'sec-fetch-dest': 'script',
          'sec-fetch-mode': 'no-cors',
        },
      }).catch(() => null);
      if (!bundle || bundle.status !== 200) continue;
      for (const m of bundle.text.matchAll(
        /queryId:"([^"]+)",operationName:"([^"]+)"/g,
      )) {
        addCandidate(m[2], m[1]);
      }
      for (const m of bundle.text.matchAll(
        /operationName:"([^"]+)",queryId:"([^"]+)"/g,
      )) {
        addCandidate(m[1], m[2]);
      }
      if (found.UserTweets && found.UserByScreenName && found.UserTweetsAndReplies) break;
    }

    if (!found.UserTweets && !found.UserByScreenName) {
      throw new Error('没能从 X 前端包里找到 queryId（X 可能改版了）');
    }
    this.queryIds = { ...this.queryIds, ...found };
    this.queryIdCandidates = candidates;
    this.queryIdsAt = new Date().toISOString();
    await this.saveState();
    if (this.logger) this.logger.info('已刷新 X 的 GraphQL queryId');
    return this.queryIds;
  }

  async ensureQueryIds() {
    if (this.queryIds.UserTweets && this.queryIds.UserByScreenName) return this.queryIds;
    await this.loadState();
    if (this.queryIds.UserTweets && this.queryIds.UserByScreenName) return this.queryIds;
    return this.refreshQueryIds();
  }

  /** 带一次自动重试：queryId 失效时刷新后重试。 */
  async callGraphql(operation, variables, features) {
    await this.ensureQueryIds();

    // X 的前端包里同一个操作可能残留多个 queryId，逐个试直到有一个能用
    const listOf = () => {
      const list = [...(this.queryIdCandidates?.[operation] || [])];
      if (this.queryIds?.[operation] && !list.includes(this.queryIds[operation])) {
        list.unshift(this.queryIds[operation]);
      }
      return list;
    };

    const attempt = async () => {
      const list = listOf();
      if (!list.length) throw new Error(`缺少 ${operation} 的 queryId`);
      let lastErr;
      for (const queryId of list) {
        try {
          return await this.api(`/i/api/graphql/${queryId}/${operation}`, {
            variables: JSON.stringify(variables),
            features: JSON.stringify(features || {}),
          });
        } catch (err) {
          lastErr = err;
          // 只有 queryId 相关的错误才值得换下一个
          if (!(err.code === 400 || /HTTP 40[04]/.test(err.message))) throw err;
        }
      }
      throw lastErr;
    };

    try {
      return await attempt();
    } catch (err) {
      if (err.code === 400 || /HTTP 40[04]/.test(err.message)) {
        if (this.logger) this.logger.warn(`X 接口 ${operation} 失败，刷新 queryId 后重试`);
        await this.refreshQueryIds();
        return attempt();
      }
      throw err;
    }
  }

  async userId(screenName) {
    const json = await this.callGraphql(
      'UserByScreenName',
      { screen_name: screenName.replace(/^@/, ''), withSafetyModeUserFields: true },
      {
        hidden_profile_subscriptions_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
      },
    );
    const id = json?.data?.user?.result?.rest_id;
    if (!id) throw new Error(`找不到用户 ${screenName}`);
    return id;
  }

  async userTweets(userId, count = 20) {
    return this.callGraphql(
      'UserTweets',
      {
        userId,
        count,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
      },
      {
        rweb_video_screen_enabled: false,
        pay_view_count_enabled: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_enhance_cards_enabled: false,
      },
    );
  }

  /**
   * 「回复时间线」：只有开了 includeReplies 才用。
   * X 的 UserTweetsAndReplies 现在用不了（404），UserRepliesTimeline 可以，
   * 它返回的是「推文 + 回复」的混合时间线。
   */
  async userReplies(userId, count = 20) {
    return this.callGraphql(
      'UserRepliesTimeline',
      {
        userId,
        count,
        includePromotedContent: false,
        withCommunity: false,
        withVoice: true,
      },
      {
        rweb_video_screen_enabled: false,
        pay_view_count_enabled: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_enhance_cards_enabled: false,
      },
    );
  }

  /**
   * 用 X 自带的翻译（网页上点「显示翻译」走的就是这个接口）。
   * 返回简体中文译文；失败返回空串。
   */
  async translateTweet(tweetId, dest = 'zh-cn') {
    const param =
      `None/tweetId=${tweetId},destinationLanguage=Some(${dest}),` +
      'translationSource=Some(X),feature=None,timeout=None,onlyCached=None';
    const json = await this.api(
      `/i/api/1.1/strato/column/${param}/translation/service/translateTweet`,
      {},
    );
    return String(json?.translation || '').trim();
  }
}

/** 把 GraphQL 的推文节点转成我们内部统一的 items。 */
export function xTweetToItem(node, screenName) {
  if (!node) return null;
  const tweet = node.tweet_results?.result || node;
  if (!tweet) return null;
  if (tweet.__typename === 'TweetTombstone') return null;

  const legacy = tweet.legacy || {};
  const userResult = tweet.core?.user_results?.result || {};
  const userLegacy = userResult.legacy || {};
  const screen = userLegacy.screen_name || screenName;

  const idStr = tweet.rest_id || legacy.id_str;
  if (!idStr) return null;

  const media = legacy.extended_entities?.media || legacy.entities?.media || [];
  const images = media
    .map((m) => m.media_url_https || m.media_url)
    .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));

  const createdAt = legacy.created_at ? new Date(legacy.created_at) : new Date();

  return {
    id: `x:${idStr}`,
    title: legacy.full_text || '',
    link: `https://x.com/${screen}/status/${idStr}`,
    author: userLegacy.name || '',
    published: createdAt.toISOString(),
    contentHtml: '',
    text: legacy.full_text || '',
    images,
    raw: JSON.stringify({ id_str: idStr, created_at: legacy.created_at }),
    avatar: userLegacy.profile_image_url_https || '',
    isRetweet: Boolean(legacy.retweeted_status_result),
    // 回复：GraphQL 用 in_reply_to_* 表示，正文里不带「Replying to」
    isReply: Boolean(legacy.in_reply_to_status_id_str || legacy.in_reply_to_screen_name),
    replyTo: legacy.in_reply_to_screen_name || '',
    replyToStatusId: legacy.in_reply_to_status_id_str || '',
  };
}

/** 从返回的 timeline 里取出所有推文条目。 */
export function extractTimelineItems(json, screenName) {
  const instructions =
    json?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
    json?.data?.user?.result?.timeline?.timeline?.instructions ||
    [];
  const out = [];
  for (const ins of instructions) {
    for (const entry of ins.entries || []) {
      const content = entry.content;
      if (!content) continue;
      if (content.itemContent) {
        const item = xTweetToItem(content.itemContent, screenName);
        if (item) out.push(item);
      }
      for (const mod of content.items || []) {
        const item = xTweetToItem(mod.item?.itemContent, screenName);
        if (item) out.push(item);
      }
    }
  }
  return out;
}

export async function fetchXCookie(cfg, { request, logger, stateFile, meta }) {
  const client = new XCookieClient(cfg, { request, logger, stateFile });
  if (!client.enabled) {
    throw new Error('缺少 config.net.xCookie（浏览器里的 auth_token）');
  }

  const handle = String(cfg.x.handle || '').replace(/^@/, '');
  if (!handle) throw new Error('缺少 x.handle');

  const userId = cfg.x.userId || (await client.userId(handle));
  const json = await client.userTweets(userId, cfg.x.count || 20);
  let items = extractTimelineItems(json, handle);

  // 需要转发回复时，再拉一遍「推文+回复」的混合时间线，按 id 去重合并
  if (cfg.x.includeReplies) {
    try {
      const replyJson = await client.userReplies(userId, cfg.x.count || 20);
      const merged = new Map(items.map((it) => [it.id, it]));
      for (const it of extractTimelineItems(replyJson, handle)) {
        if (!merged.has(it.id)) merged.set(it.id, it);
      }
      items = [...merged.values()];
    } catch (err) {
      if (logger) logger.warn(`拉取回复时间线失败（只推主时间线）: ${err.message}`);
    }
  }

  if (meta && !meta.avatar) {
    const withAvatar = items.find((i) => i.avatar);
    if (withAvatar) meta.avatar = withAvatar.avatar;
  }
  if (!items.length) throw new Error('X 返回的时间线是空的');
  return items;
}
