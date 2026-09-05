// server.js — 飞机注册号查询服务
import express from 'express';
import https from 'node:https';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupAircraft } from './src/aggregate.js';
import { queryFlightRoute } from './src/flightroute.js';

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
  if (!cs) return res.status(400).json({ success: false, error: '缺少呼号' });
  try {
    const route = await queryFlightRoute(cs);
    if (!route) return res.status(404).json({ success: false, error: '未查到该航班信息' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ success: true, callsign: cs, from: route.from, to: route.to, icaoFrom: route.icaoFrom, icaoTo: route.icaoTo });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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
