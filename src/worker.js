// src/worker.js — Cloudflare Worker 入口（适配 Cloudflare 新版统一部署为 Worker 形态）
// 路由：/api/health /api/query /api/route /api/img
// 静态资源(public/)由 Cloudflare assets 托管；这里只处理 API。

import { lookupAircraft } from './aggregate.js';
import { queryFlightRoute, peekLiveTrack } from './flightroute.js';
import { nearestAirport } from './airports.js';
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
  async fetch(request, env, ctx) {
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
        // OpenSky 在 CF 边缘不可达时，用后台任务预热 FlightAware 实时位置（不阻塞响应）：
        // 前端随后轮询 /api/live 取回结果，从而自动填上"实时位置"面板。
        const cs = data.currentRoute && data.currentRoute.callsign;
        if (!(data.live && data.live.airborne) && cs && ctx && typeof ctx.waitUntil === 'function') {
          // 仅在"最近航班记录仍新鲜"时预热，避免为早已落地的航班白抓 FlightAware（反爬风险）
          const recTime = data.currentRoute.time
            ? Date.parse(String(data.currentRoute.time).replace(' ', 'T').replace(' UTC', 'Z')) : NaN;
          const stillFresh = isNaN(recTime) || (Date.now() - recTime) < 2 * 3600 * 1000;
          if (stillFresh) ctx.waitUntil(queryFlightRoute(cs).catch(() => null));
        }
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
        // 真实轨迹：优先 OpenSky；CF 边缘访问 OpenSky 为 522 不可达，
        // 此时用同一页面已抓到的 FlightAware 实时轨迹兜底（零额外请求）。
        const faLive = (route && route.liveTrack) ? route.liveTrack : null;
        const trackOut = (track && track.ok)
          ? {
              callsign: track.callsign, startTime: track.startTime, endTime: track.endTime,
              pointCount: track.pointCount, points: track.points, source: 'OpenSky',
            }
          : (faLive && faLive.points && faLive.points.length > 1)
            ? {
                callsign: faLive.callsign, startTime: faLive.startTime, endTime: faLive.endTime,
                pointCount: faLive.pointCount, points: faLive.points,
                source: faLive.source, live: faLive.live,
              }
            : null;
        // 诊断信息：Cloudflare 机房（便于排查"某设备/地区失败"这类问题）
        const colo = (request.cf && request.cf.colo) || '';
        // FlightAware 无数据但 OpenSky 有轨迹时，仍返回轨迹（前端仅画轨迹）
        if (!route && !trackOut) {
          return json({ success: false, error: '未查到该航班信息', colo }, 404);
        }
        return json({
          success: true, callsign: cs, colo,
          trackSource: trackOut ? trackOut.source : null,
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

    // /api/live（实时位置轮询：只读缓存，恒定快返回；数据由 /api/query 后台预热）
    if (path === '/api/live') {
      const cs = String(url.searchParams.get('callsign') || '').trim().toUpperCase();
      if (!cs) return json({ success: false, error: '缺少呼号' }, 400);
      const lt = peekLiveTrack(cs);
      if (!lt || !lt.live) return json({ success: true, callsign: cs, pending: true });
      const lv = lt.live;
      const na = (lv.latitude != null && lv.longitude != null)
        ? nearestAirport(lv.latitude, lv.longitude) : null;
      return json({
        success: true, callsign: cs, pending: false, source: lt.source,
        live: {
          airborne: !lv.onGround,
          callsign: lt.callsign || cs,
          latitude: lv.latitude,
          longitude: lv.longitude,
          altitudeBaro: lv.altitudeFt,
          altitudeGeo: lv.altitudeFt,
          onGround: !!lv.onGround,
          groundSpeedKnots: lv.groundSpeedKnots,
          groundSpeedKmh: lv.groundSpeedKnots != null ? Math.round(lv.groundSpeedKnots * 1.852) : null,
          heading: lv.heading,
          squawk: '',
          verticalRate: null,
          status: lv.status || '',
          near: na ? { iata: na.iata, icao: na.icao, name: na.name, city: na.city, country: na.country, distKm: Math.round(na.distKm) } : null,
        },
      });
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
