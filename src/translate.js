import { requestJson } from './http.js';

/**
 * 大模型翻译：OpenAI 兼容的 /chat/completions。
 * 只负责「把一段正文翻成简体中文」，配置不全会直接抛错，由上层回退到 X 翻译。
 */
const SYSTEM_PROMPT = [
  '你是推文翻译器。把用户给出的推文翻译成简体中文。',
  '规则：',
  '1. 只输出译文本身，不要解释、不要加引号、不要重复原文。',
  '2. @用户名、#标签、URL、emoji 原样保留，不要翻译也不要改写。',
  '3. 保留原有的换行结构。',
  '4. 如果原文已经是简体中文，原样返回。',
].join('\n');

/** 读取翻译配置（缺省一律走 X 翻译）。 */
export function translateConfig(cfg = {}) {
  const t = cfg.translate || {};
  const api = t.api || {};
  return {
    provider: t.provider === 'api' ? 'api' : 'x',
    api: {
      displayName: String(api.displayName || '').trim(),
      model: String(api.model || '').trim(),
      baseUrl: String(api.baseUrl || '').trim(),
      apiKey: String(api.apiKey || '').trim(),
      timeoutMs: Number(api.timeoutMs) > 0 ? Number(api.timeoutMs) : 30000,
    },
  };
}

/** 把接口返回的内容去掉多余包裹（有些模型会套 ``` 或加「译文：」前缀）。 */
export function cleanTranslation(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  text = text.replace(/^(译文|翻译)[:：]\s*/i, '');
  return text.trim();
}

/**
 * 调用大模型翻译一段文本。
 * @returns {Promise<string>} 译文；配置缺失、网络或接口报错时抛错
 */
export async function translateWithApi(text, apiCfg = {}, { request = requestJson, logger } = {}) {
  const source = String(text || '').trim();
  if (!source) return '';
  const { baseUrl, apiKey, model, timeoutMs } = apiCfg;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('翻译 API 配置不全（需要 baseUrl / apiKey / model）');
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await request(url, {
    method: 'POST',
    timeoutMs,
    maxBytes: 2 * 1024 * 1024,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: source },
      ],
    }),
  });

  // request 可能来自 http.request（原始响应）或 http.requestJson（已解析 data）
  let data = res.data;
  if (data === undefined && res.text) {
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error(`翻译接口返回的不是 JSON (HTTP ${res.status}): ${String(res.text).slice(0, 120)}`);
    }
  }

  if (res.status < 200 || res.status >= 300) {
    const detail = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(`翻译接口返回错误: ${detail}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  const out = cleanTranslation(content);
  if (!out) throw new Error('翻译接口没有返回内容');
  logger?.debug?.(`大模型翻译完成：${source.length} 字 -> ${out.length} 字`);
  return out;
}
