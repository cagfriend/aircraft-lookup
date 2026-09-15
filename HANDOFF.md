# HANDOFF — 航空器注册号查询工具（交接文档）

> 给下一个 AI 会话 / 开发者的完整交接。包含：项目全貌、**每个文件的用途**、核心逻辑、部署信息、环境变量、踩过的坑、当前状态与待办。
> 最后更新：见 git log（本文件随代码一起版本管理）。

---

## 0. 一句话概览

输入飞机注册号 → 展示**机型 / 机龄 / 执飞航段 / 航路地图（含航路点、真实轨迹）/ 实时位置 / 照片 / 最近机场**。

| 项 | 值 |
|---|---|
| 线上地址 | **https://searchplane.site**（Cloudflare Worker，免费版，国内可直连） |
| GitHub | **https://github.com/cagfriend/aircraft-lookup**（分支 `main`） |
| 本地开发 | `D:\aircraft-lookup`，`npm start` → **http://127.0.0.1:3000** |
| 健康检查 | https://searchplane.site/api/health |
| 域名/DNS | 域名在**腾讯云**购买，NS 指向 Cloudflare（`michelle.ns.cloudflare.com` / `kenneth.ns.cloudflare.com`） |

---

## 1. 技术形态（关键）

**同一套 `src/` 核心逻辑，两个入口**：

| 环境 | 入口 | 说明 |
|---|---|---|
| 本地 | `server.js`（Express） | 静态托管 `public/` + `/api/*` 路由 |
| 线上 | `src/worker.js`（Cloudflare Worker） | 只处理 `/api/*`；`public/` 由 Cloudflare assets 托管 |

⚠️ **Cloudflare 创建向导产出的是 Worker，不是 Pages**。曾误用 `functions/`（Pages Functions）导致 `Missing entry-point`，最终采用 **Worker 单入口 + assets** 形态（`wrangler.jsonc` 里 `main` + `assets.directory`）。

### 双环境兼容要点（改代码务必注意）

- `src/fetch.js` 用 `IS_NODE` 判断：Node 走 `node:http/https`（强制 IPv4、可发 POST），Worker 走全局 `fetch`。
- **Worker 里没有 `process`**：读环境变量必须用安全封装（见 `src/opensky.js` / `src/fixlookup.js` 的 `env()`：先试 `process.env`，再试 `globalThis.env`）。**顶层直接用 `process.env` 会让部署失败**（踩过）。
- **Worker 里 GET 请求不能带 `body` 字段**（哪怕值是 `undefined`），否则所有对外抓取抛错（踩过）。
- 变量不要遮蔽：`envFetch(url, { body })` 内部再 `const body = ...` 会 TDZ 报错（踩过，且本地测不出来）。

---

## 2. 目录与文件用途（全部）

```
D:\aircraft-lookup\
├─ server.js              # 本地 Express 入口：静态托管 + /api/* 路由
├─ wrangler.jsonc         # Cloudflare Worker 配置（main / assets / observability）
├─ package.json           # Node>=18；type=module；start=node server.js
├─ README.md              # 面向用户的说明
├─ HANDOFF.md             # 本文件
├─ start.bat / start.sh   # 一键启动
├─ launch.ps1             # Windows 启动脚本
├─ public/                # 前端（线上作为 Cloudflare assets）
│  ├─ index.html          # 页面结构（含航路地图弹层 DOM）
│  ├─ style.css           # 深/浅双主题 CSS 变量 + 全部样式
│  ├─ app.js              # 主前端：查询/渲染/主题/搜索历史/航段可点击
│  ├─ route-map.js        # 航路地图弹层（Leaflet）：航路点解析、轨迹绘制、瓦片降级
│  ├─ data/
│  │  └─ fixes.data.js    # 【航路点数据库】约 3.2MB，11.5 万 ident，懒加载
│  └─ vendor/leaflet/     # Leaflet 1.9.4（本地托管，避免 CDN 被墙）
└─ src/                   # 核心逻辑（本地与云端共用）
   ├─ worker.js           # Cloudflare Worker 入口（/api/* 路由）
   ├─ aggregate.js        # 编排各数据源 + 机龄 + 缓存 + 最近机场 + 国家
   ├─ airportdata.js      # airport-data.com 抓取解析（cheerio）★核心
   ├─ planespotters.js    # planespotters.net 照片
   ├─ opensky.js          # OpenSky：中转优先、直连兜底的实时状态 + 真实轨迹 + 历史航班（OAuth2）
   ├─ flightroute.js      # FlightAware：filed route + 历史航班（按需）
   ├─ fixlookup.js        # OpenNav 在线航路点（可选，需 token）
   ├─ airports.js         # 最近机场匹配（Haversine）
   ├─ airports.data.js    # 9057 个机场数据（由 airports.json 生成，import 用）
   ├─ airports.json       # 机场源数据
   ├─ fetch.js            # HTTP 客户端（GET/POST，双环境，强制 IPv4）
   └─ register.js         # 注册号规范化 + 连字符变体

  proxy\
    opensky-proxy.js      # 部署在非 Cloudflare Node/VPS 的 OpenSky 安全中转
```

