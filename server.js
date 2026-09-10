// server.js — 飞机注册号查询服务
import express from 'express';
import https from 'node:https';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupAircraft } from './src/aggregate.js';
import { queryFlightRoute } from './src/flightroute.js';
import { queryFixOnline } from './src/fixlookup.js';
import { queryOpenSkyTrack, queryOpenSkyFlights } from './src/opensky.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 查询飞机
app.get('/api/query', async (req, res) => {
  const reg = req.query.reg || req.q;
  if (!reg) return res.status(400).json({ success: false, error: '请输入注册号，例如 /api/query?reg=B-2001' });
  try {
    const data = await lookupAircraft(String(reg), { forceRefresh: req.query.refresh === '1' });
    if (!data.success) return res.status(404).json(data);
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 按呼号查询航班起降机场（用户点击"查询起降机场"按钮时调用）
app.get('/api/route', async (req, res) => {
  const cs = String(req.query.callsign || '').trim().toUpperCase();
  const icao24 = String(req.query.icao24 || '').trim().toLowerCase();
  if (!cs) return res.status(400).json({ success: false, error: '缺少呼号' });
  try {
    // 并行：FlightAware 航路 + OpenSky 真实轨迹 + OpenSky 历史航班
    const [route, track, osFlights] = await Promise.all([
      queryFlightRoute(cs).catch(() => null),
      icao24 ? queryOpenSkyTrack(icao24).catch(() => null) : Promise.resolve(null),
      icao24 ? queryOpenSkyFlights(icao24).catch(() => null) : Promise.resolve(null),
    ]);
    const trackOut = (track && track.ok)
      ? { callsign: track.callsign, startTime: track.startTime, endTime: track.endTime, pointCount: track.pointCount, points: track.points }
      : null;
    // FlightAware 无数据但 OpenSky 有轨迹时，仍返回轨迹（前端仅画轨迹）
    if (!route && !trackOut) {
      return res.status(404).json({ success: false, error: '未查到该航班信息' });
    }
    res.set('Cache-Control', 'public, max-age=1800');
    res.json({
      success: true, callsign: cs,
      from: route ? route.from : null,
      to: route ? route.to : null,
      icaoFrom: route ? route.icaoFrom : '',
      icaoTo: route ? route.icaoTo : '',
      // filed route（航路详情，可能为空）
      route: route ? (route.route || '') : '',
      routeAltitude: route ? (route.routeAltitude ?? null) : null,
      routeSpeed: route ? (route.routeSpeed ?? null) : null,
      fuelBurn: route ? (route.fuelBurn || null) : null,
      distance: route ? (route.distance ?? null) : null,
      historicalFlights: route ? (route.historicalFlights || []) : [],
      // OpenSky 真实飞行轨迹（匿名亦可用）
      track: trackOut,
      trackError: (track && !track.ok) ? track.error : null,
      // OpenSky 历史航班（需凭据）
      openskyFlights: (osFlights && osFlights.ok) ? osFlights.flights : null,
      openskyFlightsError: (osFlights && !osFlights.ok) ? osFlights.error : null,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 在线补充航路点坐标（OpenNav，需 OPENNAV_TOKEN）
app.get('/api/fix', async (req, res) => {
  const ident = String(req.query.ident || '').trim().toUpperCase();
  if (!ident) return res.status(400).json({ success: false, error: '缺少 ident' });
  const fix = await queryFixOnline(ident).catch(() => null);
  if (!fix) return res.status(404).json({ success: false, error: '未查到该航路点' });
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ success: true, ident, lat: fix.lat, lon: fix.lon });
});

// 图片代理（规避外部 CDN 的防盗链 / 跨域限制）
app.get('/api/img', (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid url' });
  const u = new URL(url);
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.planespotters.net/' },
    lookup: (host, opt, cb) => dns.lookup(host, { ...opt, family: 4 }, cb),
  };
  const upstream = https.request(opts, (up) => {
    res.status(up.statusCode || 200);
    if (up.headers['content-type']) res.set('Content-Type', up.headers['content-type']);
    if (up.headers['content-length']) res.set('Content-Length', up.headers['content-length']);
    res.set('Cache-Control', 'public, max-age=86400');
    up.pipe(res);
  });
  upstream.setTimeout(30000, () => upstream.destroy());
  upstream.on('error', () => res.status(502).json({ error: 'proxy failed' }));
  upstream.end();
});

app.listen(PORT, () => {
  console.log(`✈ 飞机注册号查询服务已启动：http://127.0.0.1:${PORT}`);
});
