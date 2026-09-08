// public/route-map.js — 航路地图弹层：filed route 解析 + 地图绘制
// 依赖：Leaflet（index.html 已引入）+ app.js 提供的点击入口
// 全局提供 window.openRouteCard(callsign)
(function () {
  'use strict';

  const q = (s) => document.querySelector(s);

  // ---- 弹层元素 ----
  const modal = q('#routeModal');
  const titleEl = q('#routeCardTitle');
  const subEl = q('#routeCardSub');
  const bodyEl = q('#routeCardBody');
  const closeBtn = q('#routeCardClose');

  let map = null;
  let routeLayer = null;
  let fetchSeq = 0; // 防止过期请求覆盖新请求

  // 地图瓦片源（按序降级）：高德(国内直连) → OSM(全球兜底)
  const TILE_SETS = [
    {
      url: 'https://wprd{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
      opts: { subdomains: ['1', '2', '3', '4'], maxZoom: 18 },
      label: '高德',
    },
    {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { subdomains: ['a', 'b', 'c'], maxZoom: 19 },
      label: 'OSM',
    },
  ];
  let tileSourceIdx = 0;

  // 注入地图标记样式（避免动 style.css）
  const styleEl = document.createElement('style');
  styleEl.textContent = [
    '.ap-marker{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);}',
    '.ap-marker.ap-origin{background:#16a34a;}',
    '.ap-marker.ap-dest{background:#dc2626;}',
  ].join('\n');
  document.head.appendChild(styleEl);

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  // ---- 经纬度解析 ----
  // 支持：4700N/05000W、4700N05000W、N4700/05000W、N4700W05000
  function parseCoordToken(u) {
    const degMin = (digits) => {
      const num = parseInt(digits, 10);
      const deg = Math.floor(num / 100);
      const min = num % 100;
      return deg + min / 60;
    };
    let m =
      u.match(/^(\d{3,4})([NS])\/(\d{3,5})([EW])$/) ||
      u.match(/^(\d{3,4})([NS])(\d{3,5})([EW])$/) ||
      u.match(/^([NS])(\d{3,4})\/([EW])(\d{3,5})$/) ||
      u.match(/^([NS])(\d{3,4})([EW])(\d{3,5})$/);
    if (!m) return null;
    // 归一化成 N/E 正方向形式
    let la, lo;
    if (/^\d/.test(u)) {
      la = degMin(m[1]) * (m[2] === 'S' ? -1 : 1);
      lo = degMin(m[3]) * (m[4] === 'W' ? -1 : 1);
    } else {
      la = degMin(m[2]) * (m[1] === 'S' ? -1 : 1);
      lo = degMin(m[4]) * (m[3] === 'W' ? -1 : 1);
    }
    return [la, lo];
  }

  // ---- filed route token 分类 ----
  function classifyToken(tok, icaoFrom, icaoTo) {
    const u = (tok || '').toUpperCase();
    const c = parseCoordToken(u);
    if (c) return { kind: 'coord', label: u, lat: c[0], lon: c[1] };
    // 航路编码 / NAT 航迹：J17、A593、N175G
    if (/^[A-Z]\d{1,4}[A-Z]?$/.test(u) && /\d/.test(u)) return { kind: 'airway', label: u };
    // SID/STAR 程序：SLEEK2、LAIKS4、ELOEL3（纯字母+结尾数字）
    if (/^[A-Z]{3,6}\d$/.test(u)) return { kind: 'procedure', label: u };
    if (u === String(icaoFrom || '').toUpperCase() || u === String(icaoTo || '').toUpperCase()) {
      return { kind: 'airport', label: u };
    }
    if (/^[A-Z]{2,7}$/.test(u)) return { kind: 'fix', label: u };
    return { kind: 'other', label: u };
  }

  // ---- 大圆插值：p1/p2 = [lat, lon]，返回 n 段折线点 ----
  function gcArc(p1, p2, n) {
    n = n || 28;
    const rad = Math.PI / 180;
    const f1 = p1[0] * rad, l1 = p1[1] * rad;
    const f2 = p2[0] * rad, l2 = p2[1] * rad;
    const cf1 = Math.cos(f1), cf2 = Math.cos(f2);
    const sf1 = Math.sin(f1), sf2 = Math.sin(f2);
    const dl = l2 - l1;
    const cosDl = Math.cos(dl);
    let delta = Math.acos(Math.max(-1, Math.min(1, sf1 * sf2 + cf1 * cf2 * cosDl)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (delta < 1e-9) {
        pts.push([p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]);
        continue;
      }
      const s = Math.sin(delta);
      const a = Math.sin((1 - t) * delta) / s;
      const b = Math.sin(t * delta) / s;
      const x = a * cf1 * Math.cos(l1) + b * cf2 * Math.cos(l2);
      const y = a * cf1 * Math.sin(l1) + b * cf2 * Math.sin(l2);
      const z = a * sf1 + b * sf2;
      pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) / rad, Math.atan2(y, x) / rad]);
    }
    return pts;
  }

  // ---- Leaflet 初始化（弹层显示后再建，否则容器尺寸为 0）----
  function addTileSource() {
    const set = TILE_SETS[tileSourceIdx];
    const layer = L.tileLayer(set.url, set.opts).addTo(map);
    L.control.attribution({ prefix: false }).addAttribution(
      '地图 © ' + set.label + (tileSourceIdx === 0 ? ' · 高德' : ' · OpenStreetMap')
    ).addTo(map);
    let errors = 0;
    layer.on('tileerror', function () {
      errors += 1;
      // 连续多次加载失败 → 自动切换到下一瓦片源
      if (errors >= 4 && tileSourceIdx < TILE_SETS.length - 1) {
        map.removeLayer(layer);
        tileSourceIdx += 1;
        addTileSource();
      }
    });
    return layer;
  }

  function initMap() {
    if (map) return map;
    map = L.map('routeMap', { zoomControl: false, attributionControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    addTileSource();
    return map;
  }

  function clearRoute() {
    if (routeLayer) { routeLayer.clearLayers(); return; }
    initMap();
    routeLayer = L.layerGroup().addTo(map);
  }

  // 机场图钉
  function airportMarker(ll, cls, label) {
    const icon = L.divIcon({
      html: '<div class="ap-marker ' + cls + '">' + esc(label) + '</div>',
      className: '', iconSize: [20, 20], iconAnchor: [10, 10],
    });
    return L.marker(ll, { icon });
  }

  // ---- 主绘制 ----
  function drawRoute(data) {
    clearRoute();
    const f = data.from || {}, t = data.to || {};
    const fLL = f.coord ? [f.coord.lat, f.coord.lon] : null;
    const tLL = t.coord ? [t.coord.lat, t.coord.lon] : null;
    if (!fLL || !tLL) {
      bodyEl.innerHTML = '<span class="tip">缺少起降机场坐标，无法绘制地图。</span>';
      return;
    }

    const icaoFrom = f.icao || '', icaoTo = t.icao || '';
    const tokens = (data.route || '').trim().split(/\s+/).filter(Boolean);
    const classified = tokens.map((tk) => classifyToken(tk, icaoFrom, icaoTo));
    const coordPts = classified.filter((x) => x.kind === 'coord'); // 真实坐标航路点
    const fixes = classified.filter((x) => x.kind === 'fix');       // 名称航路点

    // 1) 起降机场
    const mkA = airportMarker(fLL, 'ap-origin', (f.code || '起').slice(0, 3));
    const mkB = airportMarker(tLL, 'ap-dest', (t.code || '达').slice(0, 3));
    mkA.bindTooltip('起 ' + (f.code || '') + ' ' + (f.name || ''), { direction: 'top' });
    mkB.bindTooltip('达 ' + (t.code || '') + ' ' + (t.name || ''), { direction: 'top' });
    mkA.addTo(routeLayer); mkB.addTo(routeLayer);

    const boundPts = [fLL, tLL];

    // 2) 真实坐标航路点 → 精确折线
    let hasReal = false;
    if (coordPts.length) {
      const chain = [fLL].concat(coordPts.map((c) => [c.lat, c.lon])).concat([tLL]);
      const line = [];
      for (let i = 0; i < chain.length - 1; i++) {
        line.push.apply(line, gcArc(chain[i], chain[i + 1], 24));
      }
      L.polyline(line, { color: '#2f9bff', weight: 3, opacity: .9 }).addTo(routeLayer);
      hasReal = true;
      coordPts.forEach((c) => {
        boundPts.push([c.lat, c.lon]);
        const mk = L.circleMarker([c.lat, c.lon], {
          radius: 6, color: '#0b7285', weight: 1.5, fillColor: '#22b8cf', fillOpacity: .9,
        });
        mk.bindTooltip('航路点 ' + c.label, { direction: 'top' });
        mk.addTo(routeLayer);
      });
    } else {
      // 3) 无真实坐标 → 大圆弧虚线示意
      const arc = gcArc(fLL, tLL, 48);
      L.polyline(arc, { color: '#8494a6', weight: 2, dashArray: '6 6', opacity: .9 }).addTo(routeLayer);
    }

    // 4) 名称航路点（无坐标）→ 沿大圆按序示意分布
    if (fixes.length) {
      const n = fixes.length;
      const arc = gcArc(fLL, tLL, n + 1);
      fixes.forEach((fx, i) => {
        const ll = arc[i + 1] || fLL; // 均匀取点，跳过两端
        boundPts.push(ll);
        const mk = L.circleMarker(ll, {
          radius: 5, color: '#e8a33d', weight: 1.5,
          fillColor: 'transparent', fillOpacity: 1, dashArray: '2 2', opacity: .8,
        });
        mk.bindTooltip('示意 ' + fx.label, { direction: 'top' });
        mk.addTo(routeLayer);
      });
    }

    // 视野
    if (boundPts.length >= 2) {
      map.fitBounds(L.latLngBounds(boundPts), { padding: [50, 50], maxZoom: 9 });
    } else {
      map.setView(fLL, 5);
    }

    // 5) 卡片正文
    let html = '';
    if (tokens.length) {
      html += '<div class="route-waypoints">' + tokens.map((tk) => {
        const c = classifyToken(tk, icaoFrom, icaoTo);
        const cls = 'route-wpt' + (c.kind === 'coord' ? ' coord' : c.kind === 'airport' ? ' airport' : '');
        const tip = c.kind === 'coord' ? (' title="' + esc(c.label) + '  =  ' + esc(c.lat.toFixed(2)) + ', ' + esc(c.lon.toFixed(2)) + '"') : '';
        return '<span class="' + cls + '"' + tip + '>' + esc(c.label) + '</span>';
      }).join('') + '</div>';
      if (hasReal) html += '<div class="tip">🔵 蓝色点为坐标航路点（真实位置）；🟡 空心点为名称航路点按序示意。</div>';
      else if (fixes.length) html += '<div class="tip">🟡 名称航路点无公开坐标，按航路顺序沿大圆航线示意分布。</div>';
    } else {
      html += '<div class="tip">该航班暂无具体航路（filed route）数据，已按大圆航线示意连接起降机场。</div>';
    }
    const meta = [];
    if (data.routeAltitude != null) meta.push('计划高度 FL' + data.routeAltitude);
    if (data.routeSpeed != null) meta.push('速度 ' + data.routeSpeed + ' kt');
    if (data.distance != null) meta.push('直飞距离 ' + data.distance + ' nm');
    if (data.fuelBurn && data.fuelBurn.pounds != null) meta.push('预估燃油 ' + data.fuelBurn.pounds.toLocaleString() + ' lb');
    if (meta.length) html += '<div class="route-metric-row">' + meta.map(esc).join('<span style="opacity:.4">|</span>') + '</div>';
    bodyEl.innerHTML = html;
  }

  // ---- 对外：点击航段后打开 ----
  async function openRouteCard(callsign) {
    if (!callsign) return;
    const mySeq = ++fetchSeq;
    show(modal);
    titleEl.textContent = callsign.toUpperCase() + ' 航路';
    subEl.innerHTML = '正在获取航路信息…　地图 © 高德';
    bodyEl.innerHTML = '<span class="tip">加载中…</span>';
    initMap();
    // 容器由 hidden 变为可见后需重新计算尺寸
    requestAnimationFrame(() => map.invalidateSize());

    try {
      const res = await fetch('/api/route?callsign=' + encodeURIComponent(callsign));
      const data = await res.json();
      if (mySeq !== fetchSeq) return; // 已被新请求覆盖
      if (!res.ok || !data.success || !data.from || !data.to) {
        throw new Error(data.error || '未查到该航班的航路信息');
      }
      const f = data.from, t = data.to;
      subEl.innerHTML =
        esc((f.code || '') + ' ' + (f.name || '')) + '　→　' +
        esc((t.code || '') + ' ' + (t.name || '')) +
        '　<span style="opacity:.5">filed route · 地图 © 高德</span>';
      titleEl.textContent = (callsign || '').toUpperCase() + ' 航路';
      drawRoute(data);
      requestAnimationFrame(() => map.invalidateSize());
    } catch (e) {
      if (mySeq !== fetchSeq) return;
      titleEl.textContent = (callsign || '').toUpperCase() + ' 航路';
      subEl.textContent = '';
      bodyEl.innerHTML = '<span class="tip" style="color:var(--err)">' + esc(e.message) + '</span>';
    }
  }

  function closeCard() {
    hide(modal);
  }

  closeBtn.addEventListener('click', closeCard);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeCard();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeCard();
  });

  // ---- 航段点击委托（route-q-btn 与 seg-click 都打开地图卡片）----
  document.addEventListener('click', (e) => {
    const qbtn = e.target.closest('.route-q-btn');
    if (qbtn) { e.preventDefault(); openRouteCard(qbtn.dataset.callsign); return; }
    const seg = e.target.closest('.seg-click');
    if (seg) { e.preventDefault(); openRouteCard(seg.dataset.callsign); }
  });

  window.openRouteCard = openRouteCard;
})();
