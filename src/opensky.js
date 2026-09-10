// src/opensky.js — OpenSky 网络(ADS-B)：实时状态 + 真实飞行轨迹 + 历史航班
// 认证：OAuth2 client credentials（需 OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET）
// 未配置凭据时：实时状态与轨迹仍可匿名使用（配额较低 400/天），历史航班不可用。
import { fetchURL, parseJSON } from './fetch.js';

const STATE_URL   = 'https://opensky-network.org/api/states/all';
const TRACK_URL   = 'https://opensky-network.org/api/tracks/all';
const FLIGHTS_URL = 'https://opensky-network.org/api/flights/aircraft';
const TOKEN_URL   = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

// 状态数组字段索引(OpenSky 标准顺序)
const F = {
  icao: 0, callsign: 1, origin: 2, lastContact: 3, lastPosition: 4, lng: 5, lat: 6,
  baroAltitude: 7, onGround: 8, velocity: 9, trueTrack: 10, verticalRate: 11,
  sensor: 12, geoAltitude: 13, squawk: 14, spi: 15, positionSource: 16,
};

const CATEGORIES = [
  '轻型 (<15500 lb)', '小型 (15500–75000 lb)', '大型 (75000–300000 lb)',
  '重型 (>300000 lb)', '高性能', '旋翼机', '滑翔机', '轻于空气',
  '无人机', '太空/超高空', '地面车辆', '特技/实验', '未知',
];

function mpsToKmh(mps) { return mps == null || isNaN(mps) ? null : Math.round(mps * 3.6); }
function mToFt(m) { return m == null || isNaN(m) ? null : Math.round(m * 3.28084); }

// 读取环境变量：Node 用 process.env；Cloudflare Worker 用 globalThis.env 绑定
function env(name) {
  try {
    if (typeof process !== 'undefined' && process.env) return process.env[name] || '';
    if (typeof globalThis !== 'undefined' && globalThis.env) return globalThis.env[name] || '';
  } catch (e) { /* ignore */ }
  return '';
}

/** 是否已配置 OpenSky 凭据（决定历史航班是否可用、配额高低） */
export function openskyEnabled() {
  return !!(env('OPENSKY_CLIENT_ID') && env('OPENSKY_CLIENT_SECRET'));
}

/* ---------------- OAuth2 token（30 分钟过期，提前 2 分钟刷新） ---------------- */
let tokenCache = { token: '', exp: 0 };

async function getToken() {
  if (!openskyEnabled()) return '';
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.exp) return tokenCache.token;

  const body = 'grant_type=client_credentials'
    + '&client_id=' + encodeURIComponent(env('OPENSKY_CLIENT_ID'))
    + '&client_secret=' + encodeURIComponent(env('OPENSKY_CLIENT_SECRET'));

  const res = await fetchURL(TOKEN_URL, {
    method: 'POST',
    body: body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
    followRedirect: false,
  });
  if (res.status >= 400) return '';
  const j = parseJSON(res.body);
  if (!j || !j.access_token) return '';
  const ttlMs = (Number(j.expires_in) || 1800) * 1000;
  tokenCache = { token: j.access_token, exp: now + ttlMs - 120000 };
  return tokenCache.token;
}

function authHeaders(token) {
  return token ? { Authorization: 'Bearer ' + token } : {};
}

/**
 * 查询某架飞机的实时状态
 * @param {string} icao24 24 位 ICAO 地址（十六进制）
 */
export async function queryOpenSky(icao24) {
  const hex = (icao24 || '').toLowerCase();
  if (!hex) return { ok: false, source: 'OpenSky', error: '缺少 ICAO24' };
  const token = await getToken().catch(() => '');
  const url = STATE_URL + '?icao24=' + encodeURIComponent(hex);
  const res = await fetchURL(url, { timeout: 15000, headers: authHeaders(token) });
  if (res.status >= 400) {
    return { ok: false, source: 'OpenSky', http: res.status, error: 'OpenSky 返回 HTTP ' + res.status };
  }
  const json = parseJSON(res.body);
  const state = json?.states?.[0];
  if (!state) {
    return { ok: false, source: 'OpenSky', airborne: false, error: '该机当前未在空中状态' };
  }
  const get = (i) => (i < state.length ? state[i] : undefined);
  return {
    ok: true,
    source: 'OpenSky',
    icao24: get(F.icao),
    callsign: (get(F.callsign) || '').trim(),
    originCountry: get(F.origin),
    longitude: get(F.lng),
    latitude: get(F.lat),
    altitudeBaro: mToFt(get(F.baroAltitude)),
    altitudeGeo: mToFt(get(F.geoAltitude)),
    onGround: get(F.onGround),
    groundSpeedKmh: mpsToKmh(get(F.velocity)),
    groundSpeedKnots: (get(F.velocity) == null) ? null : Math.round(get(F.velocity) * 1.94384),
    heading: get(F.trueTrack),
    verticalRate: get(F.verticalRate),
    squawk: get(F.squawk),
    category: get(F.positionSource) == null ? null : CATEGORIES[get(F.positionSource)] || '',
    lastContact: get(F.lastContact),
  };
}

