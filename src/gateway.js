import { requestJson } from './http.js';
import { sleep } from './util.js';

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

/** GROUP_AND_C2C_EVENT：群/私聊消息与机器人进出群事件。 */
export const INTENTS_GROUP_AND_C2C = 1 << 25;

const HANDSHAKE_TIMEOUT_MS = 25_000;

/**
 * 监听 QQ 网关事件，自动收集机器人所在群的 group_openid。
 *
 * QQ 官方没有"列出机器人所在全部群"的接口，群 openid 只能从事件里拿：
 * - GROUP_ADD_ROBOT：机器人被拉进群（最可靠）
 * - GROUP_AT_MESSAGE_CREATE：群成员 @ 了机器人
 */
export class GroupWatcher {
  constructor({ cfg, logger, getToken, onAdd, onRemove, onReady, onMessage }) {
    this.cfg = cfg;
    this.logger = logger;
    this.getToken = getToken;
    this.onAdd = onAdd || (() => {});
    this.onRemove = onRemove || (() => {});
    this.onReady = onReady || (() => {});
    this.onMessage = onMessage || (() => {});
    this.ws = null;
    this.stopped = false;
  }

  get apiBase() {
    return (this.cfg.qq.apiBase || 'https://api.sgroup.qq.com').replace(/\/+$/, '');
  }

  start() {
    this.stopped = false;
    this.run().catch((err) => this.logger.error(`群事件监听退出: ${err.message}`));
  }

  stop() {
    this.stopped = true;
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
  }

  async run() {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        attempt = 0;
      } catch (err) {
        if (this.stopped) break;
        this.logger.warn(`群事件监听中断: ${err.message}`);
      }
      if (this.stopped) break;
      attempt = Math.min(attempt + 1, 6);
      await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    }
  }

  async connectOnce() {
    const token = await this.getToken();
    const { status, data } = await requestJson(`${this.apiBase}/gateway`, {
      headers: { authorization: `QQBot ${token}`, 'user-agent': 'x2qq/0.1' },
      timeoutMs: 15_000,
    });
    if (status !== 200 || !data?.url) {
      throw new Error(`获取网关地址失败: HTTP ${status} ${JSON.stringify(data).slice(0, 160)}`);
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(data.url);
      this.ws = ws;
      let seq = null;
      let heartbeatTimer = null;
      let ready = false;
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        clearTimeout(handshakeTimer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this.ws = null;
        if (err) reject(err);
        else resolve();
      };

      const handshakeTimer = setTimeout(() => {
        if (!ready) finish(new Error('网关握手超时'));
      }, HANDSHAKE_TIMEOUT_MS);

      const send = (payload) => {
        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          this.logger.warn(`发送网关数据失败: ${err.message}`);
        }
      };

      ws.addEventListener('open', () => {
        this.logger.debug('网关已连接，等待 HELLO');
      });

      ws.addEventListener('message', (event) => {
        let payload;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (payload.s !== undefined && payload.s !== null) seq = payload.s;

        switch (payload.op) {
          case OP.HELLO: {
            const interval = payload.d?.heartbeat_interval ?? 45_000;
            send({
              op: OP.IDENTIFY,
              d: {
                token: `QQBot ${token}`,
                intents: INTENTS_GROUP_AND_C2C,
                shard: [0, 1],
                properties: {},
              },
            });
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => send({ op: OP.HEARTBEAT, d: seq }), interval);
            break;
          }
          case OP.HEARTBEAT:
            send({ op: OP.HEARTBEAT, d: seq });
            break;
          case OP.HEARTBEAT_ACK:
            break;
          case OP.RECONNECT:
            finish(new Error('网关要求重连'));
            break;
          case OP.INVALID_SESSION:
            finish(new Error('网关 session 失效'));
            break;
          case OP.DISPATCH:
            this.handleDispatch(payload, () => {
              ready = true;
            });
            break;
          default:
            break;
        }
      });

      ws.addEventListener('error', () => finish(new Error('WebSocket 连接错误')));
      ws.addEventListener('close', (event) => {
        if (!this.stopped) {
          finish(new Error(`WebSocket 关闭 code=${event.code} ${event.reason || ''}`.trim()));
        } else {
          finish();
        }
      });
    });
  }

  handleDispatch(payload, markReady) {
    const type = payload.t;
    const d = payload.d || {};
    switch (type) {
      case 'READY':
        markReady();
        this.logger.info(`群事件监听已就绪 (session=${d.session_id || '-'})`);
        this.onReady();
        break;
      case 'RESUMED':
        markReady();
        this.logger.info('群事件监听已恢复');
        break;
      case 'GROUP_ADD_ROBOT':
        this.logger.info(`机器人被加入群: ${d.group_openid}`);
        this.onAdd(d.group_openid, { source: 'GROUP_ADD_ROBOT' });
        break;
      case 'GROUP_AT_MESSAGE_CREATE':
      case 'GROUP_MESSAGE_CREATE':
        Promise.resolve(
          this.onMessage(d.group_openid, {
            content: d.content || '',
            msgId: d.id,
            author: d.author?.member_openid || d.author?.id,
            type,
          }),
        ).catch((err) => this.logger.error(`处理群指令失败: ${err.message}`));
        break;
      case 'C2C_MESSAGE_CREATE':
        // 私聊：用 c2c: 前缀区分，后面统一走同一套指令逻辑
        Promise.resolve(
          this.onMessage(`c2c:${d.author?.user_openid || d.author?.id}`, {
            content: d.content || '',
            msgId: d.id,
            author: d.author?.user_openid || d.author?.id,
            type,
          }),
        ).catch((err) => this.logger.error(`处理私聊指令失败: ${err.message}`));
        break;
      case 'GROUP_DEL_ROBOT':
        this.logger.info(`机器人被移出群: ${d.group_openid}`);
        this.onRemove(d.group_openid);
        break;
      default:
        this.logger.info(`网关事件: ${type}`);
        break;
    }
  }
}
