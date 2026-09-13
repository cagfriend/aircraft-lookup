// src/diag.js — 临时诊断 v2：CF 边缘可达性 + 对照 + 中转路径探测
// 用完即删（连同 worker.js 里的 /api/diag 路由）。
import { fetchURL } from './fetch.js';

const UA_APP = 'aircraft-lookup/1.0 (+https://searchplane.site)';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function build(hex) {
  const h = hex || 'a6cc84';
  const os = 'https://opensky-network.org/api/states/all?icao24=' + h;
  const enc = encodeURIComponent(os);
  return [
    // —— 对照：非 Cloudflare 前挡的普通 API，验证 Worker 出网本身是否健康 ——
    { name: 'ctrl-adsbdb', url: 'https://api.adsbdb.com/v0/aircraft/' + h, timeout: 8000 },
    { name: 'ctrl-example', url: 'https://example.com/', timeout: 8000 },

    // —— OpenSky：放宽到 20s，区分“慢”与“死” ——
    { name: 'opensky-root-20s', url: 'https://opensky-network.org/', timeout: 20000 },
    { name: 'opensky-states-20s', url: os, timeout: 20000 },

    // —— adsb.lol：换浏览器 UA/Referer，看 429 是否与指纹有关 ——
    { name: 'adsblol-browserUA', url: 'https://api.adsb.lol/v2/hex/' + h, timeout: 8000, ua: UA_BROWSER, headers: { Referer: 'https://globe.adsb.lol/' } },
    { name: 'adsblol-trace-browserUA', url: 'https://api.adsb.lol/v2/hex/' + h + '/trace/', timeout: 8000, ua: UA_BROWSER, headers: { Referer: 'https://globe.adsb.lol/' } },

    // —— airplanes.live：带 Referer 再试 ——
    { name: 'airplaneslive-referer', url: 'https://api.airplanes.live/v2/hex/' + h, timeout: 8000, ua: UA_BROWSER, headers: { Referer: 'https://globe.airplanes.live/' } },

    // —— 第三方中转（其出口不是 Cloudflare）能否代取 OpenSky ——
    { name: 'relay-jina', url: 'https://r.jina.ai/' + os, timeout: 20000 },
    { name: 'relay-allorigins', url: 'https://api.allorigins.win/raw?url=' + enc, timeout: 20000 },
    { name: 'relay-codetabs', url: 'https://api.codetabs.com/v1/proxy?quest=' + enc, timeout: 20000 },
    { name: 'relay-corsproxy', url: 'https://corsproxy.io/?' + enc, timeout: 20000 },
  ];
}

export async function runDiag(hex) {
  return Promise.all(build(hex).map(async (t) => {
    const t0 = Date.now();
    try {
      const res = await fetchURL(t.url, {
        timeout: t.timeout || 6000,
        ua: t.ua || UA_APP,
        headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8', ...(t.headers || {}) },
      });
      return { name: t.name, status: res.status, ms: Date.now() - t0, snippet: String(res.body || '').slice(0, 300) };
    } catch (e) {
      return { name: t.name, status: 0, ms: Date.now() - t0, error: String((e && e.message) || e) };
    }
  }));
}