/**
 * 查询某架飞机的真实飞行轨迹（当前位置往前的一段）
 * 免认证也可用（配额低）；配了凭据则用高配额。
 * @param {string} icao24
 * @param {object} opts { maxPoints } 抽稀上限，默认 240 个点
 * @returns {Promise<object>} points: [lat, lon, altFt, heading, onGround, time][]
 */
export async function queryOpenSkyTrack(icao24, opts = {}) {
  const hex = (icao24 || '').toLowerCase();
  if (!hex) return { ok: false, source: 'OpenSky', error: '缺少 ICAO24' };
  const maxPoints = Math.max(20, Math.min(Number(opts.maxPoints) || 240, 1000));
  const token = await getToken().catch(() => '');
  const url = TRACK_URL + '?icao24=' + encodeURIComponent(hex) + '&time=0';
  const res = await fetchURL(url, { timeout: 15000, headers: authHeaders(token) });
  if (res.status >= 400) {
    return { ok: false, source: 'OpenSky', http: res.status, error: 'OpenSky tracks 返回 HTTP ' + res.status };
  }
  const j = parseJSON(res.body);
  const path = Array.isArray(j?.path) ? j.path : [];
  if (!path.length) {
    return { ok: false, source: 'OpenSky', error: '无轨迹数据（该时段无接收站覆盖）' };
  }
  // 抽稀：最多 maxPoints 个点，始终保留首尾
  const step = Math.max(1, Math.ceil(path.length / maxPoints));
  const picked = [];
  for (let i = 0; i < path.length; i += step) picked.push(path[i]);
  if (picked[picked.length - 1] !== path[path.length - 1]) picked.push(path[path.length - 1]);

  return {
    ok: true,
    source: 'OpenSky',
    callsign: (j.callsign || '').trim(),
    startTime: j.startTime || null,
    endTime: j.endTime || null,
    pointCount: path.length,
    // 每点：[lat, lon, 高度ft, 航向, 是否在地面, 时间]
    points: picked.map((p) => [
      p[1], p[2],
      p[3] == null ? null : mToFt(p[3]),
      p[4] == null ? null : p[4],
      !!p[5],
      p[0],
    ]),
  };
}

/**
 * 查询某架飞机的历史航班（按 ICAO24，最近 N 小时）
 * 需认证（未配置凭据返回 ok:false）。
 * @param {string} icao24
 * @param {object} opts { hours } 默认 24 小时（4 credits；1-2 天为 30 credits）
 */
export async function queryOpenSkyFlights(icao24, opts = {}) {
  const hex = (icao24 || '').toLowerCase();
  if (!hex) return { ok: false, source: 'OpenSky', error: '缺少 ICAO24' };
  const token = await getToken().catch(() => '');
  if (!token) {
    return { ok: false, source: 'OpenSky', error: '未配置 OpenSky 凭据（历史航班需认证）' };
  }
  const hours = Math.min(Math.max(Number(opts.hours) || 24, 1), 48);
  const end = Math.floor(Date.now() / 1000);
  const begin = end - hours * 3600;
  const url = FLIGHTS_URL + '?icao24=' + encodeURIComponent(hex) + '&begin=' + begin + '&end=' + end;
  const res = await fetchURL(url, { timeout: 15000, headers: authHeaders(token) });
  if (res.status >= 400) {
    return { ok: false, source: 'OpenSky', http: res.status, error: 'OpenSky flights 返回 HTTP ' + res.status };
  }
  const arr = parseJSON(res.body);
  if (!Array.isArray(arr) || !arr.length) {
    return { ok: false, source: 'OpenSky', error: '该时段无航班记录' };
  }
  return {
    ok: true,
    source: 'OpenSky',
    hours: hours,
    flights: arr.map((f) => ({
      callsign: (f.callsign || '').trim(),
      fromIcao: f.estDepartureAirport || '',
      toIcao: f.estArrivalAirport || '',
      firstSeen: f.firstSeen || null,
      lastSeen: f.lastSeen || null,
      // 置信度参考：距估计机场的水平距离(米) 与候选机场数
      fromDistanceM: f.estDepartureAirportHorizDistance ?? null,
      toDistanceM: f.estArrivalAirportHorizDistance ?? null,
      fromCandidates: f.departureAirportCandidatesCount ?? 0,
      toCandidates: f.arrivalAirportCandidatesCount ?? 0,
    })),
  };
}
