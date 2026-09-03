// src/opensky.js — OpenSky 网络(ADS-B)实时状态
import { fetchURL, parseJSON } from './fetch.js';

const STATE_URL = 'https://opensky-network.org/api/states/all';

// 状态数组字段索引(OpenSky 标准顺序)
const F = {
  icao: 0,
  callsign: 1,
  origin: 2,
  lastContact: 3,
  lastPosition: 4,
  lng: 5,
  lat: 6,
  baroAltitude: 7,
  onGround: 8,
  velocity: 9,
  trueTrack: 10,
  verticalRate: 11,
  sensor: 12,
  geoAltitude: 13,
  squawk: 14,
  spi: 15,
  positionSource: 16,
};

const CATEGORIES = [
  '轻型 (<15500 lb)', '小型 (15500–75000 lb)', '大型 (75000–300000 lb)',
  '重型 (>300000 lb)', '高性能', '旋翼机', '滑翔机', '轻于空气',
  '无人机', '太空/超高空', '地面车辆', '特技/实验', '未知',
];

function mpsToKmh(mps) {
  return mps == null || isNaN(mps) ? null : Math.round(mps * 3.6);
}
function mToFt(m) {
  return m == null || isNaN(m) ? null : Math.round(m * 3.28084);
}
function kmhToKnots(kmh) {
  return kmh == null ? null : Math.round(kmh / 1.852);
}

/**
 * 查询某架飞机的实时状态
 * @param {string} icao24 24 位 ICAO 地址（十六进制）
 */
export async function queryOpenSky(icao24) {
  const hex = (icao24 || '').toLowerCase();
  if (!hex) return { ok: false, source: 'OpenSky', error: '缺少 ICAO24' };
  const url = `${STATE_URL}?icao24=${encodeURIComponent(hex)}`;
  const res = await fetchURL(url, { timeout: 15000 });
  if (res.status >= 400) {
    return { ok: false, source: 'OpenSky', http: res.status, error: `OpenSky 返回 HTTP ${res.status}` };
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
    // 经纬度
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
