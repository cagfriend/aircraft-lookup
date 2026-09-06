// src/airportdata.js — airport-data.com 全局飞机数据库(通用机型/机龄/执飞航线来源)
import * as cheerio from 'cheerio';
import { fetchURL } from './fetch.js';

const BASE = 'https://airport-data.com/aircraft/';

function txt(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * 根据注册号前缀推断国家/地区（注册号体系国际标准，前缀对应国家）。
 * 用于所有者地址缺失或解析失败时的兜底，尤其针对 B-（中国民航）等。
 * @param {string} reg 注册号，如 B18001 / N784AN / JA801A
 * @returns {string} 国家/地区名，未识别返回 ''
 */
export function countryFromRegistration(reg) {
  const r = (reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!r) return '';
  if (/^B\d{4}/.test(r)) return '中国(China)';
  if (/^N\d/.test(r)) return '美国(USA)';
  if (/^JA\d/.test(r)) return '日本(Japan)';
  if (/^G-?[A-Z]/.test(r) && r.length >= 5) return '英国(UK)';
  if (/^D-?[A-Z]/.test(r)) return '德国(Germany)';
  if (/^F-?[A-Z]/.test(r) || /^F-?\d/.test(r)) return '法国(France)';
  if (/^HL\d/.test(r)) return '韩国(South Korea)';
  if (/^9M/.test(r)) return '马来西亚(Malaysia)';
  if (/^VT/.test(r)) return '印度(India)';
  if (/^A6/.test(r)) return '阿联酋(UAE)';
  if (/^5B/.test(r)) return '塞浦路斯(Cyprus)';
  if (/^4X/.test(r)) return '以色列(Israel)';
  if (/^PH/.test(r)) return '荷兰(Netherlands)';
  if (/^EC/.test(r)) return '西班牙(Spain)';
  if (/^EI/.test(r)) return '爱尔兰(Ireland)';
  if (/^SE/.test(r)) return '瑞典(Sweden)';
  if (/^LN/.test(r)) return '挪威(Norway)';
  if (/^OY/.test(r)) return '丹麦(Denmark)';
  if (/^SP/.test(r)) return '波兰(Poland)';
  if (/^OK/.test(r)) return '捷克(Czechia)';
  if (/^HB/.test(r)) return '瑞士(Switzerland)';
  if (/^YV/.test(r)) return '委内瑞拉(Venezuela)';
  if (/^YR/.test(r)) return '罗马尼亚(Romania)';
  if (/^9V/.test(r)) return '新加坡(Singapore)';
  if (/^C-[FG]/.test(r)) return '加拿大(Canada)';
  if (/^VH/.test(r)) return '澳大利亚(Australia)';
  if (/^ZK/.test(r)) return '新西兰(New Zealand)';
  if (/^PK/.test(r)) return '印度尼西亚(Indonesia)';
  if (/^HS/.test(r)) return '泰国(Thailand)';
  if (/^RP/.test(r)) return '菲律宾(Philippines)';
  if (/^RA/.test(r) || /^RF/.test(r) || /^RD/.test(r)) return '俄罗斯(Russia)';
  if (/^UR-?[A-Z]/.test(r)) return '乌克兰(Ukraine)';
  if (/^TC/.test(r)) return '土耳其(Turkey)';
  if (/^5N/.test(r)) return '尼日利亚(Nigeria)';
  if (/^ZS/.test(r) || /^ZU/.test(r) || /^ZT/.test(r)) return '南非(South Africa)';
  if (/^CN-?[A-Z]/.test(r) || /^CN-?\d/.test(r)) return '摩洛哥(Morocco)';
  return '';
}

/**
 * 解析标题 "Aircraft Data N784AN, 2000 Boeing 777-223, c/n 29588"
 */
function parseTitle(title) {
  const m = txt(title).match(/Aircraft Data\s+([A-Z0-9-]+),\s*(\d{4})\s+(.+?),\s*c\/n\s+(\d+)/i);
  if (!m) return null;
  return { registration: m[1], year: Number(m[2]), fullType: txt(m[3]), cn: m[4] };
}

/**
 * 生成注册号的连字符变体，供容错查询使用。
 * 例：B7973 -> ["B7973","B-7973"]；GEUYR -> ["GEUYR","G-EUYR","GE-UYR"]；9MMAS -> ["9MMAS","9M-MAS"]
 */
export function hyphenVariants(s) {
  const out = new Set([s]);
  if (!/^[A-Z0-9]+$/.test(s) || s.length < 4) return [...out];
  if (/^[A-Z]/.test(s)) out.add(`${s[0]}-${s.slice(1)}`);        // G-EUYR / B-7973
  if (/^[A-Z]{2}/.test(s)) out.add(`${s.slice(0, 2)}-${s.slice(2)}`); // VT-SUG / HL-7598
  if (/^\d[A-Z]/.test(s)) out.add(`${s.slice(0, 2)}-${s.slice(2)}`);  // 9M-MAS / 4X-EAD
  return [...out];
}

/**
 * 查询 airport-data.com；自动尝试连字符变体（如用户输入 B7973 而无连字符）
 * @param {string} reg 规范化后的注册号（可能带连字符）
 */
export async function queryAirportData(reg) {
  const variants = hyphenVariants(reg);
  let last = null;
  for (const v of variants) {
    const r = await fetchParse(v);
    last = r;
    if (r.ok && !r.notFound) return r; // 命中真实记录即返回
  }
  return last;
}

/**
 * 解析单个注册号页面中的四类表格
 */
async function fetchParse(reg) {
  const url = BASE + reg;
  const res = await fetchURL(url, { timeout: 20000 });
  if (res.status >= 400) {
    return { ok: false, source: 'airport-data', http: res.status, error: `airport-data 返回 HTTP ${res.status}` };
  }
  const $ = cheerio.load(res.body);

  const title = $('title').text();
  const parsed = parseTitle(title);

  // 未收录判断：标题以 "Add aircraft" 开头，或没有任何数据行
  const bodyText = $('body').text();
  const notFound =
    /^\s*Add\s+aircraft/i.test(title) ||
    (/currently\s+no\s+aircraft/i.test(bodyText)) ||
    (/not\s+found/i.test(bodyText) && !/Aircraft Data/i.test(title));

  const airframe = {};   // 表1
  const details = {};    // 表2
  const owner = {};      // 表3
  const routes = [];     // 表0
  const airframeCandidates = []; // 多个构造表(复用注册号时会有多个)

  // 实时段元信息（航空公司与状态徽标）在 data-live-section 里，表格外
  const liveSection = $('[data-live-section]').first();
  const liveBadge = liveSection.find('.badge').first();
  const liveMeta = {
    status: txt(liveBadge.text()),
    airline: txt(liveBadge.parent().children('span.text-sm').first().text()),
  };

  $('table').each((_, tbl) => {
    const rows = $(tbl).find('tr').toArray();
    if (rows.length === 0) return;
    const firstRowCells = $(rows[0]).find('td').toArray();
    const firstCellText = txt($(firstRowCells[0]).text());
    // 路由表：行含 data-label 且有 6 个 td
    if ($(tbl).find('tr.js-live-history-row').length > 0) {
      routes._meta = liveMeta;
      $(tbl).find('tr.js-live-history-row').each((_, tr) => {
        const $tr = $(tr);
        const tds = $tr.find('td').toArray();
        const routeCodes = txt($tr.find('span.block.cursor-help').first().text());
        // 机场全名在下拉框的 .block.text-sm 里；用 text() 后按 → 分割
        const namesEl = $tr.find('.dropdown-content .block.text-sm').first();
        const routeNames = namesEl.length
          ? txt(namesEl.text())
          : txt($tr.find('.dropdown-content').first().text());
        const [fromCode, toCode] = (routeCodes || '').split(/\s*→\s*/);
        const nameParts = (routeNames || '').split(/\s*→\s*/);
        const fromName = nameParts[0] || '';
        const toName = nameParts.slice(1).join(' ') || '';
        const callsign = txt($(tds[1]).text());
        const [csMain, csNum] = callsign.split('/');
        routes.push({
          time: txt($(tds[0]).text()) || txt($tr.attr('data-time')),
          callsign: txt(csMain),
          flightNumber: txt(csNum),
          level: txt($(tds[2]).text()),
          speed: txt($(tds[3]).text()),
          heading: txt($(tds[4]).text()) || $tr.attr('data-track'),
          from: { code: fromCode || '', name: fromName || '' },
          to: { code: toCode || '', name: toName || '' },
          lat: $tr.attr('data-lat'),
          lon: $tr.attr('data-lon'),
          track: $tr.attr('data-track'),
          label: txt($tr.attr('data-label')),
          sub: txt($tr.attr('data-sub')),
        });
      });
    } else if (firstCellText === 'Manufacturer') {
      // 每张构造表独立收集，避免复用注册号时不同飞机的字段串到一起
      const one = {};
      $(tbl).find('tr').each((_, tr) => {
        const tds = $(tr).find('td').toArray();
        if (tds.length >= 2) one[txt($(tds[0]).text())] = txt($(tds[1]).text()).replace(/Search all.*$/i, '').trim();
      });
      airframeCandidates.push(one);
    } else if (firstCellText === 'Registration Number') {
      $(tbl).find('tr').each((_, tr) => {
        const tds = $(tr).find('td').toArray();
        if (tds.length >= 2) details[txt($(tds[0]).text())] = txt($(tds[1]).text());
      });
    } else if (firstCellText === 'Registration Type') {
      $(tbl).find('tr').each((_, tr) => {
        const tds = $(tr).find('td').toArray();
        if (tds.length >= 2) owner[txt($(tds[0]).text())] = txt($(tds[1]).text());
      });
    }
  });

  // 若存在多个构造表（复用注册号），选与标题中 C/N 一致的那张；
  // 否则仍匹配到多个时，回退用第一张（最可能对应当前记录）。
  if (airframeCandidates.length) {
    const targetCn = parsed ? parsed.cn : '';
    const byCn = airframeCandidates.find((c) => c['Construction Number (C/N)'] && targetCn && String(c['Construction Number (C/N)']).trim() === String(targetCn).trim());
    const chosen = byCn || airframeCandidates[0];
    Object.assign(airframe, chosen);
  }

  const makeModel = (parsed ? parsed.fullType : '') || airframe['Model'] || '';
  // 以标题中的完整类型为权威（避免复用注册号导致的旧记录混入），其余表格作为补充
  const make = makeModel.trim().split(/\s+/).slice(0, -1).join(' '); // "Boeing" from "Boeing 777-223"
  const model = makeModel.trim().split(/\s+/).slice(-1)[0];
  const fullMake = make || airframe['Manufacturer'] || '';

  // 从所有者地址尽量提取国家
  const ownerAddr = owner['Address'] || '';
  let country = '';
  if (ownerAddr) {
    const seg = ownerAddr.split(',').pop().replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = seg.split(/\s+/);
    country = tokens.length > 1 ? tokens.slice(1).join(' ') : seg; // 去掉州/省份缩写
  }
  // 兜底：所有者地址缺失/解析失败时，用注册号前缀推断国家/地区（如 B- 即中国）
  if (!country || country.length === 0) {
    country = countryFromRegistration(reg);
  }

  // 从 Air Worthiness Test 或 Year built 推导机龄
  const year = parsed ? parsed.year : Number(airframe['Year built']);
  const airWorthiness = details['Air Worthiness Test'] || details['Certification Issued'] || '';
  const firstFlightSource = airWorthiness ? airWorthiness.slice(0, 4) : (year ? String(year) : '');

  return {
    ok: !notFound,
    notFound,
    source: 'airport-data',
    error: notFound ? '数据库中未收录该注册号' : undefined,
    url,
    registration: parsed ? parsed.registration : details['Registration Number'] || reg,
    icao24: (details['Mode S (ICAO24) Code'] || '').toLowerCase(),
    manufacturer: fullMake,
    model: model || makeModel,
    fullType: makeModel.trim(),
    year,
    ageKnownYear: Number(firstFlightSource) || year || null,
    cn: parsed ? parsed.cn : airframe['Construction Number (C/N)'] || '',
    aircraftType: airframe['Aircraft Type'] || '',
    seats: airframe['Number of Seats'] ? Number(airframe['Number of Seats']) : null,
    engines: airframe['Number of Engines'] ? Number(airframe['Number of Engines']) : null,
    engineType: airframe['Engine Type'] || '',
    engineFull: airframe['Engine Manufacturer and Model'] || '',
    owner: owner['Owner'] || '',
    ownerType: owner['Registration Type'] || '',
    ownerAddress: ownerAddr,
    region: owner['Region'] || '',
    registrationType: details['Certification Class'] || owner['Registration Type'] || '',
    status: details['Current Status'] || '',
    certIssued: details['Certification Issued'] || '',
    airWorthiness: airWorthiness,
    lastAction: details['Last Action Taken'] || '',
    country,
    title,
    airline: routes._meta ? routes._meta.airline : '',
    liveStatus: routes._meta ? routes._meta.status : '',
    routes,
  };
}
