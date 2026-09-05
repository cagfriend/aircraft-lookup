// src/flightroute.js — 按呼号联网查询 FlightAware，补全缺失的起降机场
import * as cheerio from 'cheerio';
import { fetchURL } from './fetch.js';
import { airportByIcao, airportByIata } from './airports.js';

const BASE = 'https://flightaware.com/live/flight/';

// 呼号 → 航线 结果缓存（FlightAware 有反爬/限流，务必缓存）
const routeCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时

// 限流：相邻两次请求至少间隔 1200ms
let lastReq = 0;
function throttle() {
  const wait = lastReq + 1200 - Date.now();
  if (wait > 0) return new Promise((r) => setTimeout(r, wait));
  return Promise.resolve();
}

function metaContent($, name) {
  return $('meta').filter((_, el) => $(el).attr('name') === name).attr('content') || '';
}

/** 从 og:description 提取 "from X to Y" 的可读机场名 */
function parseOgNames(desc) {
  const m = (desc || '').match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i);
  if (!m) return { fromName: '', toName: '' };
  return { fromName: m[1].trim(), toName: m[2].trim() };
}

/**
 * 查询某呼号的执飞航线（起降机场）
 * @param {string} callsign 如 AAR223 / CES586
 * @returns {Promise<{from:{code,name}, to:{code,name}, icaoFrom, icaoTo}|null>}
 */
export async function queryFlightRoute(callsign) {
  const cs = (callsign || '').trim().toUpperCase();
  if (!cs) return null;

  const now = Date.now();
  const hit = routeCache.get(cs);
  if (hit && now - hit.t < CACHE_TTL) return hit.data;

  await throttle();
  lastReq = Date.now();

  // 快速重试 2 次（FlightAware 偶发 socket hang up）
  let res = null;
  for (let i = 0; i < 2 && !res; i++) {
    try {
      const r = await fetchURL(BASE + cs, { timeout: 10000, redirects: 8 });
      if (r.status < 400) res = r;
    } catch (e) {
      if (i === 1) return null;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  if (!res) return null;

  const $ = cheerio.load(res.body);
  const icaoFrom = metaContent($, 'origin');
  const icaoTo = metaContent($, 'destination');
  if (!icaoFrom || !icaoTo) return null; // 页面没有航线（如航班不存在/无计划）

  const { fromName, toName } = parseOgNames($('meta[property="og:description"]').attr('content'));
  const aFrom = airportByIcao(icaoFrom) || airportByIata(icaoFrom);
  const aTo = airportByIcao(icaoTo) || airportByIata(icaoTo);

  const data = {
    from: { code: aFrom?.iata || icaoFrom, name: fromName || aFrom?.name || icaoFrom },
    to: { code: aTo?.iata || icaoTo, name: toName || aTo?.name || icaoTo },
    icaoFrom,
    icaoTo,
  };
  routeCache.set(cs, { t: Date.now(), data });
  return data;
}