---

## 3. 核心逻辑

### 3.1 数据流总览

```
【主查询】GET /api/query?reg=X
  register.js 规范化（B7973 → B-7973 等连字符变体）
   → airportdata.js  airport-data.com  → 机型/机龄/C-N/发动机/所有者/ICAO24/执飞航段(最多15条)
   → planespotters.js planespotters.net → 照片
   → opensky.js       OpenSky(states)  → 实时位置（云端不可达时会降级，见 §6）
   → airports.js      9057 机场坐标     → 最近机场（Haversine，≤10km 才算"在机场附近"）
   → aggregate.js     机龄计算 + 30 分钟内存缓存 + 国家兜底
   → JSON：{ success, reg, aircraft, operator, photo, live, currentRoute, routes[], sources }

【航路地图】用户点击航段 → GET /api/route?callsign=X&icao24=Y   ← 三个源并行
   ├─ flightroute.js    FlightAware 页面内嵌 trackpollBootstrap JSON
   │     → from/to(含坐标) + filed route 字符串 + 高度/速度/燃油/距离 + historicalFlights(全部历史航班)
   ├─ opensky.js        /api/tracks/all  → 真实飞行轨迹（点序列，抽稀≤240）
   └─ opensky.js        /api/flights/aircraft → 历史航段（需凭据）
   → 前端 route-map.js：绘地图 + 解析航路点坐标 + 画线
```

### 3.2 各模块关键算法 / 参数

| 模块 | 关键点 |
|---|---|
| `register.js` | 规范化：去空格转大写；`reg`（纯字母数字，用于展示/去重）+ `query`（保留连字符，用于外网） |
| `airportdata.js` | cheerio 解析 4 类表格；**多构造表按标题 C/N 匹配当前那架**（解决注册号复用串数据）；连字符变体逐个尝试；缺失国家时用 `countryFromRegistration()` 按注册号前缀推断（B=中国、N=美国、JA=日本…） |
| `aggregate.js` | 机龄 = 当前年 - 出厂年；**缓存 Map，TTL 30 分钟**；`forceRefresh`(`?refresh=1`) 绕过 |
| `flightroute.js` | 正则提取 `<script>var trackpollBootstrap = {...}</script>`；`pickLatestFlight()` 优先取**有 route** 的最近航班；`extractAllFlights()` 提取全部历史航班；**节流 1.2s/次**、**缓存 6 小时**、页面抓取 timeout 10s、失败重试 2 次 |
| `opensky.js` | OpenSky 中转优先、直连兜底；OAuth2 client credentials；token 内存缓存（30 分钟，提前 2 分钟刷新）+ **失败负缓存 5 分钟**；`OS_TIMEOUT=6s`（`OPENSKY_TIMEOUT_MS` 可调）；直连熔断 5 分钟，中转失败熔断 1 分钟；轨迹抽稀（默认≤240 点，保留首尾） |
| `fixlookup.js` | OpenNav 在线航路点；**缓存 7 天**；无 `OPENNAV_TOKEN` 时直接返回 null |
| `airports.js` | Haversine 求最近机场；`NEAR_KM=10`（前端判定"在机场附近"） |
| `fetch.js` | 强制 IPv4（规避只返回 IPv6 导致超时）；默认 UA 为 Chrome；`redirects` 上限 6；超时默认 15s |

