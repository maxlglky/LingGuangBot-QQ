import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

const MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15000;

const agentCache = new Map();

/**
 * 为 HTTPS 请求创建一个走 HTTP CONNECT 隧道的 Agent。
 * 只影响本进程的请求，不会修改系统代理设置。
 */
function tunnelAgent(proxyUrl) {
  const cached = agentCache.get(proxyUrl);
  if (cached) return cached;

  const proxy = new URL(proxyUrl);
  if (!/^https?:$/.test(proxy.protocol)) {
    throw new Error(`不支持的代理协议: ${proxy.protocol}`);
  }
  const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  const authHeader = proxy.username
    ? 'Basic ' +
      Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
      ).toString('base64')
    : null;

  const agent = new https.Agent({ keepAlive: true, maxSockets: 6 });

  agent.createConnection = (options, callback) => {
    const sock = net.connect(proxyPort, proxy.hostname);
    const fail = (err) => {
      sock.destroy();
      callback(err);
    };

    sock.setTimeout(DEFAULT_TIMEOUT, () => fail(new Error('代理连接超时')));
    sock.once('error', fail);
    sock.once('connect', () => {
      sock.setTimeout(0);
      const target = `${options.host}:${options.port}`;
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');

      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        sock.removeListener('data', onData);
        const head = buffer.subarray(0, end).toString('utf8');
        if (!/^HTTP\/1\.[01] 200/.test(head)) {
          return fail(new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`));
        }
        const secure = tls.connect({
          socket: sock,
          servername: options.servername || options.host,
        });
        secure.once('secureConnect', () => callback(null, secure));
        secure.once('error', fail);
      };
      sock.on('data', onData);
    });
  };

  agentCache.set(proxyUrl, agent);
  return agent;
}

/**
 * 发起 HTTP(S) 请求。
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:string|Buffer,
 *          proxy?:string, timeoutMs?:number, redirect?:number, maxBytes?:number}} [opts]
 * @returns {Promise<{status:number, headers:Record<string,string>, body:Buffer, text:string, url:string}>}
 */
export async function request(url, opts = {}) {
  let current = url;
  let method = (opts.method || 'GET').toUpperCase();
  let body = opts.body;
  let redirects = opts.redirect ?? 3;

  for (;;) {
    const res = await once(current, { ...opts, method, body });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location && redirects > 0) {
      redirects -= 1;
      current = new URL(location, current).toString();
      if (res.status === 303 || (res.status === 301 && method !== 'GET')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return res;
  }
}

function once(url, opts) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    if (!isHttps && target.protocol !== 'http:') {
      reject(new Error(`不支持的协议: ${target.protocol}`));
      return;
    }
    const mod = isHttps ? https : http;

    const headers = {
      'user-agent': 'LingGuangBot-QQ/1.0 (Node.js)',
      accept: '*/*',
      'accept-encoding': 'gzip, deflate',
      ...(opts.headers || {}),
    };
    if (opts.body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = Buffer.byteLength(opts.body);
    }

    const options = {
      method: opts.method || 'GET',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers,
    };
    if (isHttps && opts.proxy) options.agent = tunnelAgent(opts.proxy);

    const req = mod.request(options, (res) => {
      const chunks = [];
      let size = 0;
      let finished = false;

      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > (opts.maxBytes ?? MAX_BYTES)) {
          finished = true;
          req.destroy(new Error('响应体过大'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (finished) return;
        let buffer = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (encoding === 'gzip') buffer = zlib.gunzipSync(buffer);
          else if (encoding === 'deflate') buffer = zlib.inflateSync(buffer);
          else if (encoding === 'br') buffer = zlib.brotliDecompressSync(buffer);
        } catch {
          /* 解压失败时保留原始内容，交给上层判断 */
        }
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: buffer,
          text: buffer.toString('utf8'),
          url,
        });
      });
      res.on('error', reject);
    });

    req.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT, () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export async function requestJson(url, opts = {}) {
  const res = await request(url, opts);
  let data;
  try {
    data = res.text ? JSON.parse(res.text) : undefined;
  } catch {
    throw new Error(`响应不是合法 JSON (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }
  return { status: res.status, headers: res.headers, data };
}

