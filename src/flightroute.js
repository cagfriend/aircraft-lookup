// src/flightroute.js — 按呼号联网查询 FlightAware，提取 filed route（航路）等详细信息
// FlightAware 页面内嵌 trackpollBootstrap JSON 块，包含完整飞行计划。
// 不再依赖 cheerio（纯正则提取即可）。
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

/**
 * 从 HTML 中提取 trackpollBootstrap 内嵌 JSON（正则，不依赖 DOM 解析器）。
 * 格式：<script>var trackpollBootstrap = {...};</script>
 */
function extractTrackpollBootstrap(html) {
  const m = html.match(/var\s+trackpollBootstrap\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/**
 * 从 og:description meta 标签提取 "from X to Y" 的可读机场名。
 * <meta property="og:description" content="Track Air China (CA) #1831 from Beijing to Xiamen" />
 */
function parseOgDesc(html) {
  const m = html.match(/<meta\s+property="og:description"\s+content="([^"]*?)"/i)
         || html.match(/<meta\s+name="og:description"\s+content="([^"]*?)"/i);
  const desc = m ? m[1] : '';
  const fromTo = desc.match(/\bfrom\s+(.+?)\s+to\s+(.+?)\s*$/i);
  return {
    fromName: fromTo ? fromTo[1].trim() : '',
    toName:   fromTo ? fromTo[2].trim() : '',
  };
}

/**
 * 从内嵌 JSON 的 activityLog 中选取最佳航班记录。
 * 优先选有 filed route 的最近航班（past flights 通常有，future scheduled 没有）；
 * 若都没有 route 则回退到第一条（最新）。
 */
function pickLatestFlight(bootstrap) {
  if (!bootstrap?.flights) return null;
  for (const flightGroup of Object.values(bootstrap.flights)) {
    const flights = flightGroup?.activityLog?.flights;
    if (!Array.isArray(flights) || flights.length === 0) continue;
    // 优先找第一条有 route 的航班（past flights 排在前面）
    const withRoute = flights.find(f => f?.flightPlan?.route);
    return withRoute || flights[0];
  }
  return null;
}

/**
 * 从 trackpollBootstrap 的 activityLog 中提取全部历史航班。
 * 返回数组，每项含 from/to/callsign/departureTime/arrivalTime/route/status 等。
 * 同一呼号在 FlightAware 页面上通常有 6-8 条历史记录。
 */
function extractAllFlights(bootstrap) {
  const results = [];
  if (!bootstrap?.flights) return results;
  for (const flightGroup of Object.values(bootstrap.flights)) {
    const flights = flightGroup?.activityLog?.flights;
    if (!Array.isArray(flights)) continue;
    for (const f of flights) {
      const o = f.origin || {}, d = f.destination || {};
      const fp = f.flightPlan || {};
      const icaoFrom = o.icao || '', icaoTo = d.icao || '';
      if (!icaoFrom && !icaoTo) continue;
      const aFrom = airportByIcao(icaoFrom) || airportByIata(icaoFrom);
      const aTo   = airportByIcao(icaoTo)   || airportByIata(icaoTo);
      const depTime = f.takeoffTimes?.scheduled || f.takeoffTimes?.estimated || f.takeoffTimes?.actual || null;
      const arrTime = f.landingTimes?.scheduled || f.landingTimes?.estimated || f.landingTimes?.actual || null;
      results.push({
        from: {
          code:  aFrom?.iata || o.iata || icaoFrom,
          name:  o.friendlyName || aFrom?.name || icaoFrom,
          icao:  icaoFrom,
          coord: Array.isArray(o.coord) ? { lon: o.coord[0], lat: o.coord[1] } : null,
        },
        to: {
          code:  aTo?.iata || d.iata || icaoTo,
          name:  d.friendlyName || aTo?.name || icaoTo,
          icao:  icaoTo,
          coord: Array.isArray(d.coord) ? { lon: d.coord[0], lat: d.coord[1] } : null,
        },
        callsign:       (f.displayIdent || f.callsign || '').trim(),
        departureTime:  depTime ? new Date(depTime * 1000).toISOString() : null,
        arrivalTime:    arrTime ? new Date(arrTime * 1000).toISOString() : null,
        flightStatus:   f.flightStatus || '',
        route:          fp.route || '',
        routeAltitude:  fp.altitude ?? null,
        routeSpeed:     fp.speed ?? null,
        fuelBurn:       fp.fuelBurn || null,
        distance:       fp.directDistance ?? null,
      });
    }
  }
  return results;
}

