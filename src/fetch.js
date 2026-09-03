// src/fetch.js — 可靠的 HTTP GET(强制 IPv4、跟随重定向、超时、自定义 UA)
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function request(options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = options.protocol === 'http:' ? http : https;
    const req = lib.request(options, (res) => {
      let data = [];
      let size = 0;
      res.on('data', (chunk) => {
        data.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => {
        const body = Buffer.concat(data).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时(${timeoutMs}ms)`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 获取网页/接口内容
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

  let current = new URL(url);
  let used = 0;

  while (used <= redirects) {
    const isHttps = current.protocol === 'https:';
    const reqHeaders = {
      'User-Agent': ua,
      Accept:
        'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    };

    const options = {
      protocol: current.protocol,
      hostname: current.hostname,
      port: current.port || (isHttps ? 443 : 80),
      path: current.pathname + current.search,
      method: 'GET',
      headers: reqHeaders,
      // 强制 IPv4，规避外网 DNS 只返回 IPv6 导致的连接超时
      lookup: (host, opt, cb) =>
        dns.lookup(host, { ...opt, family: 4 }, cb),
    };

    const res = await request(options, timeout);
    const status = res.status;

    // 跟随重定向
    if (followRedirect && status >= 300 && status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, current).toString();
      current = new URL(next);
      used += 1;
      continue;
    }
    return { status, headers: res.headers, body: res.body };
  }
  throw new Error('重定向次数过多');
}

/** 将服务端抓到的 JSON 文本解析(容错) */
export function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
