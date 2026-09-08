// src/fixlookup.js — 通过 OpenNav API 在线补充本地数据库未收录的航路点
// 需设置环境变量 OPENNAV_TOKEN（在 opennav.ai 注册获取）。未配置时返回 null，不阻断前端。

const OPENNAV_API_BASE = process.env.OPENNAV_API_BASE || 'https://opennav.ai';
const OPENNAV_TOKEN = process.env.OPENNAV_TOKEN || '';

// 简单查询缓存
const cache = new Map();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 查询单个航路点坐标（在线）。
 * @param {string} ident 如 ALTIB / VIICE2
 * @returns {Promise<{lat:number,lon:number}|null>}
 */
export async function queryFixOnline(ident) {
  if (!ident) return null;
  const id = String(ident).trim().toUpperCase();
  if (!/^[A-Z0-9]{2,7}$/.test(id)) return null;
  if (!OPENNAV_TOKEN) return null; // 未启用在线源

  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.t < CACHE_TTL) return hit.data;

  try {
    const url = OPENNAV_API_BASE + '/api/v1/fix/' + encodeURIComponent(id);
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + OPENNAV_TOKEN, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    // OpenNav 返回字段不确定，做多字段兜底
    const lat = j.lat ?? j.latitude ?? j.latitude_deg ?? j.coordinates?.lat ?? null;
    const lon = j.lon ?? j.longitude ?? j.longitude_deg ?? j.coordinates?.lon ?? null;
    if (lat == null || lon == null || isNaN(+lat) || isNaN(+lon)) return null;
    const data = { lat: +lat, lon: +lon };
    cache.set(id, { t: now, data });
    return data;
  } catch (e) {
    return null;
  }
}
