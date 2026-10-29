/**
 * 推文对象的规范化与去重键。
 *
 * 数据源现在只有 X（cookie / GraphQL），这里保留少量与来源无关的工具函数：
 * 各 provider 把原始数据整理成 { id, text, link, published, images... }，
 * 再经 toTweet() 统一成内部结构。
 */
import { truncate } from './util.js';

const RETWEET_RE = /^(?:RT\b|RT\s|转推|Retweeted\b|Reposted\b)/i;
const REPLY_RE = /(Replying to\s+@|回复\s*@|in reply to)/i;

export function toTweet(item, cfg = {}) {
  const raw = item.raw || '';
  const combined = `${item.title || ''}\n${item.text || ''}`;
  const isRetweet =
    RETWEET_RE.test((item.title || '').trim()) ||
    /^(?:RT\s+@|RT\b)/i.test((item.text || '').trim()) ||
    /<twitter:retweet/i.test(raw);

  const isReply =
    item.isReply === true ||
    REPLY_RE.test(combined) ||
    /in-reply-to|thr:in-reply-to|<tweet[^>]*in_reply_to/i.test(raw) ||
    /Replying to/i.test(item.contentHtml || '');

  let text = (item.text || '').trim();
  if (!text && item.title) text = item.title.trim();
  if (
    item.title &&
    item.text &&
    item.title.length > item.text.length &&
    !/Replying to/i.test(item.title)
  ) {
    text = item.title.trim();
  }

  const link = (item.link || '').trim();
  const published = item.published ? safeDate(item.published) : undefined;

  return {
    id: String(item.id || link || '').trim(),
    text: truncate(text.replace(/\n{3,}/g, '\n\n'), 2000),
    title: item.title || '',
    link,
    author: cfg.displayName || item.author || '',
    images: item.images || [],
    published,
    isRetweet,
    isReply,
    replyTo: item.replyTo || '',
    replyToStatusId: item.replyToStatusId || '',
  };
}

function safeDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * X 客户端展示回复时不显示开头的「@某人」，这里保持一致把它剥掉。
 * 只处理行首连续出现的 mention，正文中间的 @ 不动。
 */
export function stripLeadingMentions(text) {
  return String(text || '')
    .replace(/^(?:\s*@[A-Za-z0-9_]{1,15})+[\s\u3000]*/, '')
    .trimStart();
}

export function dedupeKey(tweet) {
  if (tweet.link) {
    const m = tweet.link.match(/status\/(\d+)/);
    if (m) return `x:${m[1]}`;
    return `u:${tweet.link}`;
  }
  return `i:${tweet.id}`;
}
