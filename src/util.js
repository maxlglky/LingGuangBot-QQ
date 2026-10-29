import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_MAX_BYTES = 5 * 1024 * 1024;

function localTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 启动时轮转过大日志。 */
function prepareLogFile(file) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (statSync(file).size > LOG_MAX_BYTES) {
      renameSync(file, file.replace(/\.log$/i, '.old.log'));
    }
  } catch {
    /* 文件不存在或没权限都忽略 */
  }
}

/**
 * 同时输出到控制台和文件。
 * @param {string} level
 * @param {{file?: string}} [options]
 */
export function createLogger(level = 'info', options = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const file = options.file;
  if (file) prepareLogFile(file);

  const emit = (name, sink) => (...args) => {
    if ((LEVELS[name] ?? 0) < threshold) return;
    const text = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    const line = `${localTimestamp()} ${name.toUpperCase().padEnd(5)} ${text}`;
    sink(line);
    if (file) {
      try {
        appendFileSync(file, line + '\n', 'utf8');
      } catch {
        /* 写盘失败不影响运行 */
      }
    }
  };
  return {
    debug: emit('debug', console.log),
    info: emit('info', console.log),
    warn: emit('warn', console.warn),
    error: emit('error', console.error),
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readJson(file, fallback) {
  try {
    const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`读取 ${file} 失败: ${err.message}`);
  }
}

export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

export function decodeEntities(input) {
  if (!input) return '';
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 去掉 HTML 标签，保留换行与可读文本。 */
export function htmlToText(html) {
  if (!html) return '';
  let text = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function pickFirst(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

export function formatLocalTime(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const opts = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  if (timeZone) opts.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat('zh-CN', opts).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 短时间：10-27 09:03（跨年时带年份）。 */
export function formatShortTime(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const full = formatLocalTime(d, timeZone);
  const now = new Date();
  const sameYear =
    full.slice(0, 4) === String(now.getFullYear()) ||
    (timeZone &&
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(now) === full.slice(0, 4));
  return sameYear ? full.slice(5) : full.slice(0, 10);
}

/** 读取图片宽高（支持 JPEG / PNG / GIF / WebP）。 */
export function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  try {
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    // GIF
    if (buffer.toString('ascii', 0, 3) === 'GIF') {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    // JPEG
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buffer[i + 1];
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isSof) {
          return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
        }
        const len = buffer.readUInt16BE(i + 2);
        if (!len) break;
        i += 2 + len;
      }
    }
  } catch {
    /* 解析失败交给调用方兜底 */
  }
  return null;
}

/** 解析 "1.5m" / "30s" / "2h" 这类时长；纯数字按秒处理。 */
export function parseDuration(value, fallbackMs) {
  if (value === undefined || value === null) return fallbackMs;
  if (typeof value === 'number') return value * 1000;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
  return Math.round(n * factor);
}
