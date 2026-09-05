// src/fetch.js — 可靠的 HTTP GET(强制 IPv4、跟随重定向、超时、自定义 UA)
// 双环境兼容：Node.js 本地用 node:https；Cloudflare Pages/Workers 用全局 fetch

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 真 Node 运行时（含 process.versions.node）；Cloudflare Workers 无该字段
export const IS_NODE =
  typeof process !== 'undefined' && !!process.versions && !!process.versions.node;

/**
 * 获取网页/接口内容（自动选择实现：Node https / 环境 fetch）
 * @param {string} url 完整 URL
 * @param {object} opts
 * @param {object} opts.headers 附加请求头
 * @param {number} opts.timeout 单次请求超时(ms)
 * @param {number} opts.redirects 允许的最大重定向次数
 * @param {boolean} opts.followRedirect 是否跟随 30x 重定向
 * @param {string} opts.ua User-Agent
 */
export async function fetchURL(url, opts = {}) {
  const {
    headers = {},
    timeout = 15000,
    redirects = 6,
    followRedirect = true,
    ua = DEFAULT_UA,
  } = opts;

  if (IS_NODE) {
    return nodeFetch(url, { headers, timeout, redirects, followRedirect, ua });
  }
  return envFetch(url, { headers, timeout, followRedirect, ua });
}

/* ---------------- Node 实现（强制 IPv4） ---------------- */
async function nodeFetch(url, { headers, timeout, redirects, followRedirect, ua }) {
  // 延迟动态加载，避免在 Cloudflare 环境解析 node 模块
  const httpMod = await import('node:http');
  const httpsMod = await import('node:https');
  const dnsMod = await import('node:dns');
  const httpReq = httpMod.request || httpMod.default?.request;
  const httpsReq = httpsMod.request || httpsMod.default?.request;
  const dnsLookup = dnsMod.lookup || dnsMod.default?.lookup;

  let current = new URL(url);
  let used = 0;
  while (used <= redirects) {
    const isHttps = current.protocol === 'https:';
    const reqHeaders = {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    };
    const res = await nodeReq(isHttps ? httpsReq : httpReq, {
      protocol: current.protocol,
      hostname: current.hostname,
      port: current.port || (isHttps ? 443 : 80),
      path: current.pathname + current.search,
      method: 'GET',
      headers: reqHeaders,
      // 强制 IPv4，规避外网 DNS 只返回 IPv6 导致的连接超时
      lookup: (host, opt, cb) => dnsLookup(host, { ...opt, family: 4 }, cb),
    }, timeout);
    if (followRedirect && res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current);
      used += 1;
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body };
  }
  throw new Error('重定向次数过多');
}

function nodeReq(requestFn, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error('请求超时(' + timeoutMs + 'ms)')),
    );
    req.on('error', reject);
    req.end();
  });
}

/* ---------------- Cloudflare/浏览器实现（全局 fetch） ---------------- */
async function envFetch(url, { headers, timeout, followRedirect, ua }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
      redirect: followRedirect ? 'follow' : 'manual',
      signal: controller.signal,
    });
    const body = await res.text();
    const norm = {};
    res.headers.forEach((v, k) => {
      norm[k] = v;
    });
    return { status: res.status, headers: norm, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 将服务端抓到的 JSON 文本解析(容错) */
export function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
