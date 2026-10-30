import { formatLocalTime, formatShortTime, truncate } from './util.js';
import { stripLeadingMentions } from './tweet.js';

/**
 * 把一条推文渲染成发到 QQ 群里的文本。
 * 默认 compact，尽量贴近 QQ 链接卡片的行文：名字 / 正文 / 查看原帖 / 时间。
 */
export function formatTweet(tweet, cfg) {
  const name = cfg.x.displayName || tweet.author || 'X';
  const compact = cfg.forward.compact !== false;
  const time = tweet.published
    ? compact
      ? formatShortTime(tweet.published, cfg.forward.timeZone)
      : formatLocalTime(tweet.published, cfg.forward.timeZone)
    : '';

  const marks = [];
  if (tweet.isReply) marks.push('回复');
  if (tweet.isRetweet) marks.push('转推');
  const mark = marks.length ? `（${marks.join('·')}）` : '';

  // 纯图片推文没有正文时不再塞占位文案，直接留空
  const rawBody = tweet.text?.trim() || '';
  const body = tweet.isReply ? stripLeadingMentions(rawBody) : rawBody;
  const linkLine =
    cfg.forward.includeLink !== false && tweet.link
      ? compact
        ? `查看原帖 ↗ ${tweet.link}`
        : `🔗 ${tweet.link}`
      : '';

  const parts = [];
  if (tweet.repostName) {
    parts.push(`⇄ ${tweet.repostName} 已转帖`);
    if (tweet.repostTime) {
      parts.push(`> 转帖于 ${formatLocalTime(tweet.repostTime, cfg.forward.timeZone)}`);
    }
    parts.push('');
  }
  if (compact) {
    parts.push(mark ? `${name} ${mark}` : name);
    if (body) parts.push('', body);
    if (linkLine) parts.push('', linkLine);
    if (time) parts.push(time);
  } else {
    parts.push(`【${name}】新推文`);
    if (time) parts.push(`🕒 ${time}`);
    if (mark) parts.push(mark);
    if (body) parts.push('', body);
    if (linkLine) parts.push('', linkLine);
  }

  return truncate(parts.join('\n'), cfg.forward.maxChars ?? 1200);
}

/** Ark 结构化卡片（模板 24：文本+缩略图），需要平台授予 Ark 权限。 */
export function buildArkCard(tweet, cfg, imageUrl) {
  const name = cfg.x.displayName || tweet.author || 'X';
  const time = tweet.published ? formatShortTime(tweet.published, cfg.forward.timeZone) : '';
  return {
    templateId: cfg.forward.arkTemplate ?? 24,
    kv: [
      { key: '#DESC#', value: `${name} 新推文` },
      { key: '#PROMPT#', value: '查看原帖' },
      { key: '#TITLE#', value: name },
      { key: '#METADESC#', value: truncate(tweet.text || '', 120) },
      { key: '#IMG#', value: imageUrl || '' },
      { key: '#LINK#', value: tweet.link || '' },
      { key: '#SUBTITLE#', value: time },
    ],
  };
}

/**
 * 推文正文里以 Markdown 语法字符开头的行会被解析成标题/列表/引用，
 * 这里在行首插一个零宽空格阻断语法（肉眼不可见）。
 */