### 3.3 前端 `route-map.js`（最复杂的一块）

职责：地图弹层、航路点解析、绘制。

1. **懒加载** `/data/fixes.data.js`（全球航路点，约 3.2MB）与 `/data/us-cifp.data.js`（FAA CIFP，美国航路/SID/STAR/终端航路点，约 3.0MB）
2. **FAA CIFP 展开**：`expandCifpRoute()` 仅在相邻端点均能确认时展开美国航路；SID 使用公共出口段，STAR 优先选与相邻点匹配的入口转换段并衔接公共段。CIFP 数据周期为 AIRAC 2609。
3. **token 分类** `classifyToken()`：`coord`(4700N/08000W) / `airway`(J17、A1、Y807) / `procedure`(SLEEK2、LAIKS4) / `airport` / `fix`(纯字母) ；去掉开头可能的 + 或 - 前缀
4. **航路点解析** `resolveSequential()` ★关键：
   - 按路线顺序逐点解析，用**上一个已确定点**作参考就近选候选（解决同名点如 ABI/BRADD/PNH 全球多处）
   - **离群过滤**：最近候选仍超过 `max(1200, 期望段长×3) km`（上限 4000km）→ 丢弃不上图
   - 被丢弃的点会在卡片里列出
5. **经度处理**：`unwrapLng()` 展开跨日界线的经度（否则跨太平洋画成横穿地图的直线）；`alignToFrame()` 把轨迹对齐到航线同一世界副本；机场+航路点+折线统一 `chainFrame`
6. **大圆插值** `gcArc()`：球面线性插值，用于无航路时的兜底弧线
7. **瓦片降级链**：高德 → OpenStreetMap → CARTO；连续 3 次 tileerror 或 6s 无 tileload即切换；版权只显示当前源
8. **绘制语义**：🟢 绿线 = OpenSky 真实轨迹；🔵 蓝线/蓝点 = filed route 航路点；🟡 空心 = 未收录点示意；灰虚线 = 大圆兜底
9. 打开弹层时把当前机 ICAO24（`window.__aircraftIcao24`，由 `app.js` 在 render 时写入）带给后端

---

## 4. API 参考

| 接口 | 参数 | 返回 |
|---|---|---|
| `GET /api/health` | — | `{ ok, time }` |
| `GET /api/query` | `reg`(必), `refresh=1`(可选，绕过缓存) | `{ success, reg, aircraft{...}, operator, photo, live, currentRoute, routes[], sources }` |
| `GET /api/route` | `callsign`(必), `icao24`(可选，用于 OpenSky) | `{ success, callsign, colo, from, to, icaoFrom, icaoTo, route, routeAltitude, routeSpeed, fuelBurn, distance, historicalFlights[], track{points[]}, trackError, openskyFlights[], openskyFlightsError }` |
| `GET /api/fix` | `ident` | `{ success, ident, lat, lon }`（需 `OPENNAV_TOKEN`，否则 404） |
| `GET /api/img` | `url` | 图片流（**白名单仅 planespotters 域名**，防盗链+防开放代理） |

**缓存策略**：`/api/query` → `max-age=300`；`/api/route` → `max-age=1800`；`/api/fix` → `max-age=86400`。
> 注意：`/api/route` 的 30 分钟浏览器缓存曾造成"桌面正常、手机报错"的错觉（见 §7）。

---

## 5. 航路点数据库（`public/data/fixes.data.js`）

- **规模**：约 **115,575 个 ident / 123,958 个坐标**，文件约 3.2MB，前端懒加载
- **来源**（合并去重，优先级 FAA > navaids > 抓取）：
  1. **FAA NASR fixes**（`@squawk/fix-data`，67,610 条，美国/北大西洋命名航路点）
  2. **OurAirports navaids**（`navaids.csv`，11,008 条，全球 VOR/NDB/TACAN）
  3. **OpenNav 抓取**（`FayyazAK/Global-Aviation-Waypoints`，51,043 条，部分国际点）
