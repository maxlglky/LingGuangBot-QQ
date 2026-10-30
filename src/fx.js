import { request } from './http.js';

/** 拉取单条推文的完整信息（正文、时间、全部图片、视频直链）。 */
export async function fetchTweetDetail(id) {
  if (!id) return null;
  const url = `https://api.fxtwitter.com/i/status/${id}`;
  const res = await request(url, {
    timeoutMs: 15000,
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
  });
  if (res.status !== 200) return null;

  let tweet;
  try {
    tweet = JSON.parse(res.text)?.tweet;
  } catch {
    return null;
  }
  if (!tweet) return null;

  const all = tweet.media?.all || [];
  const photos = all
    .filter((m) => m?.type === 'photo' && m.url)
    .map((m) => ({ url: m.url, width: m.width, height: m.height }));

  const videos = all
    .filter((m) => m?.type === 'video' || m?.type === 'gif')
    .map((m) => {
      const variants = (m.variants || [])
        .filter((v) => /\.mp4/i.test(v.url || ''))
        .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))
        .map((v) => ({ url: v.url, bitrate: v.bitrate || 0 }));
      return {
        url: m.url || variants[variants.length - 1]?.url,
        variants,
        thumbnail: m.thumbnail_url,
        width: m.width,
        height: m.height,
        duration: m.duration,
      };
    })
    .filter((v) => v.url);

  return {
    id: String(tweet.id || id),
    text: tweet.text || '',
    createdAt: tweet.created_at || '',
    author: tweet.author?.name || '',
    screenName: tweet.author?.screen_name || '',
    authorAvatar: tweet.author?.avatar_url || '',
    authorVerified: Boolean(tweet.author?.verification?.verified),
    // 这条 id 本身如果是「转推」，这里是被谁转的
    repostedBy: tweet.reposted_by
      ? {
          name: tweet.reposted_by.name || '',
          screenName: tweet.reposted_by.screen_name || '',
          avatarUrl: tweet.reposted_by.avatar_url || '',
        }
      : null,
    url: tweet.url || `https://x.com/i/status/${id}`,
    photos,
    videos,
    quote: tweet.quote ? normalizeQuote(tweet.quote) : null,
    replyTo: tweet.replying_to || '',
    replyToStatusId: tweet.replying_to_status || '',
  };
}

function normalizeQuote(q) {
  const all = q.media?.all || [];
  return {
    id: String(q.id || ''),
    url: q.url || '',
    text: q.text || '',
    createdAt: q.created_at || '',
    author: q.author?.name || q.author?.screen_name || '',
    authorAvatar: q.author?.avatar_url || '',
    verified: Boolean(q.author?.verification?.verified),
    photos: all
      .filter((m) => m?.type === 'photo' && m.url)
      .map((m) => ({ url: m.url, width: m.width, height: m.height })),
  };
}

/** 把「转推」解析成「原推内容 + 转推人/时间」，供渲染层使用。 */
export function resolveRepost(tweet, detail, cfg = {}) {
  if (!tweet?.isRetweet || !detail) return { displayTweet: tweet, repost: null };
  const m =
    (tweet.title || '').match(/^RT by @([^:\s]+)/i) || (tweet.title || '').match(/^RT @([^:\s]+)/i);
  const who = cfg.x?.displayName || (m ? m[1] : '对方');
  return {
    repost: { name: who, time: tweet.published },
    displayTweet: {
      id: detail.id,
      text: detail.text,
      link: detail.url,
      published: detail.createdAt ? new Date(detail.createdAt) : undefined,
      images: (detail.photos || []).map((p) => p.url),
      isReply: Boolean(detail.replyToStatusId),
      isRetweet: false,
      repostName: who,
      repostTime: tweet.published,
      // 转推的如果是一条「回复」，原推上下文也要带过去
      replyTo: detail.replyTo || '',
      replyToStatusId: detail.replyToStatusId || '',
    },
  };
}

/**
 * 用 FxTwitter 的公开 API 补全推文媒体。
 * 返回所有图片（含真实宽高）和视频（mp4 直链）。
 * 该接口国内可直连，不需要走代理。
 */
export async function fetchTweetMedia(id) {
  const detail = await fetchTweetDetail(id);
  if (!detail) return null;
  return {
    photos: detail.photos,
    videos: detail.videos,
    text: detail.text,
    authorAvatar: detail.authorAvatar,
  };
}
