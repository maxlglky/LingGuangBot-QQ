import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request, requestJson } from './http.js';
import { imageDimensions, sleep } from './util.js';

export class QQApiError extends Error {
  constructor(status, payload) {
    const code = payload?.code ?? status;
    const message = payload?.message || payload?.msg || `HTTP ${status}`;
    super(`QQ API ${status} [${code}] ${message}`);
    this.name = 'QQApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/** 单群发送节流：滑动窗口限每分钟，并限制每日总量。 */
export class GroupRateLimiter {
  constructor({ perMinute = 15, perDay = 200 } = {}) {
    this.perMinute = perMinute;
    this.perDay = perDay;
    this.state = new Map();
  }

  bucket(group) {
    let b = this.state.get(group);
    if (!b) {
      b = { minute: [], day: 0, dayStart: startOfDay() };
      this.state.set(group, b);
    }
    const today = startOfDay();
    if (b.dayStart !== today) {
      b.dayStart = today;
      b.day = 0;
    }
    return b;
  }

  /** 返回需要等待的毫秒数；0 表示可以立即发送（并已计入配额）。 */
  acquire(group) {
    const b = this.bucket(group);
    const now = Date.now();
    b.minute = b.minute.filter((t) => now - t < 60_000);

    if (b.day >= this.perDay) {
      throw new Error(`群 ${group} 今日推送已达上限 ${this.perDay} 条`);
    }
    if (b.minute.length >= this.perMinute) {
      return Math.max(1000, 60_000 - (now - b.minute[0]));
    }
    b.minute.push(now);
    b.day += 1;
    return 0;
  }
}

function startOfDay() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class QQClient {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.tokenCache = { value: null, expiresAt: 0 };
    this.limiter = new GroupRateLimiter(cfg.forward);
    this.mediaCache = new Map();
    this.headerCache = new Map();
    this.mediaCacheFile = cfg.statePath
      ? String(cfg.statePath).replace(/\.json$/i, '') + '.media.json'
      : null;
    // 素材缓存有效期：QQ 的素材库上限 100 张，超出会自动淘汰最旧的，
    // 被淘汰的 qqbot-media 链接就永久失效（群里表现是「加载中」/「加载失败」）。
    // 所以缓存不能永久有效，超过这个时长的缓存一律重新上传。0 = 不复用缓存。
    this.mediaCacheTtlMs = Math.max(0, Number(cfg.forward?.mediaCacheHours ?? 6) * 3600_000);
    this.mediaCacheLoaded = false;
  }

  get apiBase() {
    return (this.cfg.qq.apiBase || 'https://api.sgroup.qq.com').replace(/\/+$/, '');
  }

  get tokenBase() {
    return (this.cfg.qq.tokenBase || 'https://bots.qq.com').replace(/\/+$/, '');
  }

  async token(force = false) {
    const now = Date.now();
    if (!force && this.tokenCache.value && now < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.value;
    }
    const { status, data } = await requestJson(
      `${this.tokenBase}/app/getAppAccessToken`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appId: this.cfg.qq.appId,
          clientSecret: this.cfg.qq.appSecret,
        }),
        timeoutMs: 15_000,
      },
    );
    if (status !== 200 || !data?.access_token) {
      throw new Error(`获取 access_token 失败: HTTP ${status} ${JSON.stringify(data)}`);
    }
    this.tokenCache = {
      value: data.access_token,
      expiresAt: now + (data.expires_in ?? 7200) * 1000,
    };
    return this.tokenCache.value;
  }

  async api(method, path, body, { allowRetry = true } = {}) {
    const token = await this.token();
    const res = await request(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
        'x-union-appid': String(this.cfg.qq.appId),
        'user-agent': 'LingGuangBot-QQ/1.0',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 20_000,
    });

    let data = {};
    try {
      data = res.text ? JSON.parse(res.text) : {};
    } catch {
      data = { raw: res.text };
    }

    if (res.status >= 200 && res.status < 300) return data;

    const expired =
      res.status === 401 || data?.code === 11244 || /token/i.test(String(data?.message || ''));
    if (expired && allowRetry) {
      await this.token(true);
      return this.api(method, path, body, { allowRetry: false });
    }
    throw new QQApiError(res.status, data);
  }

  /**
   * 目标路径：群用 /v2/groups/{id}，私聊用 /v2/users/{id}。
   * 私聊的 openid 在库里以 "c2c:" 前缀保存。
   */
  targetPath(target, suffix) {
    const raw = String(target || '');
    const isC2C = raw.startsWith('c2c:');
    const id = isC2C ? raw.slice(4) : raw;
    return `/v2/${isC2C ? 'users' : 'groups'}/${id}/${suffix}`;
  }

  /** 发送群文本消息（msg_type=0）。 */
  async sendGroupText(groupOpenid, content, extra = {}) {
    return this.api('POST', this.targetPath(groupOpenid, 'messages'), {
      content,
      msg_type: 0,
      ...extra,
    });
  }

  /** 被动回复某条群消息（5 分钟内有效，不占用主动消息配额）。 */
  async sendGroupReply(groupOpenid, content, msgId, seq = 1) {
    return this.api('POST', this.targetPath(groupOpenid, 'messages'), {
      content,
      msg_type: 0,
      msg_id: msgId,
      msg_seq: seq,
    });
  }

  /** 发送群 Ark 结构化卡片（msg_type=3，需要平台授予 Ark 权限）。 */
  async sendGroupArk(groupOpenid, { templateId, kv }) {
    return this.api('POST', this.targetPath(groupOpenid, 'messages'), {
      content: ' ',
      msg_type: 3,
      ark: { template_id: templateId, kv },
    });
  }

  /**
   * 准备卡片头部素材（头像 + 认证徽章）。
   * avatarUrls 支持传多个候选，按顺序尝试，前面失败会退到下一个。
   */
  async prepareHeader({ avatarUrl, avatarUrls, badgePath }) {
    const out = { avatar: null, badge: null };
    const candidates = [
      ...(avatarUrls || []),
      ...(avatarUrl ? [avatarUrl] : []),
    ].filter(Boolean);

    const headerTtlMs = Math.max(0, (this.cfg.forward?.headerCacheHours ?? 2) * 3600_000);
    const freshHeader = (key) => {
      const hit = this.headerCache.get(key);
      if (!hit) return null;
      if (headerTtlMs && Date.now() - hit.at > headerTtlMs) {
        this.headerCache.delete(key);
        return null;
      }
      return hit.url;
    };

    for (const candidate of candidates) {
      const cachedAvatar = freshHeader(candidate);
      if (cachedAvatar) {
        out.avatar = cachedAvatar;
        break;
      }
      try {
        const local = await this.downloadImage(candidate);
        if (!local) continue;
        const uploaded = await this.uploadMarkdownImage(local.buffer, {
          ...imageMeta(local),
          // 头像每次进程启动重传一张新的：素材被回收后旧链接会失效（表现为头像空白），
          // 头像只有十几 KB，重传成本可以忽略。
          force: true,
        });
        this.headerCache.set(candidate, { url: uploaded.url, at: Date.now() });
        out.avatar = uploaded.url;
        break;
      } catch (err) {
        this.logger.warn(`头像上传失败（${candidate.slice(0, 60)}）: ${err.message}`);
      }
    }
    // 只想要徽章（没有给任何头像候选）时不该报「拿不到头像」
    if (!out.avatar && candidates.length > 0) {
      this.logger.warn('本条推送拿不到头像，卡片将不带头像');
    }

    if (badgePath) {
      const key = `file:${badgePath}`;
      const cachedBadge = freshHeader(key);
      if (cachedBadge) {
        out.badge = cachedBadge;
      } else {
        try {
          const buf = await readFile(badgePath);
          const uploaded = await this.uploadMarkdownImage(buf, {
            contentType: 'image/png',
            fileName: 'verified.png',
            // 同理：徽章也每次重传，避免引用已被回收的素材
            force: true,
          });
          this.headerCache.set(key, { url: uploaded.url, at: Date.now() });
          out.badge = uploaded.url;
        } catch {
          /* 没有徽章素材就不显示 */
        }
      }
    }

    return out;
  }

  /**
   * 图片是内嵌进卡片，还是单独发「图片消息」。
   * inline  = 内嵌（好看，但每张图占一张素材配额，100 张封顶）
   * message = 单独发（不占配额，图不会失效，但会另起气泡）
   * auto    = 素材库还宽裕就内嵌，快满了自动降级成单独发（默认，避免再撞 40035007）
   */
  async wantInlineImages(forward = this.cfg.forward || {}) {
    const mode =
      forward.imageMode || (forward.markdownImage === true ? 'inline' : 'message');
    if (mode === 'inline') return (this.lastInlineDecision = true);
    if (mode !== 'auto') return (this.lastInlineDecision = false);
    const total = await this.mediaTotal().catch(() => 0);
    const limit = forward.mediaInlineUntil ?? 80;
    return (this.lastInlineDecision = total < limit);
  }

  /** 读素材库当前张数（带缓存，避免每条推送都打一次列表接口）。 */
  async mediaTotal({ maxAgeMs = 5 * 60_000 } = {}) {
    if (this.mediaTotalCache && Date.now() - this.mediaTotalCache.at < maxAgeMs) {
      return this.mediaTotalCache.total;
    }
    const list = await this.api('GET', '/v2/media-images');
    const total = Number(list?.total || 0);
    this.mediaTotalCache = { total, at: Date.now() };
    return total;
  }

  /**
   * 素材管理是 100 张的硬上限：满了以后 `prepare` 直接报
   * 40035007 markdown image quota exceeded，之后所有的图（连头像）都传不上去。
   *
   * 列表接口一页只返回 20 条、`offset/limit/page` 全都不生效，看不到真正最旧的那些，
   * 所以只能“回收”看得到的这 20 条里的旧图：保留最新 mediaPruneKeepNewest 条，
   * 其余按时间从旧到新删，腾出配额。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.force] 配额已经爆了时无视阈值、立刻回收
   * @returns {Promise<number>} 实际删掉几张
   */
  async pruneMediaIfNeeded({ force = false } = {}) {
    const threshold = this.cfg.forward?.mediaPruneAt ?? 88;
    const keep = this.cfg.forward?.mediaKeep ?? 70;
    const keepNewest = Math.max(0, this.cfg.forward?.mediaPruneKeepNewest ?? 4);
    // 平时 5 分钟最多查一次，避免每条推送都打一次列表接口；配额爆了则立刻回收
    const cooldown = force ? 0 : 5 * 60_000;
    if (this.mediaPrunedAt && Date.now() - this.mediaPrunedAt < cooldown) return 0;
    this.mediaPrunedAt = Date.now();

    try {
      const list = await this.api('GET', '/v2/media-images');
      const total = Number(list?.total || 0);
      if (!force && total < threshold) return 0;

      const images = (list.images || [])
        .slice()
        .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
      if (images.length <= keepNewest) return 0;
      // 只动“看得到的最旧那批”，最新的 keepNewest 条永远保留
      const deletable = images.slice(0, images.length - keepNewest);
      // 目标是降到 keep 以下；配额爆掉时同样按这个目标回收，别把库删空
      const wantFree = Math.max(0, total - keep);
      if (!wantFree) return 0;

      const deletedUrls = new Set();
      let removed = 0;
      for (const img of deletable) {
        if (removed >= wantFree) break;
        try {
          await this.api('DELETE', `/v2/media-images/${img.image_id}/delete`);
          if (img.url) deletedUrls.add(img.url);
          removed += 1;
        } catch (err) {
          this.logger.debug(`素材删除失败（${img.image_id}）: ${err.message}`);
        }
      }
      if (!removed) return 0;
      this.mediaTotalCache = { total: Math.max(0, total - removed), at: Date.now() };

      // 只丢掉被删掉的那几条缓存，其余的继续复用（别为了清缓存把整库重传一遍）
      let cacheChanged = false;
      for (const [key, value] of [...this.mediaCache]) {
        if (deletedUrls.has(value?.url)) {
          this.mediaCache.delete(key);
          cacheChanged = true;
        }
      }
      for (const [key, value] of [...this.headerCache]) {
        if (deletedUrls.has(value?.url)) this.headerCache.delete(key);
      }
      if (cacheChanged) await this.saveMediaCache().catch(() => {});

      this.logger.info(`素材回收：库内 ${total} 张，删了 ${removed} 张旧的，腾出配额`);
      return removed;
    } catch (err) {
      this.logger.warn(`素材回收失败: ${err.message}`);
      return 0;
    }
  }

  /** 批量准备内嵌图片（下载 → 素材上传 → 带真实尺寸），返回 Markdown 可用的数组。 */
  async prepareInlineImages(photos = [], { maxWidth = 600, limit = 6, concurrency = 4 } = {}) {
    const slice = photos.slice(0, limit);
    if (!slice.length) return [];

    const results = new Array(slice.length).fill(null);
    let cursor = 0;

    // 并发下载+上传，单条推文的多图处理从 ~60s 降到 ~20s
    const worker = async () => {
      while (cursor < slice.length) {
        const index = cursor;
        cursor += 1;
        const photo = slice[index];
        try {
          const local = await this.downloadImage(photo.url);
          if (!local) continue;
          const uploaded = await this.uploadMarkdownImage(local.buffer, imageMeta(local));
          const dims =
            imageDimensions(local.buffer) ||
            { width: photo.width || 600, height: photo.height || 400 };
          const scale = dims.width > maxWidth ? maxWidth / dims.width : 1;
          results[index] = {
            url: uploaded.url,
            width: Math.max(1, Math.round(dims.width * scale)),
            height: Math.max(1, Math.round(dims.height * scale)),
          };
        } catch (err) {
          this.logger.warn(`图片处理失败: ${err.message}`);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()),
    );
    return results.filter(Boolean);
  }

  /** 准备引用推文的缩进块素材（imageMode=message 时不准备图片，改走图片消息）。 */
  async prepareQuote(quote, { maxWidth = 520, limit = 2, photos = true } = {}) {
    if (!quote) return null;
    let avatar = null;
    if (quote.authorAvatar) {
      const header = await this.prepareHeader({ avatarUrl: quote.authorAvatar }).catch(() => null);
      avatar = header?.avatar || null;
    }
    let badge = null;
    if (quote.verified && this.cfg.forward.verifiedBadge !== false) {
      const header = await this
        .prepareHeader({ badgePath: this.cfg.forward.verifiedBadgePath })
        .catch(() => null);
      badge = header?.badge || null;
    }
    const images = photos
      ? await this.prepareInlineImages(quote.photos || [], { maxWidth, limit })
      : [];
    return {
      avatar,
      badge,
      name: quote.author,
      text: quote.text,
      images,
      link: quote.url,
      time: quote.createdAt,
    };
  }

  /** 发送群 Markdown 消息（msg_type=2）。 */
  async sendGroupMarkdown(groupOpenid, content, extra = {}) {
    return this.api('POST', this.targetPath(groupOpenid, 'messages'), {
      content: ' ',
      msg_type: 2,
      markdown: { content },
      ...extra,
    });
  }

  /**
   * 把图片上传到「素材管理」，返回 qqbot-media:// 引用（可在 Markdown 里直接用）。
   * 同一张图（md5 相同）在本进程内只上传一次。
   */
  async uploadMarkdownImage(
    buffer,
    { contentType = 'image/jpeg', fileName = 'image.jpg', force = false, ttlHours } = {},
  ) {
    await this.loadMediaCache();
    const md5 = createHash('md5').update(buffer).digest('hex');
    const cached = this.mediaCache.get(md5);
    // force=true 时忽略缓存重新上传。
    // 缓存带时效：过期的链接可能已经被回收，继续用就是「加载中」。
    // 头像这类长期不变的图可以传更长的 ttlHours，省配额。
    if (cached && !force) {
      const ttlMs =
        ttlHours === undefined ? this.mediaCacheTtlMs : Math.max(0, Number(ttlHours) * 3600_000);
      const fresh = ttlMs > 0 && Date.now() - Number(cached.at || 0) <= ttlMs;
      if (fresh) return { url: cached.url, previewUrl: cached.previewUrl || null };
      this.mediaCache.delete(md5);
    }

    await this.pruneMediaIfNeeded();

    try {
      return await this.doUploadMarkdownImage(buffer, { md5, contentType, fileName });
    } catch (err) {
      // 40035007 = 素材配额爆了，回收一批旧素材后再试一次
      if (Number(err?.code) !== 40035007) throw err;
      const freed = await this.pruneMediaIfNeeded({ force: true });
      if (!freed) throw err;
      return this.doUploadMarkdownImage(buffer, { md5, contentType, fileName });
    }
  }

  /** 真正走「prepare → PUT → complete」的那段，配额不足时会被重试一次。 */
  async doUploadMarkdownImage(buffer, { md5, contentType, fileName }) {
    const sha1 = createHash('sha1').update(buffer).digest('hex');
    const prep = await this.api('POST', '/v2/media-images/prepare', {
      file_name: fileName,
      file_size: buffer.length,
      content_type: contentType,
      md5,
      sha1,
    });
    if (!prep?.presigned_url || !prep?.upload_id) {
      throw new Error(`素材上传 prepare 返回异常: ${JSON.stringify(prep).slice(0, 160)}`);
    }

    const put = await request(prep.presigned_url, {
      method: 'PUT',
      body: buffer,
      headers: { 'content-type': contentType },
      timeoutMs: 90_000,
    });
    if (put.status < 200 || put.status >= 300) {
      throw new Error(`素材图片直传失败 HTTP ${put.status}`);
    }

    const etag = String(put.headers.etag || '').replace(/"/g, '') || md5;
    const done = await this.api('POST', '/v2/media-images/complete', {
      upload_id: prep.upload_id,
      md5: etag,
    });
    const url = done?.url;
    if (!url) throw new Error('素材上传 complete 未返回 url');
    this.mediaCache.set(md5, {
      url,
      previewUrl: done?.preview_url || null,
      at: Date.now(),
    });
    this.trimMediaCache();
    await this.saveMediaCache();
    return { url, previewUrl: done?.preview_url || null };
  }

  /** 缓存别无限增长：超过 300 条就丢掉最旧的。 */
  trimMediaCache(max = 300) {
    if (this.mediaCache.size <= max) return;
    const entries = [...this.mediaCache.entries()].sort(
      (a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0),
    );
    for (const [key] of entries.slice(0, this.mediaCache.size - max)) this.mediaCache.delete(key);
  }

  /** 素材图片缓存（QQ 单机器人上限 100 张，避免重复上传）。 */
  async loadMediaCache() {
    if (this.mediaCacheLoaded) return;
    this.mediaCacheLoaded = true;
    if (!this.mediaCacheFile) return;
    try {
      const data = JSON.parse(await readFile(this.mediaCacheFile, 'utf8'));
      for (const [key, value] of Object.entries(data)) {
        // 老格式是纯字符串（没有时间戳）：不知道什么时候传的，一律当过期，下次重传
        if (typeof value === 'string') {
          this.mediaCache.set(key, { url: value, previewUrl: null, at: 0 });
        } else if (value?.url) {
          this.mediaCache.set(key, {
            url: value.url,
            previewUrl: value.previewUrl || null,
            at: Number(value.at || 0),
          });
        }
      }
    } catch {
      /* 首次运行没有缓存文件 */
    }
  }

  async saveMediaCache() {
    if (!this.mediaCacheFile) return;
    try {
      await writeFile(
        this.mediaCacheFile,
        JSON.stringify(Object.fromEntries(this.mediaCache), null, 2),
        'utf8',
      );
    } catch {
      /* 缓存写失败不影响发送 */
    }
  }

  /** 以 URL 方式上传群图片，返回 file_info（要求 QQ 侧能下载该 URL）。 */
  async uploadGroupImage(groupOpenid, imageUrl) {
    const data = await this.api('POST', this.targetPath(groupOpenid, 'files'), {
      file_type: 1,
      url: imageUrl,
      srv_send_msg: false,
    });
    const info = data?.file_info;
    if (!info) throw new Error('图片上传未返回 file_info');
    return info;
  }

  /** 先把图片下载到本地（可走代理），再分片上传——绕开 QQ 侧下载不了的情况。 */
  async downloadImage(url) {
    const proxy = this.cfg.net?.proxy || undefined;
    const candidates = [url];
    if (url.includes('?')) candidates.push(url.split('?')[0]);
    for (const candidate of candidates) {
      try {
        const res = await request(candidate, {
          proxy,
          timeoutMs: 25_000,
          maxBytes: 10 * 1024 * 1024,
        });
        if (res.status === 200 && res.body.length) {
          const name = (candidate.split('/').pop() || 'image.jpg').split('?')[0] || 'image.jpg';
          return { buffer: res.body, name };
        }
      } catch {
        /* 换下一个候选 */
      }
    }
    return null;
  }

  /** 分片上传本地文件，返回 file_info（fileType: 1 图片 / 2 视频 / 3 语音 / 4 文件）。 */
  async uploadGroupFileBuffer(groupOpenid, buffer, fileName = 'file.bin', fileType = 1) {
    const md5 = createHash('md5').update(buffer).digest('hex');
    const sha1 = createHash('sha1').update(buffer).digest('hex');
    const md5_10m = createHash('md5').update(buffer.subarray(0, 10_002_432)).digest('hex');

    const prep = await this.api('POST', this.targetPath(groupOpenid, 'upload_prepare'), {
      file_type: fileType,
      file_name: fileName,
      file_size: buffer.length,
      md5,
      sha1,
      md5_10m,
    });

    const uploadId = prep?.upload_id;
    const blockSize = Number(prep?.block_size || 0);
    const parts = Array.isArray(prep?.parts) ? prep.parts : [];
    if (!uploadId || !blockSize || !parts.length) {
      throw new Error(`upload_prepare 返回异常: ${JSON.stringify(prep).slice(0, 160)}`);
    }

    for (const part of parts) {
      const offset = (part.index - 1) * blockSize;
      const chunk = buffer.subarray(offset, Math.min(offset + blockSize, buffer.length));
      const putRes = await request(part.presigned_url, {
        method: 'PUT',
        body: chunk,
        timeoutMs: 60_000,
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (putRes.status < 200 || putRes.status >= 300) {
        throw new Error(`分片 ${part.index} 上传失败 HTTP ${putRes.status}`);
      }
      await this.api('POST', this.targetPath(groupOpenid, 'upload_part_finish'), {
        upload_id: uploadId,
        part_index: part.index,
        block_size: chunk.length,
        md5: createHash('md5').update(chunk).digest('hex'),
      });
    }

    const done = await this.api('POST', this.targetPath(groupOpenid, 'files'), { upload_id: uploadId });
    const info = done?.file_info;
    if (!info) throw new Error('完成上传未返回 file_info');
    return info;
  }

  /** 分片上传本地图片（file_type=1）。 */
  async uploadGroupImageBuffer(groupOpenid, buffer, fileName = 'image.jpg') {
    return this.uploadGroupFileBuffer(groupOpenid, buffer, fileName, 1);
  }

  /** 下载任意二进制（可走代理），默认上限 40MB。 */
  async downloadBinary(input, { maxBytes = 100 * 1024 * 1024, timeoutMs = 180_000 } = {}) {
    const proxy = this.cfg.net?.proxy || undefined;
    const list = Array.isArray(input) ? input : [input];
    const candidates = [];
    for (const url of list.filter(Boolean)) {
      candidates.push(url);
      if (url.includes('?')) candidates.push(url.split('?')[0]);
    }
    for (const candidate of candidates) {
      try {
        const res = await request(candidate, { proxy, timeoutMs, maxBytes });
        if (res.status === 200 && res.body.length) {
          const name = (candidate.split('/').pop() || 'file').split('?')[0] || 'file';
          return { buffer: res.body, name };
        }
      } catch {
        /* 换下一个候选 */
      }
    }
    return null;
  }

  /** 发送群富媒体消息（msg_type=7），content 会作为同一条消息里的文字显示。 */
  async sendGroupMedia(groupOpenid, fileInfo, content = ' ', extra = {}) {
    return this.api('POST', this.targetPath(groupOpenid, 'messages'), {
      content: content || ' ',
      msg_type: 7,
      media: { file_info: fileInfo },
      ...extra,
    });
  }

  /** 把一条推文发到指定群：Markdown 卡片优先，失败退回纯文本。 */
  async deliver(groupOpenid, text, imageUrls = [], opts = {}) {
    const wait = this.limiter.acquire(groupOpenid);
    if (wait > 0) await sleep(wait);

    const result = { text: false, images: 0, errors: [], markdown: false, ark: false };
    // 被动回复（5 分钟内有效，不占主动消息配额）：带上 msg_id 与递增的 msg_seq
    const replyExtra = opts.replyTo
      ? { msg_id: opts.replyTo.msgId, msg_seq: opts.replyTo.seq ?? 1 }
      : {};

    // 图文同条：把文字放进富媒体消息的 content 里
    if (opts.style === 'media' && imageUrls.length && opts.sendImages !== false) {
      try {
        const first = imageUrls[0];
        const local = await this.downloadImage(first);
        const info = local
          ? await this.uploadGroupImageBuffer(groupOpenid, local.buffer, local.name)
          : await this.uploadGroupImage(groupOpenid, first);
        await this.sendGroupMedia(groupOpenid, info, text);
        result.text = true;
        result.images = 1;
        result.styleUsed = 'media';
        return result;
      } catch (err) {
        result.errors.push(`图文: ${err.message}`);
        // 失败退回纯文本
      }
    }

    // 图文同条（imageMode=media）：文字和第一张图放进同一条图片消息里，
    // 不占素材库配额，但正文只能是纯文本，卡片样式用不了。
    if (opts.imageMode === 'media' && opts.sendImages !== false) {
      const photos = [
        ...(opts.photos && opts.photos.length ? opts.photos : imageUrls.map((url) => ({ url }))),
        ...(opts.quotePhotos || []),
      ].slice(0, opts.maxImages ?? 6);
      if (photos.length) {
        try {
          const first = photos[0];
          const local = await this.downloadImage(first.url);
          const info = local
            ? await this.uploadGroupImageBuffer(groupOpenid, local.buffer, local.name)
            : await this.uploadGroupImage(groupOpenid, first.url);
          await this.sendGroupMedia(groupOpenid, info, text, replyExtra);
          result.text = true;
          result.styleUsed = 'media';
          result.images = 1;

          let seq = opts.replyTo ? (opts.replyTo.seq ?? 1) + 1 : 0;
          for (const photo of photos.slice(1)) {
            const extra = !seq ? {} : seq > 5 ? null : { msg_id: opts.replyTo.msgId, msg_seq: seq };
            if (extra === null) break;
            if (seq) seq += 1;
            try {
              const l = await this.downloadImage(photo.url);
              const fi = l
                ? await this.uploadGroupImageBuffer(groupOpenid, l.buffer, l.name)
                : await this.uploadGroupImage(groupOpenid, photo.url);
              await this.sendGroupMedia(groupOpenid, fi, ' ', extra);
              result.images += 1;
            } catch (err) {
              result.errors.push(`图片: ${err.message}`);
            }
          }
          return result;
        } catch (err) {
          result.errors.push(`图文: ${err.message}`);
          // 失败继续走卡片
        }
      }
    }

    if (opts.style === 'ark' && typeof opts.arkBuilder === 'function') {
      try {
        let imageUrl = null;
        const first = imageUrls[0];
        if (first) {
          const local = await this.downloadImage(first);
          if (local) {
            const uploaded = await this.uploadMarkdownImage(local.buffer, imageMeta(local));
            // Ark 的 #IMG# 需要公网可访问 URL，优先用素材上传返回的临时预览链接
            imageUrl = uploaded.previewUrl || uploaded.url;
          }
        }
        const card = opts.arkBuilder(imageUrl);
        await this.sendGroupArk(groupOpenid, card);
        result.text = true;
        result.ark = true;
        result.images = imageUrl ? 1 : 0;
        return result;
      } catch (err) {
        result.errors.push(`Ark: ${err.message}`);
        // 没有 Ark 权限时继续走纯文本兜底
      }
    }

    if (opts.style === 'markdown' && typeof opts.markdownBuilder === 'function') {
      try {
        const wantInline = opts.markdownImage === true;
        const photos =
          opts.photos && opts.photos.length ? opts.photos : imageUrls.map((url) => ({ url }));
        const limit = Math.min(opts.maxImages ?? 4, photos.length);
        const images = [];

        if (wantInline && opts.sendImages !== false) {
          images.push(
            ...(await this.prepareInlineImages(photos, {
              maxWidth: opts.markdownMaxWidth ?? 600,
              limit,
            })),
          );
        }

        // 不走内嵌时，图片单独作为「图片消息」发出去：不占素材库配额，
        // 也就不会因为素材被回收而变成「加载失败」。
        // 被动回复最多 5 条（卡片占 1 条），所以最多再跟 4 张图。
        const passiveCap = opts.replyTo ? 4 : Number.POSITIVE_INFINITY;
        const mediaQueue =
          !wantInline && opts.sendImages !== false
            ? [
                ...photos.slice(0, limit),
                ...(opts.quotePhotos || []).slice(0, opts.maxQuoteImages ?? 2),
              ].slice(0, passiveCap)
            : [];

        await this.sendGroupMarkdown(
          groupOpenid,
          opts.markdownBuilder({
            images,
            imageCount: mediaQueue.length,
            header: opts.header || null,
            quote: opts.quote || null,
            name: opts.name,
            repost: opts.repost || null,
            videoCount: opts.videos?.length || 0,
          }),
          replyExtra,
        );
        result.text = true;
        result.markdown = true;
        result.images = images.length;

        // 卡片占了 seq = replyTo.seq，后面的图片消息要接着往后排（最多到 5）
        let seq = opts.replyTo ? (opts.replyTo.seq ?? 1) + 1 : 0;
        const nextExtra = () => {
          if (!seq) return {};
          if (seq > 5) return null; // 被动回复最多 5 条
          const extra = { msg_id: opts.replyTo.msgId, msg_seq: seq };
          seq += 1;
          return extra;
        };

        for (const photo of mediaQueue) {
          const extra = nextExtra();
          if (!extra) break;
          try {
            const local = await this.downloadImage(photo.url);
            const info = local
              ? await this.uploadGroupImageBuffer(groupOpenid, local.buffer, local.name)
              : await this.uploadGroupImage(groupOpenid, photo.url);
            await this.sendGroupMedia(groupOpenid, info, ' ', extra);
            result.images += 1;
          } catch (err) {
            result.errors.push(`图片: ${err.message}`);
          }
        }

        // 视频：Markdown 不能内嵌，单独作为视频消息发送
        if (opts.videos && opts.videos.length) {
          try {
            const video = opts.videos[0];
            // 按码率从低到高逐个尝试，避免高码率 1080p 超出大小限制
            // 从最高码率开始试，超限/失败再降到下一档
            const ordered = [...(video.variants || [])].sort(
              (a, b) => (b.bitrate || 0) - (a.bitrate || 0),
            );
            const urls = [...new Set([...ordered.map((v) => v.url), video.url])].filter(Boolean);
            const local = await this.downloadBinary(urls, {
              maxBytes: opts.maxVideoBytes ?? 100 * 1024 * 1024,
            });
            if (!local) throw new Error('视频下载失败');
            const info = await this.uploadGroupFileBuffer(groupOpenid, local.buffer, local.name, 2);
            const videoExtra = nextExtra();
            if (videoExtra) await this.sendGroupMedia(groupOpenid, info, '🎬 视频', videoExtra);
            result.videos = 1;
          } catch (err) {
            result.errors.push(`视频: ${err.message}`);
          }
        }

        return result;
      } catch (err) {
        result.errors.push(`卡片: ${err.message}`);
        // 继续走纯文本兜底
      }
    }

    try {
      await this.sendGroupText(groupOpenid, text, replyExtra);
      result.text = true;
    } catch (err) {
      result.errors.push(`文本: ${err.message}`);
      // 频控（22009）与主动消息无权限（40034105）交给上层统一处理
      if (err instanceof QQApiError && (err.code === 22009 || err.code === 40034105)) throw err;
      return result;
    }

    if (opts.sendImages && imageUrls.length) {
      const limit = Math.min(opts.maxImages ?? 1, imageUrls.length);
      for (const url of imageUrls.slice(0, limit)) {
        try {
          // 优先：本地下载（可走代理）后分片上传；失败再退回 URL 上传
          const local = await this.downloadImage(url);
          const info = local
            ? await this.uploadGroupImageBuffer(groupOpenid, local.buffer, local.name)
            : await this.uploadGroupImage(groupOpenid, url);
          await this.sendGroupMedia(groupOpenid, info);
          result.images += 1;
        } catch (err) {
          result.errors.push(`图片: ${err.message}`);
          break;
        }
      }
    }

    return result;
  }
}

function guessContentType(name = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/** 从字节头判断真实图片类型（QQ 素材接口要求扩展名与 content-type 一致）。 */
function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** 根据真实字节决定 content-type 和带正确扩展名的文件名。 */
function imageMeta(local) {
  const contentType = sniffImageType(local.buffer) || guessContentType(local.name);
  const ext = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
  const base = String(local.name || 'image').replace(/\.[^.]+$/, '') || 'image';
  return { contentType, fileName: `${base}.${ext}`, ext };
}
