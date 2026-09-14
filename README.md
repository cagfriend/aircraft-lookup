# ✈ 航空器详情查询 (Aircraft Lookup)

输入飞机注册号，即刻查询该机的**机型、机龄、执飞航线**等关键信息。

**🌐 线上地址：[https://searchplane.site](https://searchplane.site)**

Node.js + Express 后端聚合多个公开数据源，前端原生 HTML/CSS/JS，部署于 Cloudflare Workers（免费）。

## 功能

### 核心查询
- **机型**：制造商、机型号、类别、座位数、发动机数、发动机型号
- **机龄**：由出厂年份 / 适航测试日期自动计算
- **执飞航线**：当前（最近）航班及最近执飞记录（起降机场、航班号、呼号、速度、航向）
- **最近机场匹配**：当数据源未给出起降机场时，用记录的经纬度反查**最近机场**（基于 OurAirports 全球 9000+ 商业机场数据库，本地球面距离计算）
- **注册信息**：机身序号 (C/N)、注册国、ICAO24（Mode-S）、所有者、注册状态、适航日期
- **实时状态**：ADS-B 位置数据（经纬度、高度、地速、航向、应答机、国家与地区）；不在空中时显示最近记录坐标及最近机场
- **飞机照片**：planespotters.net 提供，主图加载失败自动降级到缩略图

### 交互功能
- **主题定时切换**：默认按**北京时间(GMT+8)**自动切换——`06:00-19:00` 浅色（白色），其余时段深色；右上角 🌙/☀️ 仍可手动切换（手动选择在 localStorage 中记忆）
- **深色 / 浅色双主题**：右上角手动切换，偏好保存在 localStorage
- **搜索历史**：自动保存最近 5 条搜索（含缩略图、注册号、机型、航司、年份），点击可快速复查
- **按需查询起降机场**：缺失起降机场的记录行显示"🔍 查起降机场"按钮，点击才联网查询 FlightAware（不拖慢主查询）
- **缓存刷新按钮**：结果页右上角 🔄，绕过 30 分钟缓存强制刷新
- **容错输入**：注册号可以不写连字符，自动尝试多种标准写法（`B7973` ↔ `B-7973`、`GEUYR` ↔ `G-EUYR`）

## 支持的注册号格式

| 格式 | 示例 | 国家 |
|------|------|------|
| N + 数字 | `N784AN` | 美国 |
| B- + 数字 | `B-2001`、`B7973` | 中国 |
| JA + 数字 | `JA801A` | 日本 |
| G- + 字母 | `G-EUYR`、`GEUYR` | 英国 |
| D- + 字母 | `D-AIXM`、`DAIXM` | 德国 |
| HL + 数字 | `HL7598` | 韩国 |
| 9M- + 字母 | `9M-MAS`、`9MMAS` | 马来西亚 |
| VT- + 字母 | `VT-SUG`、`VTSUG` | 印度 |
| 其他 | A6-、EC-、F-、EI-、OO-、SP- 等 | 全球 |

## 快速开始

要求：Node.js ≥ 18（内置 `fetch` 与 ES 模块）。

```bash
cd aircraft-lookup
npm install
npm start
```

浏览器访问 **http://127.0.0.1:3000**。

Windows 用户也可双击 `start.bat`（自动将 Node 加入 PATH）。Git Bash 用户运行 `./start.sh`。

开发模式（文件变更自动重启）：

```bash
npm run dev
```

## 数据来源

> Flightradar24 与飞常准（VariFlight）接口需密钥 / 有 Cloudflare 反爬防护，无法匿名调用。本项目改用以下**公开可访问、无需密钥**的数据源：

| 数据源 | 用途 | 说明 |
|--------|------|------|
| [airport-data.com](https://airport-data.com) | 机型号、机龄、出厂号、发动机、所有者、ICAO24、执飞航线 | 全局飞机数据库，核心来源 |
| [planespotters.net](https://www.planespotters.net/photo/api) | 飞机照片 | 公共照片接口，需 Referer + 联系方式 UA |
| [OpenSky Network](https://opensky-network.org) | ADS-B 实时位置/状态 | 按 ICAO24 查询，中国境内覆盖较弱 |
| [FlightAware](https://flightaware.com) | 按需补全起降机场 | 需要登录，仅注册号指向的航班场景 |
| [OurAirports](https://ourairports.com) | 最近机场匹配 | 9057 个商业机场坐标，本地计算 |

服务端抓取外部数据时强制 IPv4、跟随重定向、自定义 UA，以规避解析超时与反爬。

## API

### `GET /api/query?reg=<注册号>[&refresh=1]`

查询飞机信息。`refresh=1` 绕过缓存强制刷新。

```bash
curl "https://searchplane.site/api/query?reg=N784AN"
```

返回 JSON：

```jsonc
{
  "success": true,
  "reg": "N784AN",
  "aircraft": {
    "registration": "N784AN",
    "manufacturer": "Boeing",
    "model": "777-223",
    "fullType": "Boeing 777-223",
    "year": 2000,
    "age": 26,
    "cn": "29588",
    "icao24": "aa9f6f",
    "owner": "UMB BANK NA TRUSTEE",
    "status": "Valid"
    // ...
  },
  "operator": { "airline": "American Airlines", "liveStatus": "ON GROUND" },
  "photo": { "url": "...", "thumb": "...", "count": 1 },
  "live": { "airborne": true, "callsign": "AAL109", "latitude": 42.37, "longitude": -71.01, "originCountry": "United States", "near": { "iata": "BOS", "distKm": 5 } },
  "currentRoute": { "callsign": "AAL109", "from": { "code": "LHR", "name": "London Heathrow Airport" }, "to": { "code": "BOS", "name": "..." } },
  "routes": [ /* 最近 15 条执飞记录 */ ],
  "sources": { "airport-data": "ok", "planespotters": "ok", "opensky": "ok" }
}
```

### `GET /api/route?callsign=<呼号>`

按呼号补全起降机场（用户点击"查起降机场"按钮时调用）。

### `GET /api/health`

健康检查，返回 `{ "ok": true, "time": "..." }`。

### `GET /api/img?url=<图片 URL>`

图片代理（规避第三方 CDN 防盗链与跨域），Cloudflare 上仅允许 planespotters 域名。

## 目录结构

```
aircraft-lookup/
├─ server.js            # Express：本地服务（静态 + API + 图片代理）
├─ src/
│  ├─ worker.js         # Cloudflare Worker 入口（/api/* 路由 + assets）
│  ├─ aggregate.js      # 编排各数据源、机龄计算、最近机场、缓存（30 分钟）
│  ├─ airportdata.js    # airport-data.com 页面解析（4 张表 + 连字符容错）
│  ├─ airports.js       # 最近机场匹配（Haversine 球面距离）
│  ├─ airports.data.js  # OurAirports 9057 个商业机场（导出自 airports.json）
│  ├─ planespotters.js  # planespotters 照片
│  ├─ opensky.js        # OpenSky ADS-B 实时状态
│  ├─ flightroute.js    # FlightAware 按呼号补全起降机场（限流 + 缓存）
│  ├─ fetch.js          # HTTP 客户端（Node https / Cloudflare fetch 双环境）
│  └─ register.js       # 注册号规范化与连字符变体
├─ public/
│  ├─ index.html        # 页面结构
│  ├─ style.css         # 深色 + 浅色双主题 CSS 变量体系
│  └─ app.js            # 前端逻辑（查询、渲染、主题定时切换、搜索历史、刷新）
├─ start.bat / start.sh # 一键启动
├─ wrangler.jsonc       # Cloudflare Worker 配置（main + assets）
├─ package.json
└─ README.md
```

## 云部署（Cloudflare Workers）

项目已适配 **Cloudflare Workers**（免费计划）：静态前端在 `public/`（assets），后端在 `src/worker.js`。

### 部署步骤
1. 代码推送到 GitHub（`cagfriend/aircraft-lookup`）
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Worker** → **Connect to Git** → 选仓库
3. 构建配置：Build command 留空，Deploy command `npx wrangler deploy`；`wrangler.jsonc` 已声明 `main` 与 `assets.directory: public`

### 绑定自定义域名
1. Cloudflare → 域名 `searchplane.site` → **Workers Routes** → Add route → `searchplane.site/*` → 选 `aircraft-lookup`
2. 完成后通过 **https://searchplane.site** 访问（国内直连，无需 VPN）

### 本地运行（不受影响）
```bash
npm start   # http://127.0.0.1:3000
```

## 局限与说明

- **数据可得性**：机型/机龄/注册信息依赖 airport-data.com 是否收录；未收录的注册号返回"未找到"。
- **复用注册号**：历史上被多个飞机使用过的注册号（如部分 B-XXX），airport-data 会展示多个历史记录；项目已按**标题中的构造号 (C/N)** 匹配当前那架，避免发动机/座位数等字段被旧飞机覆盖。
- **注册国兜底**：所有者地址缺失/解析失败时，按**注册号前缀**推断国家/地区（如 `B-`=中国、`N`=美国、`JA`=日本、`HL`=韩国、`9M`=马来西亚等）。
- **OpenSky 覆盖**：ADS-B 实时数据在中国境内覆盖较弱，此时用最近航班记录坐标 + 最近机场作为降级方案。
- **航线缺失**：部分航班起降机场在数据源未匹配，此时显示记录坐标及最近机场，或点"查起降机场"按钮联网补全。
- **照片可用性**：planespotters 图片 CDN 偶发不可达，前端自动降级到缩略图，均失败显示"照片加载失败"。
- **主题定时**：默认按北京时间 6-19 点浅色；页面需在对应时段打开才自动切换（刷新后生效），手动点击会覆盖。

仅用于学习演示。请遵守各数据源的使用条款。

## License

MIT
