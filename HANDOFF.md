# Handoff (交接文档)

> 给下一个 AI 会话的简要脉络。不逐行复述代码，只讲架构、关键决策和当前状态，方便快速接手。

## 项目是什么

飞机注册号查询工具：输入注册号 → 展示机型、机龄、执飞航线、实时位置、照片、最近机场。

- **线上地址**：https://searchplane.site （Cloudflare Workers，免费，可国内直连）
- **GitHub**：cagfriend/aircraft-lookup

## 技术形态（重要）

- **本地/Express**：`server.js`，`npm start` → http://127.0.0.1:3000
- **云上/Cloudflare Worker**：`src/worker.js`（单入口，路由 /api/*），`public/` 作为静态 assets，`wrangler.jsonc` 配置 `main` 和 `assets.directory: public`
- 两者共用同一套 `src/` 核心逻辑，只是入口不同。
- 路由：`/api/health` `/api/query` `/api/route` `/api/img` `/api/fix`

## 数据源（都在 src/ 模块）

| 模块 | 数据源 | 用途 |
|------|--------|------|
| airportdata.js | airport-data.com | 机型/机龄/出厂号/发动机/所有者/ICAO24/执飞航线（核心） |
| planespotters.js | planespotters.net | 照片 |
| opensky.js | OpenSky Network | ADS-B **实时位置 + 真实飞行轨迹 + 历史航班**（详见下方 OpenSky 段） |
| flightroute.js | FlightAware | 按呼号**按需**补全起降机场 + filed route（航路点/高度/速度/燃油） |
| airports.js (+airports.data.js) | OurAirports | 9057 机场坐标 → 最近机场匹配 |
| fixlookup.js | OpenNav（可选，需 OPENNAV_TOKEN） | 在线补充 **非美国航路点**（南美/欧洲等）坐标 |

- **航路点数据库**：`public/data/fixes.data.js`（约 3.3MB，client 端懒加载）。由 FAA fixes(67610) + OurAirports navaids(11008) + OpenNav 抓取(51043) 合并去重生成，约 11.5 万个 ident / 12.4 万坐标，同名多点保存多个坐标。前端 route-map.js 用它把 filed route 里的名称航路点转成真实位置；未收录点再走 /api/fix（OpenNav）在线查，仍无则大圆示意兜底。
  - ⚠️ **同名航路点必须按航线顺序解析**：早期"按航线中点就近选择"会把 SYR/KOSHI/BULAN 等选到地球另一端。现用 `resolveSequential()`（沿航线顺序 + 前后点参考 + 偏离过滤），并支持 `+GAYEL` 这类 `+` 前缀航路点。

### OpenSky（OAuth2，可选但推荐）

- **认证**：OAuth2 client credentials。OAuth 现在**只支持这种**（用户名密码 Basic 已废弃）。
  - 配置：OpenSky 账号 → Account 页 → 创建 API client → 得到 `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`
  - token 走 `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`，**30 分钟过期**；`opensky.js` 内做了内存缓存 + 提前 2 分钟刷新
  - **本地**：环境变量；**Cloudflare Worker**：设同名环境变量/Secret（`opensky.js` 的 `env()` 兼容 process.env 与 globalThis.env）
- **三个接口**（`opensky.js` 导出）：
  - `queryOpenSky(icao24)` — 实时状态（匿名可用，配额 400/天；配置后 4000/天）
  - `queryOpenSkyTrack(icao24)` — **真实飞行轨迹**（**匿名即可用**！返回抽稀后的点，默认≤240 点）
  - `queryOpenSkyFlights(icao24, {hours})` — **历史航班**（**需凭据**，默认 24h 窗口 = 4 credits）
- **配额**：匿名 400/天；注册 4000/天；**states/tracks/flights 三者配额独立**。`/states` 按包围框 1–4 credits；`/tracks`、`/flights` 按跨越日分区 4–30+ credits
- ⚠️ **重要实测结论（2026-09）**：**OpenSky 从 Cloudflare Worker 访问不通** —— `opensky-network.org` 的 states/tracks/auth 全部超时，25s 时返回 **HTTP 522**（Cloudflare 边缘连不上 OpenSky 源站；OpenSky 自己就在 Cloudflare 后面）。因此线上"实时位置""真实轨迹""历史航班"都拿不到数据，只能降级。**本地 Node 直连正常**（轨迹实测 100+ 点）。已做的缓解：超时 15s→6s（`OPENSKY_TIMEOUT_MS` 可调）+ 失败熔断负缓存 5 分钟。
  - 若将来要让线上也能用轨迹，需要换一个**对 Cloudflare 出口可达**的 ADS-B 源。实测：`api.adsb.lol` 可达但返回 429（限流）；`opendata.adsb.fi` 403（屏蔽数据中心 IP）；`api.adsbdb.com` 200 可用（但只有机型信息，无轨迹）。
  - 注意：沙箱内 **OpenSky 直连可用，走 clash 代理反而不可用**。
- **前端**：`/api/route?callsign=X&icao24=Y` 并行取 FlightAware + OpenSky。地图上**绿线 = OpenSky 真实轨迹**，蓝线 = filed route 航路点连线，灰虚线 = 大圆兜底。`app.js` 在 render 时把当前机 ICAO24 放到 `window.__aircraftIcao24`
- **地图实现**：Leaflet **本地托管**（`public/vendor/leaflet`）；瓦片源三级自动降级：高德 → OSM → CARTO（手机端曾因高德不可达导致底图空白）。
- **跨日界线**：`unwrapLng()` 展开经度，`chainFrame`/`alignToFrame()` 让机场+航路点+折线统一经度框架。**否则跨太平洋会画成横穿地图的直线，或丢掉终点。**

- `aggregate.js`：编排+机龄计算+缓存(30min)+最近机场+国家。
- `fetch.js`：HTTP 客户端，**双环境**（Node 用 https+IPv4；Cloudflare 用全局 fetch）。
- `register.js`：注册号规范化 + 连字符变体（B7973↔B-7973 等）。

## 关键决策 & 已踩的坑

1. **不用 Flightradar24/飞常准**：都需密钥/Cloudflare 反爬。改用 airport-data + planespotters + OpenSky + FlightAware（按需）。
2. **cloudflare 创建向导实际是 Worker，不是 Pages**：曾误用 `functions/`（Pages Functions），部署老是 Missing entry-point。**最终改为 Worker 单入口 + assets**（`src/worker.js` + `wrangler.jsonc`）。
3. **图片代理 `/api/img` 只允许 planespotters 域名**（worker.js 白名单），防盗链+防开放代理。
4. **注册号复用**（如 N29978 曾被 Bell 直升机用过）导致字段串了（发动机显示涡轴）。已修复：airportdata.js 把每个构造表独立收集，**按标题 C/N 匹配当前那架**。
5. **注册国空白**（如 B18001）：已加 `countryFromRegistration()` 按注册号前缀推断（B=中国、N=美国、JA=日本…），地址缺失时兜底。
6. **主题定时**：严格按北京时间(GMT+8) 6:00-19:00 浅色、其余深色；`scheduledTheme()` 在每次加载时算。**不读、也不写 localStorage**（历史偏好一律不生效，刷新即按当前时间）。点击按钮只临时覆盖当前页面，重载后恢复时间规则。（localStorage 仅用于搜索历史 `aircraft-lookup-history`。）
7. **airport-data.com 会限流**：本地 IP 高频抓取后曾 403，过段时间自动恢复；**Cloudflare 云端出口不受影响**。调试/测试注意别刷爆。
8. **顶层 `process.env` 在 CF Worker 会炸**（无该对象）→ 部署失败、**线上悄悄停留在旧版本**。必须用 `env()` 这类双环境安全封装。
9. **CF Worker 的 GET 请求不能带 `body` 字段** → 否则 fetch 抛错，**所有对外抓取失败、接口全 404**。`fetch.js` 已修。
10. **变量遮蔽参数的 TDZ 坑**：内层 `const body` 遮蔽了函数参数 `body` → `ReferenceError`；本地 Node 走另一分支测不出来。
    - 教训：**改 `fetch.js` 后必须验证线上 `/api/query`**；必要时加临时诊断端点看真实错误。

## 部署注意

- 推送到 GitHub main → Cloudflare **自动部署**（autoDeploy 已开），约 **45-90 秒**生效；前端资产需 **Ctrl+F5** 强刷。
- 本地推 GitHub 需要 VPN(clash 代理 127.0.0.1:7897)，git 已配 proxy；**代理时断时续，push 需重试循环**。
- 若域名/DNS 有问题，域名在腾讯云买，NS 指向 Cloudflare（michelle/kenneth.ns.cloudflare.com）。
- 3.3MB 的 `fixes.data.js` 部署没问题（上限 25MiB）；历史上部署失败的真凶是上面第 8 条。

## 待办 / 开放问题

- ⚠️ **P1 线上 OpenSky 不可达（未解决）**：CF Worker 访问 OpenSky 全 522 → 线上"实时位置/真实轨迹/历史航班"均降级。本地 Node 正常。解决方向：① 自建中转（本地/VPS 代理）② 换对 CF 出口可达的 ADS-B 源 ③ 接受现状。
- **待配置**：`OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`（不配也能跑：实时+轨迹匿名可用，仅"历史航班"不可用；云端本就不可达）。`OPENNAV_TOKEN` 未配置 → 非美国航路点（南美等）仍走大圆示意。
- **P0 待用户确认**：手机端曾报"未查到该航班信息"，判断为故障窗口 + 浏览器 30min 缓存所致（桌面读缓存、手机打源站）。已加 **CF 机房标识(colo)** 便于复查，等手机复测；若复测仍失败，看错误提示里的**机房号**。
- **可选**：前端展示 `historicalFlights`（`/api/route` 已返回，实测 23 条，目前无 UI 消费）；主题"到点自动切换（无需刷新）"（当前刷新才生效）。
- **已知缺失航路点**：OXASA / ENVOP / LALID / ELNIS / IBENO 等不在本地库中。
- **注意 FlightAware 依赖**：页面约 500KB、单次 7-26s，有反爬风险；已做节流（1.2s）+ 缓存 6h。
- README 已含功能、API、目录、部署、局限说明。

## 常用命令

```bash
npm start              # 本地 http://127.0.0.1:3000
git push origin main   # 需 VPN + 已配 proxy
# 线上验证：https://searchplane.site/api/query?reg=B18001  /api/health
```
