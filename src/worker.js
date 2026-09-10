// src/worker.js — Cloudflare Worker 入口（适配 Cloudflare 新版统一部署为 Worker 形态）
// 路由：/api/health /api/query /api/route /api/img
// 静态资源(public/)由 Cloudflare assets 托管；这里只处理 API。

import { lookupAircraft } from './aggregate.js';
import { queryFlightRoute } from './flightroute.js';
import { queryFixOnline } from './fixlookup.js';
import { queryOpenSkyTrack, queryOpenSkyFlights } from './opensky.js';

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
      const icao24 = String(url.searchParams.get('icao24') || '').trim().toLowerCase();
      if (!cs) return json({ success: false, error: '缺少呼号' }, 400);
      try {
        // 并行：FlightAware 航路 + OpenSky 真实轨迹 + OpenSky 历史航班
        let trackErr = null, osFlightsErr = null;
        const [route, track, osFlights] = await Promise.all([
          queryFlightRoute(cs).catch(() => null),
          icao24 ? queryOpenSkyTrack(icao24).catch((e) => { trackErr = String((e && e.message) || e); return null; }) : Promise.resolve(null),
          icao24 ? queryOpenSkyFlights(icao24).catch((e) => { osFlightsErr = String((e && e.message) || e); return null; }) : Promise.resolve(null),
        ]);
        const trackOut = (track && track.ok)
          ? { callsign: track.callsign, startTime: track.startTime, endTime: track.endTime, pointCount: track.pointCount, points: track.points }
          : null;
        // FlightAware 无数据但 OpenSky 有轨迹时，仍返回轨迹（前端仅画轨迹）
        if (!route && !trackOut) {
          return json({ success: false, error: '未查到该航班信息' }, 404);
        }
        return json({
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
          trackError: trackErr || ((track && !track.ok) ? track.error : null),
          // OpenSky 历史航班（需凭据）
          openskyFlights: (osFlights && osFlights.ok) ? osFlights.flights : null,
          openskyFlightsError: osFlightsErr || ((osFlights && !osFlights.ok) ? osFlights.error : null),
        });
      } catch (e) {
        return json({ success: false, error: e.message }, 500);
      }
    }

    // /api/fix（在线补充航路点坐标，需 OPENNAV_TOKEN）
    if (path === '/api/fix') {
      const ident = String(url.searchParams.get('ident') || '').trim().toUpperCase();
      if (!ident) return json({ success: false, error: '缺少 ident' }, 400);
      const fix = await queryFixOnline(ident).catch(() => null);
      if (!fix) return json({ success: false, error: '未查到该航路点' }, 404);
      return json({ success: true, ident, lat: fix.lat, lon: fix.lon });
    }

    // /api/img（图片代理）
    if (path === '/api/img') {
      return handleImg(url);
    }

    // 其余走静态 assets（由 Cloudflare 处理）；这里兜底
    return new Response('Not found', { status: 404 });
  },
};
