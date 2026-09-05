// src/aggregate.js — 编排各数据源并汇总为统一结构
import { normalizeRegistration } from './register.js';
import { queryAirportData } from './airportdata.js';
import { queryPlanespotters } from './planespotters.js';
import { queryOpenSky } from './opensky.js';
import { nearestAirport } from './airports.js';
import { queryFlightRoute } from './flightroute.js';

/** 由出厂年份计算机龄 */
function calcAge(year) {
  if (!year || isNaN(year) || year < 1900) return null;
  const now = new Date().getFullYear();
  return Math.max(0, now - year);
}

/** 坐标 → 最近机场（无坐标返回 null） */
function nearOf(lat, lon) {
  const n = nearestAirport(lat, lon);
  return n ? { iata: n.iata, icao: n.icao, name: n.name, city: n.city, country: n.country, distKm: Math.round(n.distKm) } : null;
}

// 简单结果缓存，避免对同一注册号反复请求
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟

export async function lookupAircraft(rawInput, opts = {}) {
  const { forceRefresh = false } = opts;
  const norm = normalizeRegistration(rawInput);
  if (!norm.ok) return { success: false, error: norm.error };

  const reg = norm.reg;
  const queryReg = norm.query; // 带连字符，供外网数据源使用
  if (!forceRefresh && cache.has(reg)) {
    const c = cache.get(reg);
    if (Date.now() - c.t < CACHE_TTL) return c.data;
  }

  // 1) airport-data.com：机型/机龄/ICAO24/所有者/执飞航线
  const ad = await queryAirportData(queryReg).catch((e) => ({ ok: false, error: e.message }));

  // 2) planespotters：照片
  const ps = await queryPlanespotters(queryReg).catch((e) => ({ ok: false, error: e.message }));

  // 3) OpenSky：实时状态（用 airport-data 给出的 ICAO24）
  let os = { ok: false };
  if (ad.ok && ad.icao24) {
    os = await queryOpenSky(ad.icao24).catch((e) => ({ ok: false, error: e.message }));
  } else if (ad.ok && !ad.icao24) {
    os = { ok: false, note: '未获取到 ICAO24' };
  }

  const year = ad.ok ? ad.ageKnownYear : null;
  const routes = ad.ok ? (ad.routes || []) : [];

  // 补全缺失起降机场：用呼号联网查 FlightAware（限量避免拖慢响应）
  if (ad.ok && routes.length) {
    const MAX_FILL = 4; // 每次最多补全 4 条，平衡覆盖与响应速度
    let filled = 0;
    for (const r of routes) {
      if (filled >= MAX_FILL) break;
      const lacksRoute = (!r.from || !r.from.code) && (!r.to || !r.to.code);
      if (!lacksRoute) continue;
      if (!r.callsign) continue;
      const fr = await queryFlightRoute(r.callsign).catch(() => null);
      if (fr) {
        r.from = r.from && r.from.code ? r.from : { code: fr.from.code, name: fr.from.name };
        r.to = r.to && r.to.code ? r.to : { code: fr.to.code, name: fr.to.name };
        filled += 1;
      }
    }
  }

  const current = routes[0] || null;

  // OpenSky 覆盖不到时（如中国境内飞机），退而展示最近航班记录的坐标
  let lastSeen = null;
  if (!os.ok && current && (current.lat != null || current.lon != null)) {
    lastSeen = {
      lat: current.lat,
      lon: current.lon,
      time: current.time,
      callsign: current.callsign,
      heading: current.heading,
      speed: current.speed,
      near: nearOf(current.lat, current.lon),
    };
  }

  const result = {
    success: true,
    reg,
    raw: norm.raw,
    requested: norm.raw,
    fetchedAt: new Date().toISOString(),
    aircraft: {
      registration: ad.ok ? ad.registration : reg,
      manufacturer: ad.ok ? ad.manufacturer : '',
      model: ad.ok ? ad.model : '',
      fullType: ad.ok ? ad.fullType : '',
      year,
      age: calcAge(year),
      ageYear: year,
      cn: ad.ok ? ad.cn : '',
      aircraftType: ad.ok ? ad.aircraftType : '',
      seats: ad.ok ? ad.seats : null,
      engines: ad.ok ? ad.engines : null,
      engineType: ad.ok ? ad.engineType : '',
      engineFull: ad.ok ? ad.engineFull : '',
      owner: ad.ok ? ad.owner : '',
      ownerType: ad.ok ? ad.ownerType : '',
      ownerAddress: ad.ok ? ad.ownerAddress : '',
      region: ad.ok ? ad.region : '',
      status: ad.ok ? ad.status : '',
      certIssued: ad.ok ? ad.certIssued : '',
      airWorthiness: ad.ok ? ad.airWorthiness : '',
      lastAction: ad.ok ? ad.lastAction : '',
      country: ad.ok ? ad.country : '',
      icao24: ad.ok ? ad.icao24 : '',
    },
    operator: {
      airline: ad.ok ? ad.airline : '',
      liveStatus: ad.ok ? ad.liveStatus : '',
    },
    photo: ps.ok
      ? { url: ps.image, thumb: ps.imageThumb, link: ps.photoLink, count: ps.count }
      : null,
    live: os.ok
      ? {
          airborne: true,
          callsign: os.callsign,
          originCountry: os.originCountry,
          latitude: os.latitude,
          longitude: os.longitude,
          altitudeBaro: os.altitudeBaro,
          altitudeGeo: os.altitudeGeo,
          onGround: os.onGround,
          groundSpeedKmh: os.groundSpeedKmh,
          groundSpeedKnots: os.groundSpeedKnots,
          heading: os.heading,
          verticalRate: os.verticalRate,
          squawk: os.squawk,
          near: nearOf(os.latitude, os.longitude),
        }
      : { airborne: false, note: os.note || os.error || '', lastSeen },
    currentRoute: current
      ? {
          callsign: current.callsign || '',
          flightNumber: current.flightNumber || '',
          time: current.time || '',
          from: current.from,
          to: current.to,
          lat: current.lat,
          lon: current.lon,
          heading: current.heading,
          speed: current.speed,
          near: nearOf(current.lat, current.lon),
        }
      : null,
    routes: routes.slice(0, 15).map((r) => ({
      time: r.time,
      callsign: r.callsign,
      flightNumber: r.flightNumber,
      level: r.level,
      speed: r.speed,
      heading: r.heading,
      from: r.from,
      to: r.to,
      lat: r.lat,
      lon: r.lon,
      near: nearOf(r.lat, r.lon),
    })),
  };

  result.sources = {
    'airport-data': ad.ok ? 'ok' : ad.notFound ? '未收录' : ad.error || '无数据',
    planespotters: ps.ok ? 'ok' : ps.error || '无数据',
    opensky: os.ok ? 'ok' : os.note || os.error || '无数据',
  };

  // 若所有数据源都无有效信息，则判定为“未找到”
  const hasData = Boolean(
    result.aircraft.fullType ||
    result.aircraft.year ||
    result.aircraft.icao24 ||
    result.aircraft.owner ||
    result.photo ||
    result.routes.length ||
    result.currentRoute ||
    result.live.airborne
  );
  if (!hasData) {
    return { success: false, reg, error: `未查询到注册号 ${reg} 的信息，请检查输入是否正确` };
  }

  cache.set(reg, { t: Date.now(), data: result });
  return result;
}
