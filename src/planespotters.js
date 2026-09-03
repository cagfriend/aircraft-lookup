// src/planespotters.js — 从 planespotters.net 公共接口获取飞机照片
import { fetchURL, parseJSON } from './fetch.js';

const API = 'https://api.planespotters.net/pub/photos/reg/';

// planespotters 服务端接口要求 User-Agent 包含联系方式
const PS_UA = 'AircraftLookup/1.0 (+https://example.com/aircraft-lookup)';

/**
 * 查询注册号对应的照片
 * @param {string} reg 规范化注册号
 */
export async function queryPlanespotters(reg) {
  const url = API + reg;
  const res = await fetchURL(url, {
    timeout: 15000,
    ua: PS_UA,
    headers: {
      Referer: 'https://www.planespotters.net/',
      Origin: 'https://www.planespotters.net',
    },
  });

  if (res.status >= 400) {
    return { ok: false, source: 'planespotters', http: res.status, error: `planespotters 返回 HTTP ${res.status}` };
  }
  const json = parseJSON(res.body);
  if (!json || !Array.isArray(json.photos) || json.photos.length === 0) {
    return { ok: false, source: 'planespotters', error: '未找到照片' };
  }
  const photos = json.photos.slice(0, 6).map((p) => ({
    id: p.id,
    link: p.link,
    photographer: p.photographer,
    thumbnail: p.thumbnail?.src || null,
    large: p.thumbnail_large?.src || null,
  }));
  const primary = photos[0];
  return {
    ok: true,
    source: 'planespotters',
    url,
    image: primary.large || primary.thumbnail,
    imageThumb: primary.thumbnail,
    photoLink: primary.link,
    count: json.photos.length,
    photos,
  };
}