export function escapeMarkdownText(text) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      // 行首 # 一律阻断（QQ 会把「#话题」当成标题加粗，即使后面没有空格）
      if (/^\s*#{1,6}/.test(line)) {
        return `\u200B${line}`;
      }
      if (/^\s*(>|[-*+]\s|\d+[.)]\s|`{3}|={2,}\s*$|-{3,}\s*$)/.test(line)) {
        return `\u200B${line}`;
      }
      return line;
    })
    .join('\n');
}

/** Markdown 卡片样式（模仿 QQ 推文卡片：头像+名字+徽章 / 正文 / 内嵌图 / 引用块页脚）。 */
export function formatTweetMarkdown(tweet, cfg, ctx = {}) {
  const name = ctx.name || cfg.x.displayName || tweet.author || 'X';
  const header = ctx.header || {};
  const images = Array.isArray(ctx.images) ? ctx.images : ctx.image ? [ctx.image] : [];

  // 头像与名字之间两个空格；认证徽章离名字近一点（一个空格）
  // 主推名字用一级标题 + 加粗，是全卡最大的元素
  let head = '# ';
  if (header.avatar) head += `![头像 #32px #32px](${header.avatar})  `;
  head += `**${name}**`;
  if (header.badge) head += ` ![认证 #16px #19px](${header.badge})`;

  const lines = [];
  if (ctx.repost) {
    // 横幅只放「谁转的」；转推时间另起一行用引用块缩进，避免一行太长
    lines.push(`## **⇄ ${ctx.repost.name} 已转帖**`);
    if (ctx.repost.time) {
      lines.push(`> 转帖于 ${formatLocalTime(ctx.repost.time, cfg.forward.timeZone)}`);
    }
    lines.push('');
  }

  // 回复类型：名字下一行标「↩ 回复 + 被回复人的昵称」
  const replyTo = ctx.replyTo || tweet.replyTo || '';
  const isReplyLike = !ctx.repost && (tweet.isReply || Boolean(replyTo));

  if (isReplyLike) {
    const target = ctx.replyContext?.name || replyTo;
    lines.push(head, target ? `**↩ 回复 ${target}**` : '**↩ 回复**', '');
  } else {
    lines.push(head, '');
  }

  if (tweet.isRetweet) lines.push('（转推）');

  const rawBody = tweet.text?.trim() || '';
  const originalBody = isReplyLike ? stripLeadingMentions(rawBody) : rawBody;
  const translatedText = String(ctx.translatedText || '').trim();
  const bodyText = translatedText || originalBody;
  if (bodyText) lines.push(escapeMarkdownText(bodyText));

  // 主推文配图：紧跟正文；多图之间不留空行（否则每张之间会有一道间隔）
  // QQ 的 Markdown 图片必须同时给宽高（#600px #400px），否则只显示 alt 文字
  images.forEach((img, index) => {
    if (!img?.url) return;
    const width = Math.round(img.width || 600);
    const height = Math.round(img.height || 400);
    // 有正文时图和正文之间空一行；纯图推文直接接在抬头下面，不留空行
    if (index === 0 && bodyText) lines.push('');
    lines.push(`![推文配图 #${width}px #${height}px](${img.url})`);
  });

  // 图片 / 视频放不进卡片时，卡片里留一行提示，稍后单独发
  const extras = [];
  if (ctx.videoCount > 0) extras.push(`🎬 视频共 ${ctx.videoCount} 段`);
  if (ctx.imageCount > 0) extras.push(`🖼 图片共 ${ctx.imageCount} 张`);
  if (extras.length) {
    lines.push('', `> ${extras.join('，')}，见下条消息`);
  }

  // 引用推文、被回复的原推都用 > 缩进，和主推区分开
  const blocks = [
    { block: ctx.replyContext, indent: true },
    { block: ctx.quote, indent: true },
  ].filter((x) => x.block);

  for (const { block: quote, indent } of blocks) {
    const qheadParts = [];
    if (quote.avatar) qheadParts.push(`![头像 #24px #24px](${quote.avatar})  `);
    // 引用推文 / 被回复原推的账号名：二级标题，和主推名字一样不加粗
    const qhead =
      '## ' +
      qheadParts.join('') +
      (quote.name || '引用推文') +
      (quote.badge ? ` ![认证 #14px #16px](${quote.badge})` : '');
    const inner = [qhead];
    // 引用推文的正文同样用译文（开启翻译时）
    const quoteText =
      quote === ctx.quote && ctx.translatedQuoteText
        ? String(ctx.translatedQuoteText)
        : quote.text || '';
    if (quoteText) {
      inner.push('');
      for (const line of escapeMarkdownText(quoteText).split('\n')) inner.push(line);
    }
    (quote.images || []).forEach((img, index) => {
      if (!img?.url) return;
      if (index === 0) inner.push('');
      inner.push(
        `![引用配图 #${Math.round(img.width || 520)}px #${Math.round(img.height || 300)}px](${img.url})`,
      );
    });
    const qmeta = [];
    if (quote.time) qmeta.push(formatLocalTime(new Date(quote.time), cfg.forward.timeZone));
    if (quote.link) qmeta.push(`[查看原帖 ↗](${quote.link})`);
    if (qmeta.length) {
      inner.push('');
      inner.push(qmeta.join('｜'));
    }

    lines.push('');
    for (const line of inner) {
      if (!indent) {
        lines.push(line);
      } else {
        lines.push(line ? `> ${line}` : '>');
      }
    }
  }

  // 页脚压成一行：一律用「推文本身的发布时间」，与 X 页面上显示的一致。
  // 转推时卡片展示的是原推内容，X 上也显示原推时间，所以不再用转推时间。
  if (translatedText) {
    // 紧贴在时间行上方，不缩进、不隔空行
    lines.push('', '由X自动翻译');
  }

  const meta = [];
  const stamp = tweet.published || ctx.repost?.time;
  if (stamp) meta.push(formatLocalTime(stamp, cfg.forward.timeZone));
  if (cfg.forward.includeLink !== false && tweet.link) {
    meta.push(`[查看原帖 ↗](${tweet.link})`);
  }
  if (meta.length) {
    // 翻译标记已经自带空行，这里不再重复空一行，让标记紧贴时间行
    if (!translatedText) lines.push('');
    lines.push(meta.join('｜'));
  }

  return truncate(lines.join('\n'), cfg.forward.maxMarkdownChars ?? 4000);
}
