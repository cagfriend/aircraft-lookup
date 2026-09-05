const $ = (sel) => document.querySelector(sel);

// ===== 主题切换 =====
const THEME_KEY = 'aircraft-lookup-theme';
const htmlEl = document.documentElement;
const themeBtn = $('#themeToggle');

function applyTheme(theme) {
  if (theme === 'light') {
    htmlEl.classList.add('light');
    themeBtn.textContent = '☀️';
    themeBtn.title = '切换到夜间主题';
  } else {
    htmlEl.classList.remove('light');
    themeBtn.textContent = '🌙';
    themeBtn.title = '切换到日间主题';
  }
}

// 初始化：读取存储的主题偏好
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

themeBtn.addEventListener('click', () => {
  const next = htmlEl.classList.contains('light') ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ===== 搜索历史 =====
const HISTORY_KEY = 'aircraft-lookup-history';
const MAX_HISTORY = 5;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }
function addToHistory(reg, aircraft, operator, photo) {
  const h = loadHistory().filter(x => x.reg !== reg);
  h.unshift({
    reg,
    type: aircraft?.fullType || '',
    airline: operator?.airline || '',
    year: aircraft?.year,
    thumb: photo?.thumb || '',
    time: Date.now()
  });
  saveHistory(h.slice(0, MAX_HISTORY));
  renderHistory();
}
function removeFromHistory(reg) {
  saveHistory(loadHistory().filter(x => x.reg !== reg));
  renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  const el = $('#history');
  if (!h.length) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<div class="history-label">最近搜索：</div>' +
    '<div class="history-list">' +
    h.map(x => {
      const img = x.thumb
        ? `<img class="history-img" src="${esc(imgUrl(x.thumb))}" onerror="this.outerHTML='&lt;div class=&quot;history-img history-img-empty&quot;&gt;&lt;/div&gt;'" alt="" />`
        : '<div class="history-img history-img-empty"></div>';
      const meta = [x.airline, x.year ? `${x.year} 年` : ''].filter(Boolean).join(' · ');
      return `<div class="history-item" data-reg="${esc(x.reg)}">
        ${img}
        <div class="history-info">
          <div class="history-main">
            <span class="history-reg">${esc(x.reg)}</span>
            <span class="history-type">${esc(x.type)}</span>
          </div>
          ${meta ? `<div class="history-sub">${esc(meta)}</div>` : ''}
        </div>
        <button class="history-del" data-del="${esc(x.reg)}" title="删除记录">×</button>
      </div>`;
    }).join('') +
    '</div>';
}
$('#history').addEventListener('click', (e) => {
  const del = e.target.closest('.history-del');
  if (del) { e.stopPropagation(); removeFromHistory(del.dataset.del); return; }
  const item = e.target.closest('.history-item');
  if (item) { regInput.value = item.dataset.reg; runSearch(item.dataset.reg); }
});

// 刷新按钮（忽略缓存）
$('#refreshBtn').addEventListener('click', () => {
  const reg = $('#regBadge')?.textContent;
  if (reg) runSearch(reg, { forceRefresh: true });
});

// ===== 查询 =====
const NEAR_KM = 10;

const searchForm = $('#searchForm');
const regInput = $('#regInput');
const searchBtn = $('#searchBtn');
const loadingEl = $('#loading');
const errorEl = $('#error');
const resultEl = $('#result');

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await runSearch(regInput.value.trim());
});

