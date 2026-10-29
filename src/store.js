import { readJson, writeJsonAtomic } from './util.js';

const MAX_SEEN = 5000;

const HEALTH_DEFAULTS = {
  lastPollAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  rounds: 0,
  sent: 0,
  failed: 0,
  accounts: {},
};

/** 群名单 + 已推送推文 id + 健康状态 的持久化存储。 */
export class Store {
  constructor(file) {
    this.file = file;
    this.groups = [];
    this.seen = [];
    this.seenSet = new Set();
    this.health = { ...HEALTH_DEFAULTS, accounts: {} };
  }

  async load() {
    const data = await readJson(this.file, null);
    if (data && typeof data === 'object') {
      this.groups = Array.isArray(data.groups) ? data.groups : [];
      this.seen = Array.isArray(data.seen) ? data.seen : [];
      this.health = {
        ...HEALTH_DEFAULTS,
        ...(data.health && typeof data.health === 'object' ? data.health : {}),
        accounts:
          data.health && typeof data.health.accounts === 'object' && data.health.accounts
            ? data.health.accounts
            : {},
      };
    }
    this.seenSet = new Set(this.seen);
    return this;
  }

  async save() {
    await writeJsonAtomic(this.file, {
      groups: this.groups,
      seen: this.seen,
      health: this.health,
      updatedAt: new Date().toISOString(),
    });
  }

  /** 一轮轮询结束后更新健康状态。 */
  recordRound({ sent = 0, failed = 0, error = null } = {}) {
    const now = new Date().toISOString();
    this.health.rounds += 1;
    this.health.lastPollAt = now;
    this.health.sent += sent;
    this.health.failed += failed;
    if (sent > 0) {
      this.health.lastSuccessAt = now;
      this.health.consecutiveFailures = 0;
    }
    if (failed > 0) {
      this.health.consecutiveFailures += 1;
      this.health.lastErrorAt = now;
      if (error) this.health.lastError = String(error).slice(0, 300);
    }
  }

  /** 单个账号的推送统计。 */
  recordAccount(accountKey, { sent = 0, failed = 0, error = null } = {}) {
    const prev = this.health.accounts[accountKey] || {
      sent: 0,
      failed: 0,
      lastSuccessAt: null,
      lastPollAt: null,
      lastError: null,
    };
    prev.lastPollAt = new Date().toISOString();
    prev.sent += sent;
    prev.failed += failed;
    if (sent > 0) prev.lastSuccessAt = prev.lastPollAt;
    if (error) prev.lastError = String(error).slice(0, 300);
    this.health.accounts[accountKey] = prev;
  }

  listGroups() {
    return this.groups;
  }

  hasGroup(openid) {
    return this.groups.some((g) => g.openid === openid);
  }

  addGroup(openid, meta = {}) {
    if (!openid) return false;
    const existing = this.groups.find((g) => g.openid === openid);
    if (existing) {
      const patch = { ...meta, lastSeenAt: new Date().toISOString() };
      if (patch.enabled === undefined) delete patch.enabled;
      Object.assign(existing, patch);
      return false;
    }
    this.groups.push({
      openid,
      name: meta.name || '',
      source: meta.source || 'event',
      enabled: meta.enabled === true,
      addedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
    return true;
  }

  /** 开关某个群的推送；群不存在时顺带登记。 */
  setEnabled(openid, enabled) {
    let group = this.groups.find((g) => g.openid === openid);
    if (!group) {
      this.addGroup(openid, { source: 'command', enabled: false });
      group = this.groups.find((g) => g.openid === openid);
    }
    const before = group.enabled === true;
    group.enabled = enabled === true;
    group.updatedAt = new Date().toISOString();
    return before !== group.enabled;
  }

  listEnabledGroups() {
    return this.groups.filter((g) => g.enabled !== false);
  }

  /**
   * 单个群里、单个账号的「回复 / 转贴」转发开关。
   * 默认都是开启，只有显式关过才记成 false。
   */
  setItemFlag(openid, accountKey, kind, on) {
    let group = this.groups.find((g) => g.openid === openid);
    if (!group) {
      this.addGroup(openid, { source: 'command', enabled: false });
      group = this.groups.find((g) => g.openid === openid);
    }
    group.itemFlags = group.itemFlags || {};
    const cur = group.itemFlags[accountKey] || {};
    const before = cur[kind] !== false;
    cur[kind] = on === true;
    group.itemFlags[accountKey] = cur;
    group.updatedAt = new Date().toISOString();
    return before !== cur[kind];
  }

  /** 读取某群某账号的开关，缺省视为开启。 */
  getItemFlags(openid, accountKey) {
    const group = this.groups.find((g) => g.openid === openid);
    const cur = group?.itemFlags?.[accountKey] || {};
    return {
      replies: cur.replies !== false,
      retweets: cur.retweets !== false,
    };
  }

  /** 群级别的「译文推送」开关。 */
  setTranslate(openid, on) {
    let group = this.groups.find((g) => g.openid === openid);
    if (!group) {
      this.addGroup(openid, { source: 'command', enabled: false });
      group = this.groups.find((g) => g.openid === openid);
    }
    const before = group.translate === true;
    group.translate = on === true;
    group.updatedAt = new Date().toISOString();
    return before !== group.translate;
  }

  isTranslateOn(openid) {
    const group = this.groups.find((g) => g.openid === openid);
    return group?.translate === true;
  }

  /** 订阅/退订某个账号；返回 true 表示状态有变化。 */
  setAccountSub(openid, accountKey, on) {
    const group = this.groups.find((g) => g.openid === openid);
    if (!group) return false;
    if (!Array.isArray(group.accounts)) group.accounts = [];
    const has = group.accounts.includes(accountKey);
    if (on && !has) group.accounts.push(accountKey);
    if (!on && has) group.accounts = group.accounts.filter((k) => k !== accountKey);
    group.updatedAt = new Date().toISOString();
    return on ? !has : has;
  }

  subscribedAccounts(openid) {
    const group = this.groups.find((g) => g.openid === openid);
    return Array.isArray(group?.accounts) ? group.accounts : [];
  }

  removeGroup(openid) {
    const before = this.groups.length;
    this.groups = this.groups.filter((g) => g.openid !== openid);
    return this.groups.length !== before;
  }

  hasSeen(key) {
    return this.seenSet.has(key);
  }

  markSeen(key) {
    if (!key || this.seenSet.has(key)) return false;
    this.seenSet.add(key);
    this.seen.push(key);
    if (this.seen.length > MAX_SEEN) {
      const drop = this.seen.length - MAX_SEEN;
      for (const old of this.seen.splice(0, drop)) this.seenSet.delete(old);
    }
    return true;
  }
}
