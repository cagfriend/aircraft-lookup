// OpenSky 非 Cloudflare 中转。
// 将此服务部署到可直连 OpenSky 的 Node/VPS；不要部署到 Cloudflare Worker。
import crypto from 'node:crypto';
import express from 'express';
import { openskyEnabled, queryOpenSky, queryOpenSkyFlights, queryOpenSkyTrack } from '../src/opensky.js';

// 即使宿主环境意外带有 OPENSKY_PROXY_BASE，中转自身也必须永远直连 OpenSky。
process.env.OPENSKY_PROXY_DISABLE = '1';

const app = express();
const port = Number(process.env.OPENSKY_PROXY_PORT) || 8788;
const sharedToken = process.env.OPENSKY_PROXY_TOKEN || '';

if (!sharedToken) {
  throw new Error('缺少 OPENSKY_PROXY_TOKEN；拒绝启动未受保护的 OpenSky 中转。');
}

function sameToken(actual, expected) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireProxyToken(req, res, next) {
  if (!sameToken(req.get('X-Aircraft-Lookup-Proxy-Token'), sharedToken)) {
    return res.status(401).json({ ok: false, error: '中转认证失败' });
  }
  return next();
}

function validIcao24(value) {
  return /^[0-9a-f]{6}$/i.test(String(value || '').trim());
}

function upstreamStatus(result) {
  // “未在空中/无覆盖/无历史”是 OpenSky 的正常业务结果，应交回 Worker 正常降级。
  if (result?.ok || result?.airborne === false || /无轨迹数据|无航班记录|当前未在空中/.test(result?.error || '')) return 200;
  return 503;
}

function withAircraft(handler) {
  return async (req, res) => {
    const icao24 = String(req.query.icao24 || '').trim().toLowerCase();
    if (!validIcao24(icao24)) return res.status(400).json({ ok: false, error: 'icao24 必须是 6 位十六进制' });
    try {
      const result = await handler(icao24, req);
      return res.status(upstreamStatus(result)).json(result);
    } catch {
      return res.status(503).json({ ok: false, error: 'OpenSky 中转上游请求失败' });
    }
  };
}

// 无需鉴权的存活检查，不泄露凭据或上游响应。
app.get('/health', (_req, res) => {
  res.json({ ok: true, credentialsConfigured: openskyEnabled() });
});

app.get('/v1/states', requireProxyToken, withAircraft((icao24) => queryOpenSky(icao24)));
app.get('/v1/tracks', requireProxyToken, withAircraft((icao24, req) =>
  queryOpenSkyTrack(icao24, { maxPoints: Number(req.query.maxPoints) || 240 }),
));
app.get('/v1/flights', requireProxyToken, withAircraft((icao24, req) =>
  queryOpenSkyFlights(icao24, { hours: Number(req.query.hours) || 24 }),
));

app.listen(port, () => {
  console.log(`OpenSky proxy listening on http://127.0.0.1:${port}`);
});