- **格式**：`window.AIRCRAFT_FIXES = { "SLEEK":[38.063,-103.686], "ABI":[[32.481,-99.864],[11.55,43.155]], ... }`
  - 单坐标 → `[lat,lon]`；**同名多点 → 数组**（前端按航线就近选择）
- **覆盖局限**：南美等部分国际命名点缺失（如 ALTIB / VIICE2 / UM779）；VOR 类基本齐全
- **在线补充**：`/api/fix`（OpenNav，需 `OPENNAV_TOKEN`）；未收录点最后走"按序示意分布"

### FAA CIFP 美国航路索引（`public/data/us-cifp.data.js`）

- 由 FAA 公布的 `FAACIFP18`（ARINC 424）生成；当前 AIRAC 2609。
- 含 71,252 个航路/终端航路点、1,504 条航路、4,043 个 SID/STAR；文件约 3.0MB，地图首次打开时懒加载。
- 构建：`node scripts/build-us-cifp.mjs <FAACIFP18路径> <AIRAC周期>`；验证：`npm run verify:cifp`。
- 仅覆盖美国。全球完整程序与航路仍需要具备相应授权的国际 AIRAC 数据源。

---

## 6. 环境变量

| 变量 | 用途 | 必需性 |
|---|---|---|
| `OPENSKY_CLIENT_ID` | OpenSky OAuth2 客户端 ID | 可选（不配则匿名配额 400/天；历史航班不可用） |
| `OPENSKY_CLIENT_SECRET` | OpenSky OAuth2 密钥 | 可选 |
| `OPENSKY_TIMEOUT_MS` | OpenSky 请求超时（默认 6000） | 可选 |
| `OPENSKY_PROXY_BASE` | 非 Cloudflare OpenSky 中转基址（Worker 优先尝试） | 可选 |
| `OPENSKY_PROXY_TOKEN` | Worker 与中转共享的随机长密钥 | 配置中转时必填 |
| `OPENSKY_PROXY_PORT` | 中转本机端口，默认 8788 | 仅中转主机 |
| `OPENNAV_TOKEN` | OpenNav 在线航路点查询 | 可选 |
| `OPENNAV_API_BASE` | OpenNav 接口基址（默认 `https://opennav.ai`） | 可选 |
| `PORT` | 本地 Express 端口（默认 3000） | 可选 |

- 获取 OpenSky 凭据：账号 → Account 页 → 创建 API client（OAuth2 **只支持 client credentials**，用户名密码已废弃）
- **Cloudflare**：在 Worker 的 Settings → Variables/Secrets 配置同名变量
- 代码里读环境变量务必用 `env()` 安全封装（Node 用 `process.env`，Worker 用 `globalThis.env`）

---

## 7. ⚠️ 已知问题（重要）

| 问题 | 状态 / 原因 |
|---|---|
| **OpenSky 从 Cloudflare Worker 不可达** | 实测 `opensky-network.org` 的 states/tracks/auth 全部超时，25s 时返回 **HTTP 522**（CF 边缘连不上 OpenSky 源站；OpenSky 自身托管在 Cloudflare 后面）。已实现 `proxy/opensky-proxy.js`：部署在可直连 OpenSky 的非 Cloudflare Node/VPS，Worker 配 `OPENSKY_PROXY_BASE` / `OPENSKY_PROXY_TOKEN` 后会优先经中转请求；中转失败短熔断后再回落直连与 UI 降级。中转主机配置 `OPENSKY_*` 凭据可启用历史航班。<br>替代源实测：`api.adsb.lol` 429 限流、`opendata.adsb.fi` 403、`api.adsbdb.com` 200（仅机型信息） |
| **"某设备正常、某设备报错"** | 两个原因叠加：① 服务端曾有故障窗口（`fetch.js` 的 body 遮蔽 bug）② `/api/route` 有 **30 分钟浏览器缓存**，先成功过的设备读缓存看起来一直正常，新请求才暴露。已加 **`colo` 字段**（Cloudflare 机房标识）与错误提示中的机房号，便于定位 |
| 部分航路点无数据 | OXASA / ENVOP / LALID / ELNIS / IBENO 等数据库未收录 |
| FlightAware 抓取成本 | 页面约 500KB / 7–26s，有反爬风险；已节流 1.2s + 缓存 6h |
| airport-data.com 限流 | 本地 IP 高频抓取会 403，隔段时间恢复；**Cloudflare 出口不受影响**。调试别刷爆 |
| 移动端底图 | 部分网络下 OSM 被墙 → 已做三源降级；高德在部分网络不可用 |

