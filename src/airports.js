// src/airports.js — 由坐标反查最近机场（基于 OurAirports 全球机场数据库）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AIRPORTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'airports.json'), 'utf8'),
);

/** 两坐标球面距离（公里），Haversine */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 查询离某坐标最近的机场
 * @param {number} lat 纬度
 * @param {number} lon 经度
 * @param {object} opts
 * @param {number|null} opts.maxKm 可选的最近距离上限（超过则视为“不在机场附近”，返回 null）
 * @returns {{iata:string, icao:string, name:string, city:string, country:string, distKm:number}|null}
 */
export function nearestAirport(lat, lon, opts = {}) {
  const { maxKm = null } = opts;
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return null;
  let best = null;
  for (const a of AIRPORTS) {
    const d = haversineKm(lat, lon, a.lat, a.lon);
    if (!best || d < best.distKm) best = { ...a, distKm: d };
  }
  if (best && maxKm != null && best.distKm > maxKm) return null;
  return best;
}

// 供调试：确认模块加载
export const __count = AIRPORTS.length;
