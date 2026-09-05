# ✈ 航空器详情查询 (Aircraft Lookup)

输入飞机注册号，即刻查询该机的**机型、机龄、执飞航线**等关键信息。

前端界面 + Node.js 后端，数据来自公开可访问的航空数据平台。

## 功能

- **机型号**：制造商、机型号、类别、座位数、发动机数、发动机型号
- **机龄**：由出厂年份 / 适航测试日期自动计算
- **执飞航线**：当前（最近）航班及最近执飞记录（起降机场、航班号、呼号、速度、航向）
- **最近机场匹配**：当数据源未给出起降机场时，用记录的经纬度反查**离它最近的机场**（基于 OurAirports 全球机场数据库，本地球面距离计算，无需密钥/联网）
- **注册信息**：机身序号 (C/N)、注册国、ICAO24（Mode-S）、所有者、注册状态、适航日期
- **实时状态**：ADS-B 空位数据（经纬度、高度、地速、航向、应答机）—— 飞机在空中时显示
- **飞机照片**：planespotters.net 提供

支持 N 号（美国）、B-（中国）、JA-（日本）、G-（英国）、D-（德国）等常见注册号。

> **容错输入**：注册号可以不写连字符，系统会自动尝试多种标准写法。例如输入 `B7973` 与 `B-7973` 等价、`GEUYR` 与 `G-EUYR` 等价。

## 快速开始

要求：Node.js ≥ 18（内置 `fetch` 与 ES 模块）。

```bash
cd aircraft-lookup
npm install
npm start
```

打开浏览器访问 **http://127.0.0.1:3000**，在输入框输入注册号，例如：

- `N784AN`（美国航空 B777-223）
- `B-2001`（中国 B777-39P/ER）
- `JA801A`（全日空 B787-8）
- `G-EUYR`（英国航空 A320-232）

开发模式（文件变更自动重启）：

```bash
npm run dev
```

## 数据来源

> 说明：用户提到的 Flightradar24 与飞常准（VariFlight）接口均需密钥 / 有 Cloudflare 反爬防护，无法匿名调用。本项目改用以下**公开可访问、无需密钥**的数据源组合，覆盖面与信息量相当：

| 数据源 | 用途 | 说明 |
|--------|------|------|
| [airport-data.com](https://airport-data.com) | 机型号、机龄、出厂号、发动机、所有者、ICAO24、执飞航线 | 全局飞机数据库，按注册号返回页面，核心来源 |
| [planespotters.net](https://www.planespotters.net/photo/api) | 飞机照片 | 公共照片接口 |
| [OpenSky Network](https://opensky-network.org) | ADS-B 实时位置/状态 | 按 ICAO24 查询 |

服务端在抓取校外数据源时强制使用 IPv4 并跟随重定向，以规避 IPv6 解析超时与 Cloudflare 跳转。

## API

### `GET /api/query?reg=<注册号>`

返回统一 JSON。请求成功后 `success: true`，`aircraft`、`operator`、`photo`、`live`、`currentRoute`、`routes`、`sources` 字段。

```bash
curl "http://127.0.0.1:3000/api/query?reg=N784AN"
```

### `GET /api/health`

健康检查，返回 `{ "ok": true, "time": ... }`。

### `GET /api/img?url=<图片路径>`

图片代理（规避第三方 CDN 的防盗链与跨域限制）。

## 目录结构

```
aircraft-lookup/
├─ server.js          # Express 服务：静态资源 + API + 图片代理
├─ src/
│  ├─ aggregate.js    # 编排各数据源、计算摘要、结果缓存
│  ├─ airportdata.js  # airport-data.com 解析（机型/机龄/航线/ICAO24）
│  ├─ planespotters.js# planespotters 照片
│  ├─ opensky.js      # OpenSky ADS-B 实时状态
│  ├─ fetch.js        # HTTP 客户端（IPv4 + 重定向 + 超时）
│  └─ register.js     # 注册号规范化
└─ public/
   ├─ index.html
   ├─ style.css
   └─ app.js
```

## 局限与说明

- **数据可得性**：机型/机龄/注册信息依赖机场数据源是否收录；未收录的注册号会返回“未找到”。
- **复用注册号**：历史上曾被多个飞机使用过的注册号（如部分 B-XXX），airport-data 会以标题中的当前记录为主，部分补充字段可能来自历史记录。
- **实时状态**：ADS-B 仅在飞机正在广播时返回位置信息；在地面关机（未广播）时显示“未在空中”。
- **访问频率**：为减轻外部数据源压力，后端对同一注册号做了 30 分钟结果缓存（`?refresh=1` 可强制刷新）。

请遵守各数据源的使用条款。

## 云部署（Cloudflare Pages）

项目已适配 **Cloudflare Pages**（免费计划），静态前端在 `public/`，后端 API 在 `functions/`（Pages Functions）。

### 部署步骤
1. 代码推送到 GitHub（`cagfriend/aircraft-lookup`）
2. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 授权并选择 `aircraft-lookup` 仓库 → **Begin setup**
4. 构建设置：
   - **Production branch**: `main`
   - **Build command**: 留空
   - **Build output directory**: `public`
   - Framework preset 选 **None**
5. **Save and Deploy**，等待约 1-2 分钟

部署完成后访问 `https://<project>.pages.dev`。

### 本地运行（不受影响）
```bash
npm start   # http://127.0.0.1:3000
```
`functions/` 仅 Cloudflare 使用；本地仍走 Express（`server.js`）。

### 说明
- `/api/img` 图片代理在 Cloudflare 上**只允许代理 planespotters 域名**（`functions/api/img.js` 白名单）。
- airport-data.com 等源有反爬，若高频请求被临时 403，等一段时间即可恢复。