async function runSearch(reg, { forceRefresh = false } = {}) {
  if (!reg) { showError('请输入飞机注册号'); return; }
  hide(resultEl);
  hide(errorEl);
  show(loadingEl);
  searchBtn.disabled = true;
  try {
    const url = `/api/query?reg=${encodeURIComponent(reg)}${forceRefresh ? '&refresh=1' : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '未查询到该飞机，请检查注册号。');
    }
    render(data);
    show(resultEl);
    addToHistory(data.reg, data.aircraft, data.operator, data.photo);
  } catch (err) {
    showError(err.message || '查询失败，请稍后重试。');
  } finally {
    hide(loadingEl);
    searchBtn.disabled = false;
  }
}

function showError(msg) {
  hide(resultEl);
  errorEl.textContent = msg;
  show(errorEl);
}

function imgUrl(url) {
  return `/api/img?url=${encodeURIComponent(url)}`;
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function render(d) {
  const a = d.aircraft;
  // 注册号与主信息
  $('#regBadge').textContent = d.reg.toUpperCase();
  $('#fullType').textContent = a.fullType || '未知机型';

  // facts
  const facts = [
    ['航空公司', d.operator && d.operator.airline],
    ['制造商', a.manufacturer],
    ['机型', a.model],
    ['出厂年份', a.year ? `${a.year} 年` : '未知'],
    ['机身序号', a.cn],
    ['注册国', a.country],
    ['ICAO24', a.icao24 ? a.icao24.toUpperCase() : '—'],
    ['类别', a.aircraftType],
    ['注册状态', a.status],
  ].filter(([k, v]) => v);
  $('#facts').innerHTML = facts.map(([k, v]) =>
    `<div class="fact"><div class="label">${esc(k)}</div><div class="value">${esc(v)}</div></div>`
  ).join('');

  // photo —— 只显示一张主图；主图失败自动降级到缩略图
  const photoEl = $('#photo');
  const fb = $('#photoFallback');
  const credit = $('#photoLink');
  const hideCredit = () => { credit.hidden = true; };
  const setFallback = (msg) => { fb.textContent = msg; fb.hidden = false; photoEl.hidden = true; hideCredit(); };
  const showPhoto = () => { photoEl.hidden = false; fb.hidden = true; credit.hidden = false; };

  if (d.photo && d.photo.url) {
    const candidates = [d.photo.url, d.photo.thumb].filter(Boolean);
    let ci = 0;
    hideCredit();
    photoEl.onload = () => showPhoto();
    photoEl.onerror = () => {
      ci += 1;
      if (ci < candidates.length) {
        photoEl.src = imgUrl(candidates[ci]); // 换缩略图重试
      } else {
        setFallback('照片加载失败（图源暂时不可达）');
      }
    };
    photoEl.src = imgUrl(candidates[0]);
    credit.href = d.photo.link || '#';
    credit.textContent = `图片来源 (${d.photo.count || 1} 张)`;
  } else {
    setFallback('暂无照片');
  }

  // metrics
  const age = a.age;
  $('#ageValue').textContent = age != null ? `${age} 年` : '未知';
  $('#yearValue').textContent = a.ageYear ? `出厂年份 ${a.ageYear}` : '';
  $('#manufacturerValue').textContent = a.manufacturer || '—';
  $('#cnValue').textContent = a.cn || '—';
  $('#countryValue').textContent = a.country || '—';
  $('#icaoValue').textContent = a.icao24 ? `ICAO24: ${a.icao24.toUpperCase()}` : '';

  renderCurrentRoute(d.currentRoute, a);
  renderLive(d.live);
  renderRoutes(d.routes);
  renderTech(a);
  renderSources(d.sources);
}

function renderCurrentRoute(cr, a) {
  const box = $('#currentRoute');
  const note = $('#routeNote');
  const nearText = (n) => (n ? `${n.iata} ${n.name || n.city || ''} (~${n.distKm}km)` : '');
  const nearOk = (n) => !!(n && n.distKm <= NEAR_KM);
  if (!cr || (!cr.from.code && !cr.to.code && !cr.callsign && !cr.near)) {
    box.innerHTML = '<div style="color:var(--muted)">暂无近期执飞航线信息</div>';
    note.textContent = '';
    return;
  }
  let routeHtml = '';
  if (cr.from.code || cr.to.code) {
    const fromName = cr.from.name || cr.from.code || '';
    const toName = cr.to.name || cr.to.code || '';
    routeHtml = `
      <div class="route-end"><div class="code">${esc(cr.from.code || '—')}</div><div class="name">${esc(fromName)}</div></div>
      <div class="route-arrow">✈ →</div>
      <div class="route-end"><div class="code">${esc(cr.to.code || '—')}</div><div class="name">${esc(toName)}</div></div>`;
  } else if (cr.callsign) {
    routeHtml = `<div class="route-q-wrap"><button class="route-q-btn" type="button" data-callsign="${esc(cr.callsign)}">🔍 查询该航班起降机场</button></div>`;
  } else if (nearOk(cr.near)) {
    routeHtml = `<div class="route-meta" style="margin-top:0"><span>最近机场：<b>${esc(nearText(cr.near))}</b></span></div>`;
  }
  const nearMeta = nearOk(cr.near) && (cr.from.code || cr.to.code)
    ? `<span>最近机场：<b>${esc(nearText(cr.near))}</b></span>` : '';
  box.innerHTML = routeHtml + `
    <div class="route-meta">
      <span>呼号：<b>${esc(cr.callsign || '—')}</b></span>
      <span>航班号：<b>${esc(cr.flightNumber || '—')}</b></span>
      <span>时间：<b>${esc(cr.time || '—')}</b></span>
      <span>速度：<b>${esc(cr.speed || '—')}</b></span>
      <span>航向：<b>${esc(cr.heading || '—')}</b></span>
      ${nearMeta}
    </div>`;
  note.textContent = '';
}

function renderLive(live) {
  const box = $('#liveBox');
  const nearText = (n) => (n ? `${n.iata} ${n.name || n.city || ''} (~${n.distKm}km)` : '');
  const nearOk = (n) => !!(n && n.distKm <= NEAR_KM);
  if (!live || !live.airborne) {
    const n = (live && live.note) || '该机当前未在空中。';
    let lastSeenHtml = '';
    if (live && live.lastSeen && (live.lastSeen.lat != null || live.lastSeen.lon != null)) {
      const ls = live.lastSeen;
      const pos = (ls.lat != null && ls.lon != null) ? `${ls.lat}, ${ls.lon}` : '—';
      const nearChip = nearOk(ls.near) ? `<span>最近机场：<b>${esc(nearText(ls.near))}</b></span>` : '';
      lastSeenHtml = `<div class="route-meta" style="margin-top:10px">
        <span>最近记录坐标：<b>${esc(pos)}</b></span>
        ${nearChip}
        <span>时间：<b>${esc(ls.time || '—')}</b></span>
        <span>呼号：<b>${esc(ls.callsign || '—')}</b></span>
        <span>地速：<b>${esc(ls.speed || '—')}</b></span>
        <span>航向：<b>${esc(ls.heading || '—')}</b></span>
      </div>`;
    }
    box.innerHTML = `<span class="badge-status off">未在空中</span><div class="route-note">${esc(n)}</div>${lastSeenHtml}`;
    return;
  }
  const gps = (live.latitude != null && live.longitude != null)
    ? `${live.latitude.toFixed(4)}, ${live.longitude.toFixed(4)}` : '—';
  const chips = [
    ['呼号', live.callsign],
    ['是否在地面', live.onGround ? '是' : '否'],
    ['气压高度', live.altitudeBaro != null ? `${Math.round(live.altitudeBaro)} ft` : '—'],
    ['地速', live.groundSpeedKnots != null ? `${live.groundSpeedKnots} kt` : '—'],
    ['航向', live.heading != null ? `${Math.round(live.heading)}°` : '—'],
    ['应答机', live.squawk || '—'],
    ['位置', gps],
    ['最近机场', nearOk(live.near) ? nearText(live.near) : '—'],
    ['起飞国', live.originCountry || '—'],
  ];
  box.innerHTML = `<span class="badge-status on">在空中</span>` + chips.map(([k, v]) =>
    `<div class="live-chip"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`
  ).join('');
}

function renderRoutes(routes) {
  const tb = $('#routesBody');
  if (!routes || routes.length === 0) {
    tb.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">暂无近期执飞记录</td></tr>';
    return;
  }
  tb.innerHTML = routes.map((r) => {
    const hasRoute = r.from.code || r.to.code;
    const canQuery = !hasRoute && (r.callsign || r.flightNumber);
    let seg;
    if (hasRoute) {
      seg = `${r.from.code ? `${r.from.code} ${r.from.name || ''}` : ''}${r.from.code && r.to.code ? ' → ' : ''}${r.to.code ? `${r.to.code} ${r.to.name || ''}` : ''}`;
    } else if (canQuery) {
      seg = `<button class="route-q-btn" type="button" data-callsign="${esc(r.callsign || r.flightNumber)}">🔍 查起降机场</button>`;
    } else if (r.near && r.near.distKm <= NEAR_KM) {
      seg = `近 ${r.near.iata} ${r.near.name || r.near.city || ''} (~${r.near.distKm}km)`;
    } else if (r.lat != null && r.lon != null) {
      seg = `坐标 ${r.lat}, ${r.lon}`;
    } else {
      seg = '—';
    }
    return `<tr>
      <td>${esc(r.time || '')}</td>
      <td>${esc(r.callsign || '—')}</td>
      <td>${esc(r.flightNumber || '—')}</td>
      <td class="fromto">${seg}</td>
      <td>${esc(r.speed || '—')}</td>
      <td>${esc(r.heading || '—')}</td>
    </tr>`;
  }).join('');
}

function renderTech(a) {
  const items = [
    ['机型代号', a.model],
    ['类别', a.aircraftType],
    ['座位数', a.seats],
    ['发动机数', a.engines],
    ['发动机类型', a.engineType],
    ['发动机型号', a.engineFull],
    ['注册类型', a.ownerType],
    ['所有者', a.owner],
    ['所有者地址', a.ownerAddress],
    ['所属区域', a.region],
    ['适航证日期', a.airWorthiness],
    ['注册证书日期', a.certIssued],
    ['最后动作', a.lastAction],
    ['注册状态', a.status],
    ['ICAO24', a.icao24 ? a.icao24.toUpperCase() : ''],
  ].filter(([k, v]) => v && v !== '—');
  const grid = $('#techInfo');
  grid.innerHTML = items.map(([k, v]) =>
    `<div class="kv"><div class="label">${esc(k)}</div><div class="value">${esc(v)}</div></div>`
  ).join('');
}

function renderSources(s) {
  const el = $('#sources');
  if (!s) { el.innerHTML = ''; return; }
  const labels = { 'airport-data': '机型/机龄/航线/注册信息', planespotters: '照片', opensky: '实时位置' };
  el.innerHTML = Object.entries(s).map(([k, v]) => {
    const ok = v === 'ok';
    return `<span class="src ${ok ? 'ok' : 'bad'}">${esc(labels[k] || k)}：${esc(ok ? '可用' : v)}</span>`;
  }).join('');
}

// ===== 单条航班起降机场查询（用户点击按钮）=====
async function queryRouteOnClick(btn) {
  const callsign = btn.dataset.callsign;
  if (!callsign) return;
  btn.disabled = true;
  btn.textContent = '查询中…';
  try {
    const res = await fetch(`/api/route?callsign=${encodeURIComponent(callsign)}`);
    const data = await res.json();
    if (res.ok && data.success && data.from && data.to) {
      const txt = `${data.from.code} ${data.from.name || ''}  →  ${data.to.code} ${data.to.name || ''}`;
      // 找到容纳该按钮的容器（当前航线卡片或表格单元格）
      const zone = btn.closest('.route-q-wrap') || btn.closest('td');
      if (zone) {
        zone.innerHTML = `<span class="route-filled">✈ ${esc(txt)}</span>`;
      } else {
        btn.textContent = txt;
        btn.disabled = false;
      }
    } else {
      btn.textContent = '未查到，重试';
      btn.disabled = false;
      btn.classList.add('err');
    }
  } catch (e) {
    btn.textContent = '查询失败，重试';
    btn.disabled = false;
    btn.classList.add('err');
  }
}

// 事件委托：整页监听按钮点击（表格行与当前航线都可能出现）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.route-q-btn');
  if (btn) queryRouteOnClick(btn);
});

// 初始化历史记录 + URL 参数自动查询
renderHistory();
if (window.location.search) {
  const p = new URLSearchParams(window.location.search);
  const q = p.get('reg') || p.get('q');
  if (q) { regInput.value = q; runSearch(q); }
}