/**
 * 查询某呼号的执飞航线（含 filed route / 航路点序列 / 飞行计划）
 * @param {string} callsign 如 AAR223 / CES586 / DAL284
 * @returns {Promise<object|null>}
 * 返回字段：
 *   from, to        — 起降机场 { code, name, icao, coord }
 *   icaoFrom,icaoTo — ICAO码
 *   route           — filed route 字符串（航路点+航路编码+SID/STAR），可能为空
 *   routeAltitude   — 计划飞行高度层（FL），可能为 null
 *   routeSpeed      — 计划速度（knots），可能为 null
 *   fuelBurn        — 预估燃油 { gallons, pounds }，可能为 null
 *   distance        — 直飞距离（nm），可能为 null
 *   historicalFlights — 历史航班数组（含每条的 from/to/时间/route）
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

  const html = res.body;
  const { fromName, toName } = parseOgDesc(html);

  // 优先从内嵌 trackpollBootstrap 提取（含 filed route 等详细数据）
  const bootstrap = extractTrackpollBootstrap(html);
  const latest = pickLatestFlight(bootstrap);

  if (latest) {
    const o = latest.origin || {};
    const d = latest.destination || {};
    const fp = latest.flightPlan || {};
    const icaoFrom = o.icao || '';
    const icaoTo   = d.icao || '';
    if (!icaoFrom && !icaoTo) return null;

    const aFrom = airportByIcao(icaoFrom) || airportByIata(icaoFrom);
    const aTo   = airportByIcao(icaoTo)   || airportByIata(icaoTo);

    const data = {
      from: {
        code:  aFrom?.iata || o.iata || icaoFrom,
        // 优先 JSON 内嵌的 friendlyName（已正确对应 origin），og 描述做兜底
        name:  o.friendlyName || aFrom?.name || fromName || icaoFrom,
        icao:  icaoFrom,
        coord: Array.isArray(o.coord) ? { lon: o.coord[0], lat: o.coord[1] } : null,
      },
      to: {
        code:  aTo?.iata || d.iata || icaoTo,
        name:  d.friendlyName || aTo?.name || toName || icaoTo,
        icao:  icaoTo,
        coord: Array.isArray(d.coord) ? { lon: d.coord[0], lat: d.coord[1] } : null,
      },
      icaoFrom,
      icaoTo,
      // --- filed route（航路详情）---
      route:         fp.route || '',        // 如 "SLEEK2 SLEEK PNH J17 ABI DILLO LAIKS4"
      routeAltitude: fp.altitude ?? null,   // 如 350（FL350）
      routeSpeed:    fp.speed ?? null,      // 如 452（knots）
      fuelBurn:      fp.fuelBurn || null,   // { gallons, pounds }
      distance:      fp.directDistance ?? null, // 直飞距离 (nm)
      // 从同一页面提取全部历史航班（含 from/to/时间/route，可做兜底补全）
      historicalFlights: extractAllFlights(bootstrap),
    };
    routeCache.set(cs, { t: Date.now(), data });
    return data;
  }

  // 降级：内嵌 JSON 缺失时，用 og/meta 标签提取基本起降机场
  const icaoFromMeta = html.match(/<meta\s+name="origin"\s+content="([^"]*?)"/i)?.[1]
                    || html.match(/"origin".*?"icao":"([A-Z0-9]+)"/)?.[1] || '';
  const icaoToMeta   = html.match(/<meta\s+name="destination"\s+content="([^"]*?)"/i)?.[1]
                    || html.match(/"destination".*?"icao":"([A-Z0-9]+)"/)?.[1] || '';
  if (!icaoFromMeta && !icaoToMeta) return null;

  const aFrom = airportByIcao(icaoFromMeta) || airportByIata(icaoFromMeta);
  const aTo   = airportByIcao(icaoToMeta)   || airportByIata(icaoToMeta);

  const data = {
    from: { code: aFrom?.iata || icaoFromMeta, name: fromName || aFrom?.name || icaoFromMeta },
    to:   { code: aTo?.iata   || icaoToMeta,   name: toName   || aTo?.name   || icaoToMeta },
    icaoFrom: icaoFromMeta,
    icaoTo:   icaoToMeta,
    route: '', routeAltitude: null, routeSpeed: null, fuelBurn: null, distance: null,
  };
  routeCache.set(cs, { t: Date.now(), data });
  return data;
}