---

## 8. 部署信息

- **自动部署**：推送 `main` → Cloudflare 自动构建部署（约 **45–90 秒**生效）
- **推送前提**：需要 VPN / 代理（clash `127.0.0.1:7897`），git 已配 proxy；**代理时断时续，push 需重试循环**
- **验证方法**：改完等 60s，用 `curl` 拉线上资源确认新版已生效（前端资产可能要 Ctrl+F5）
- **静态资产**：`public/` 全部作为 assets 上传（单个文件上限 25MiB，3.2MB 的 fixes.data.js 无问题）
- **重要**：Cloudflare 部署失败时会**保留上一个成功版本**，表现为"线上没更新"——此时查 Worker 是否运行时抛错（可用临时诊断端点，用完删除）

`wrangler.jsonc` 要点：
```jsonc
{
  "name": "aircraft-lookup",
  "main": "src/worker.js",
  "compatibility_date": "2025-09-01",
  "assets": { "directory": "public", "not_found_handling": "single-page-application" },
  "observability": { "enabled": true }
}
```

---

## 9. 常用命令与验证

```bash
npm start                                # 本地 http://127.0.0.1:3000
npm run dev                              # node --watch
git push origin main                     # 需代理；断了就重试

# 线上验证
curl https://searchplane.site/api/health
curl "https://searchplane.site/api/query?reg=B-5976"
curl "https://searchplane.site/api/route?callsign=UAL456&icao24=<hex>"

# 本地语法检查（改完必做）
node --check src/*.js server.js public/app.js public/route-map.js
```

**推荐测试样本**：
- `B-5976`（东航 A330，机龄/航段全）
- `UAL456`（DEN→AUS，filed route 完整，历史航班 23 条）
- `CAL011`（JFK→TPE 跨极地，验证经度展开与航路点解析）
- `9M-MTK`（马航 A330，航段 from/to 为空、只有呼号 → 验证"查看航路地图"路径）

---

## 10. 待办 / 可继续的方向

| 优先级 | 事项 |
|---|---|
| P1 | 解决 OpenSky 云端不可达：① 自建中转（本地/VPS 反代）② 换可达的 ADS-B 源 ③ 接受现状 |
| P1 | 配置 `OPENSKY_CLIENT_ID/SECRET`（本地开发立刻可用） |
| P2 | 前端展示 `historicalFlights`（已返回 20+ 条历史航班，尚未在 UI 列表化） |
| P2 | 非美国航路点覆盖：配 `OPENNAV_TOKEN` 或补充 fixes 数据库 |
| P3 | 主题"到点自动切换（无需刷新）" |
| P3 | 鸿蒙 App（分析已完成：方案 A WebView 壳 → 方案 B ArkTS 原生 + 复用 Worker API） |

---

## 11. 变更此项目时的检查清单

1. [ ] 改 `src/fetch.js` → **必须**验证线上 `/api/query`（Worker 与 Node 行为不同）
2. [ ] 新增环境变量读取 → 用 `env()` 封装，勿顶层 `process.env`
3. [ ] 改前端 → 检查移动端（缓存/底图/触控）
4. [ ] 涉及跨日界线航线 → 用 `CAL011` / `UAL805` 验证
5. [ ] 改航路点解析 → 用 `node --check` + 实际航线对比（同名点是否错位）
6. [ ] 部署后等 60s，线上实测确认（**注意浏览器 30 分钟缓存**）
7. [ ] 重要结论更新到本文件
