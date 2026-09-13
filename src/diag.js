// src/diag.js — 临时诊断：从 Cloudflare 边缘实测各 ADS-B / OpenSky 端点可达性
// 目的：判断线上 Worker 能用哪个源替代不可达的 OpenSky（522）。
// 用完即删（连同 worker.js 里的 /api/diag 路由）。
import { fetchURL } from './fetch.js';

const UA = 'aircraft-lookup/1.0 (+https://searchplane.site)';

function targets(hex) {
  const h = hex || '3c4b26';
  return [
    { name: 'opensky-states', url: 'https://opensky-network.org/api/states/all?icao24=' + h },
    { name: 'opensky-tracks', url: 'https://opensky-network.org/api/tracks/all?icao24=' + h + '&time=0' },
    { name: 'adsblol-hex',    url: 'https://api.adsb.lol/v2/hex/' + h },
    { name: 'adsblol-trace',  url: 'https://api.adsb.lol/v2/hex/' + h + '/trace/' },
    { name: 'adsbfi-hex',     url: 'https://opendata.adsb.fi/api/v2/hex/' + h },
    { name: 'adsbfi-trace',   url: 'https://opendata.adsb.fi/api/v2/hex/' + h + '/trace/' },
    { name: 'airplaneslive',  url: 'https://api.airplanes.live/v2/hex/' + h },
  ];
}

export async function runDiag(hex) {
  return Promise.all(targets(hex).map(async (t) => {
    const t0 = Date.now();
    try {
      const res = await fetchURL(t.url, {
        timeout: 6000,
        ua: UA,
        headers: { Accept: 'application/json' },
      });
      return { name: t.name, status: res.status, ms: Date.now() - t0, snippet: String(res.body || '').slice(0, 260) };
    } catch (e) {
      return { name: t.name, status: 0, ms: Date.now() - t0, error: String((e && e.message) || e) };
    }
  }));
}
