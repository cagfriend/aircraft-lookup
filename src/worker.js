// src/worker.js — Cloudflare Worker 入口（适配 Cloudflare 新版统一部署为 Worker 形态）
// 路由：/api/health /api/query /api/route /api/img
// 静态资源(public/)由 Cloudflare assets 托管；这里只处理 API。

import { lookupAircraft } from './aggregate.js';
import { queryFlightRoute } from './flightroute.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

async function handleImg(url) {
  const target = url.searchParams.get('url');
  const ALLOWED = ['t.plnspttrs.net', 'plnspttrs.net'];
  if (!target || !/^https?:\/\//i.test(target)) return json({ error: 'invalid url' }, 400);
  let upstream;
  try { upstream = new URL(target); } catch { return json({ error: 'invalid url' }, 400); }
  const host = upstream.hostname.toLowerCase();
  if (!ALLOWED.some((h) => host === h || host.endsWith('.' + h))) {
    return json({ error: 'host not allowed' }, 403);
  }
  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'AircraftLookup/1.0 (+https://example.com/aircraft-lookup)',
        Referer: 'https://www.planespotters.net/',
      },
      redirect: 'follow',
    });
    if (!resp.ok) return json({ error: 'upstream failed' }, 502);
    return new Response(resp.body, {
      status: 200,
      headers: {
        'Content-Type': resp.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (e) {
    return json({ error: 'proxy failed' }, 502);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /api/health
    if (path === '/api/health') {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // 临时调试：抓 airport-data 页面，分析是否存在多个构造表（复用注册号）
    if (path === '/api/debug') {
      const reg = String(url.searchParams.get('reg') || '').toUpperCase();
      try {
        const html = await fetch('https://airport-data.com/aircraft/' + encodeURIComponent(reg), {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          redirect: 'follow',
        });
        const text = await html.text();
        const title = (text.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        // 收集所有"Manufacturer"开头的构造表及其 cn/engine
        const tables = [];
        // 粗略切分：找到所有包含 Manufacturer 的表块
        let idx = 0;
        const re = /<table[\s\S]*?<\/table>/g;
        let m;
        while ((m = re.exec(text))) {
          const tbl = m[0];
          if (/Manufacturer/.test(tbl)) {
            const cn = (tbl.match(/Construction Number \(C\/N\)[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '';
            const engine = (tbl.match(/Engine Manufacturer and Model[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '';
            const manuf = (tbl.match(/Manufacturer<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '';
            const model = (tbl.match(/<td[^>]*>Model<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '';
            tables.push({ manuf: manuf.replace(/\s+/g,' ').trim(), model: model.replace(/\s+/g,' ').trim(), cn: cn.replace(/\s+/g,' ').trim(), engine: engine.replace(/\s+/g,' ').trim() });
          }
        }
        return json({ reg, title: title.replace(/\s+/g,' '), tables, tableCount: tables.length });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // /api/query
    if (path === '/api/query') {
      const reg = url.searchParams.get('reg') || url.searchParams.get('q');
      if (!reg) return json({ success: false, error: '请输入注册号' }, 400);
      try {
        const data = await lookupAircraft(String(reg), {
          forceRefresh: url.searchParams.get('refresh') === '1',
        });
        if (!data.success) return json(data, 404);
        return json(data);
      } catch (e) {
        return json({ success: false, error: e.message }, 500);
      }
    }

    // /api/route
    if (path === '/api/route') {
      const cs = String(url.searchParams.get('callsign') || '').trim().toUpperCase();
      if (!cs) return json({ success: false, error: '缺少呼号' }, 400);
      try {
        const route = await queryFlightRoute(cs);
        if (!route) return json({ success: false, error: '未查到该航班信息' }, 404);
        return json({ success: true, callsign: cs, from: route.from, to: route.to, icaoFrom: route.icaoFrom, icaoTo: route.icaoTo });
      } catch (e) {
        return json({ success: false, error: e.message }, 500);
      }
    }

    // /api/img（图片代理）
    if (path === '/api/img') {
      return handleImg(url);
    }

    // 其余走静态 assets（由 Cloudflare 处理）；这里兜底
    return new Response('Not found', { status: 404 });
  },
};
