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
  - **完整可达性实测矩阵（2026-09，CF 边缘 colo=SEA/LHR 双机房一致）**：

    | 目标 | CF 边缘 | 本机 |
    |---|---|---|
    | `api.adsbdb.com`（对照） | **200 / 124ms** | 200 |
    | `example.com`（对照） | **200 / 8ms** | 200 |
    | `opensky-network.org`（root 与 states） | **522（约 19.6s）** | 200 |
    | `api.adsb.lol/v2/hex/…` | **429**（nginx；换浏览器 UA/Referer 仍 429，143ms 快速拒绝） | 200 |
    | `api.adsb.lol/…/trace/` | **503**（其 trace 端点本机也 503，本身不稳） | 503 |
    | `opendata.adsb.fi` | **403**（Cloudflare 拦截页） | 200 |
    | `api.airplanes.live` | **403**（对方要求邮件申请） | 403 |
    | `r.jina.ai` 中转 | 429（按 IP 限流） | — |
    | `api.allorigins.win` 中转 | 500（约 19s） | — |
    | `api.codetabs.com` 中转 | **522** | — |
    | `corsproxy.io` 中转 | 403（需 API key） | — |

  - **结论**：CF 边缘自身出网完全正常（对照 200），但**“Cloudflare 网络 → OpenSky”这一跳整体不通**。关键证据：连第三方中转 `codetabs`（同样架在 Cloudflare 上）代取 OpenSky 时也返回 **522** —— 说明断点在 CF→OpenSky，不是我们的 Worker 代码或出口 IP 策略。因此“换成另一个免费 ADS-B 源”这条路基本被堵死（可用的都被 CF 拦截或按 IP 限流）。
  - ✅ **已采用的解法：改用 FlightAware 作为轨迹来源**（详见下方“实时轨迹兜底”），因为 FlightAware 从 CF 是通的（`/api/route` 一直在用它取航路）。**零新增基建、零额外请求**——轨迹就在我们已经抓取的那个页面的内嵌 JSON 里。
  - 注意：沙箱内 **OpenSky 直连可用，走 clash 代理反而不可用**。
- **前端**：`/api/route?callsign=X&icao24=Y` 并行取 FlightAware + OpenSky。地图上**绿线 = 真实轨迹**（来源见 `track.source`），蓝线 = filed route 航路点连线，灰虚线 = 大圆兜底。`app.js` 在 render 时把当前机 ICAO24 放到 `window.__aircraftIcao24`

### 实时轨迹兜底（FlightAware）—— 2026-09 新增

- **来源**：`flightroute.js` 的 `extractLiveTrack(bootstrap)`，从**同一个** `trackpollBootstrap` 里取 `flights[*].track`（该组对象还带 `heading`/`altitude`/`groundspeed`/`flightStatus`/`altitudeChange`/`timestamp`）。不新增任何网络请求。
- **单位换算（易错）**：`coord` 是 `[lon, lat]`（与 OpenSky 相反，已转成 `[lat, lon]`）；`alt` 单位是 **100 英尺**（×100 得 ft）；`gs` 单位是节。逐点无航向，故每点 heading 置 `null`。
- **输出结构**与 OpenSky track **完全对齐** `points: [lat, lon, altFt, heading, onGround, time][]`，因此前端绘制逻辑无需改动；另加 `live`（末点即当前位置 + 速度/航向/状态）。
- **降级链（`worker.js` 与 `server.js` 双入口必须一致）**：OpenSky 可用 → 用 OpenSky；否则用 FlightAware。响应加 `trackSource` 标明来源；`trackError` 仍保留 OpenSky 的失败原因，不掩盖问题。
- **缓存**：含实时轨迹时 `flightroute.js` 的 TTL 从 6h 缩短到 **5 分钟**（`LIVE_TTL`）；本地 `server.js` 的 `Cache-Control` 在有实时数据时从 1800s 降到 **60s**（浏览器缓存旧位置曾是“手机端未查到航班”的诱因）。
- **线上实测（colo=SEA）**：
  - DLH521（MEX→MUC）**915 点**：墨西哥城起飞 → 北海上方 FL410/572kt/航向 118，`trackSource=FlightAware`
  - UAL286（ICN→EWR）**499 点**：经度 -179.92~179.63，**跨日界线 1 次**（前端 `unwrapLng` 展开后最大相邻跳变 1.45°，绘制正确）
  - KAL259（ANC→ORD）**10 点**（刚起飞 3400ft）：短轨迹同样可用
  - 响应体积约 47KB（915 点），可接受；OpenSky 熔断生效时 `trackError` 显示“OpenSky 暂时不可达（熔断中）”
  - **覆盖面抽样（8 个不同呼号：UAL2814 / AAL1229 / AAL2459 / UAL2225 / FFT3108 / AAY2056 / ASA468 / 公务机 VJA537）**：全部返回 `trackSource=FlightAware` + `live`，点数 66～304。**结论：不挑航司/机型，公务机也能拿到。**
### FlightAware 轻量轮询端点 `/ajax/trackpoll.rvt`（2026-09 发现，**尚未采用**）

整页 554KB / ~9s 是当前唯一的抓取方式，但对“后台预热实时位置”来说太重。深挖其前端脚本后发现官方自己的轮询端点：

- **端点来源**：页面加载 `/include/<hash>-maps/TrackPollClient.js`，其中
  `this.endpoint = '/ajax/trackpoll.rvt' + window.location.search;`
  `this.poll = function(){ $.get(this.endpoint, { token: this.token, locale, summary }) ... }`
- **token 来源**：页面内嵌 `trackpollGlobals = { "TOKEN": "…", "INTERVAL": 60, "SINGLE_FLIGHT": true, "USERTOKEN": "…" }`
- **实测调用**：`GET https://www.flightaware.com/ajax/trackpoll.rvt?token=<TOKEN>&locale=en_US&summary=0`（带 `Referer` 指向该航班页）
  - 返回 **200 / 95KB / 1.9–2.7s**（对比整页 **554KB / ~9s**：**小 5.8 倍、快 4.7 倍**，`Content-Type: application/json`）
  - 结构：`{ version, summary, flights: { "UAL286-1789034977-fa-1255p:0": { track: [{timestamp, coord:[lon,lat], alt(×100ft), gs}], flightStatus, heading, altitude, groundspeed, flightPlan, activityLog, … } } }`
  - **轨迹顺序为“起飞 → 当前”**（与 bootstrap 一致）。注意 `TrackPollClient` 里那段 `track.reverse()` 只作用于它自己的 replay 数据，**不适用于本端点**，别被误导
- ✅ **token 可复用**：同一 token 在 **130 秒后仍有效**，且返回了更新的轨迹（533 → 538 点、末点时间前移）。官方前端每 65s 轮询一次（`INTERVAL:60`）
- **价值**：一次整页抓取拿到 token 后，**后续刷新位置只需 95KB/2s** —— 可把 `/api/live` 的预热/刷新代价降低约 5.8 倍，或让前端以 ~60s 间隔真正“实时”刷新位置
- ⚠️ **风险与实现要点（尚未实现，等决策）**：
  - 这是**未公开文档**的端点，可能随时变更；失效时必须能回退到整页抓取
  - 首次仍需要整页（token 只存在于页面里）；`Referer` 可能必需
  - 实现思路：`flightroute.js` 在整页抓取时顺带缓存 token → 新增 `refreshLiveTrack()` 走 trackpoll 更新缓存的 `liveTrack` → `/api/query` 预热时若有 token 用 refresh，否则整页

  - ⚠️ **已知瞬时失败率 ≈ 1/8**：AAL2459 首次请求返回 `{success:false, error:'未查到该航班信息'}`，**同一呼号重查即成功**（FlightAware 抖动；失败结果不写入缓存）。前端目前会显示“未查到该航班信息”形成死路，**建议后续在卡片里加一个“重试”按钮**（尚未实现）。
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
- ⚠️ **推送不再需要 VPN（2026-09 实测变更）**：GitHub 现已可**直连**（`curl https://github.com` 1.2s 返回 200），而 clash 代理 `127.0.0.1:7897` 当时是**死的**（`curl -x` 连接失败）。git 里仍配着 `http.proxy=http://127.0.0.1:7897`，所以默认 `git push` 会因代理不通而失败 —— **用 `git -c http.proxy= -c https.proxy= push origin main` 绕过代理即可成功**。若哪天直连又不通，再回头试代理。
- 小坑：`git push ... | tail -3` 的退出码是 `tail` 的，**永远为 0**，会把失败当成功（曾据此误判推送成功）。要判断结果得用 `PIPESTATUS` 或直接看输出。
- 若域名/DNS 有问题，域名在腾讯云买，NS 指向 Cloudflare（michelle/kenneth.ns.cloudflare.com）。
- 3.3MB 的 `fixes.data.js` 部署没问题（上限 25MiB）；历史上部署失败的真凶是上面第 8 条。

## 待办 / 开放问题

- 🔧 **延迟修正（2026-09 实测）**：线上 `/api/route` 曾实测 **8-9s**，其中 **6-7s 纯粹在等必然失败的 OpenSky 超时**（对照：不带 `icao24` 时只要 1.1-2.1s）。已按环境区分超时：**Node 6s / Cloudflare 1.5s**（`opensky.js`，可用 `OPENSKY_TIMEOUT_MS` 覆盖）。同时实测 **FlightAware 从 CF 边缘只需 1-2s** —— 此前本文档里"7-26s"是本地直连的旧数据，偏悲观，已修正。
  - 副作用：若 OpenSky 将来从 CF 恢复但响应慢于 1.5s，会退化为使用 FlightAware（轨迹仍正常）。
  - 验证方式：用 loader 把 `fetch.js` 的 `IS_NODE` 置为 `false`，即可在本地跑**真实的 Cloudflare 分支**（`envFetch` + 短超时）。实测总耗时 ≈ FlightAware 抓取时间，`trackSource=FlightAware`、377 点、`live` 正常；同进程第二次调用 **1ms**（缓存命中）。**该实验顺带验证了 `fetch.js` 的 Cloudflare 分支可用** —— 这条路径历史上炸过两次

- ✅ **P1 线上轨迹已解决（2026-09）**：OpenSky 从 CF 边缘**永久不可达**（522，且第三方 CF 中转同样 522，属链路问题），已改用 **FlightAware 内嵌 track 兜底**，线上绿线真实轨迹恢复（实测 915 点 + 当前位置），零新增基建。详见上方“实时轨迹兜底”。
- 🟡 **主查询页“实时位置”面板：已实现，待部署验证**（代码已在本地提交，未推送）。`/api/query` 的 `live` 线上仍是 `{airborne:false, note:'The operation was aborted'}`，只回退展示 airport-data 的 `lastSeen`（最近航班记录坐标，非实时）。
  - **为什么不做“点击按钮懒加载”**：实测 FlightAware **没有**轻量 JSON 端点 —— 页面里唯一的数据型 AJAX 是 `ajax/flight/map/...`，它返回的是 **PNG 图片**（101KB / 10.7s），比整页还慢。所以“省一次点击”只能靠后台任务。
  - **采用的方案：后台预热 + 前端轮询**（Cloudflare 原生能力，零点击、不拖慢主查询）
    1. `/api/query` 返回后，若 OpenSky 未拿到位置且有呼号，用 `ctx.waitUntil(queryFlightRoute(cs))` **后台预热**（本地 Express 用 fire-and-forget 等价实现）；**不阻塞响应**。
    2. 新端点 `/api/live?callsign=X`：**只读内存缓存**（`peekLiveTrack()`，绝不发起网络请求），因此恒定快返回；未预热好则返回 `{pending:true}`。
    3. 前端 `app.js` 的 `maybePollLive()`：面板为“未在空中”且有呼号时，每 5s 轮询一次、最多 8 次（≈40s，覆盖 FA 的 7-26s 抓取），拿到后直接复用 `renderLive()` 渲染；新查询会令旧轮询失效，避免迟到响应覆盖结果。
  - **防滥用守卫**：只有当 airport-data 的最近航班记录在 **2 小时内**（`currentRoute.time` 解析后比较）才预热，避免为早已落地的航班白抓 FlightAware（其页面 500KB 且反爬）。
  - **本地已验证**（含 `ctx.waitUntil` 语义与前端渲染契约）：冷缓存 → `pending:true`；预热后 → `pending:false` + 位置/高度/速度/航向/最近机场。

    #### 本地验证 Worker 入口的方法（值得复用）

    本项目历史上两次线上事故都是“本地 Node 走了另一条分支，测不出来”。以下手法可以在**不部署**的前提下执行真实 Worker 代码：

    1. **假 ctx 直接驱动入口**：`import worker from '.../src/worker.js'`，然后 `worker.fetch(new Request('https://x/api/...'), {}, ctx)`。Node 18+ 自带 `Request`/`Response`。用一个 `ctx = { waitUntil(p){...} }` 收集后台任务，就能验证：① 响应是否被后台任务阻塞 ② 任务何时完成。
       - 实测结果：`/api/query` **3ms 返回**，`waitUntil` 已登记但未完成 → 立即查 `/api/live` 仍是 `pending:true`（证明真在后台跑）→ 3.8s 后返回完整位置。
    2. **ESM loader 桩**：`aggregate.js` 依赖外网（airport-data 会限流），本地拿不到呼号就没法触发预热分支。用 `module.register()` + `resolve/load` 钩子把 `aggregate.js` 换成合成数据，**worker.js 的真实预热代码照常执行**。
    3. **假 DOM 驱动前端**：给 `public/app.js` 在 `load` 钩子里追加 `export { renderLive, maybePollLive }`，再提供最小的 `document`/`window`/`localStorage`/`setInterval` 桩，即可在 Node 里跑真实渲染与轮询逻辑。
       - ⚠️ 坑：`esc()` 是 `div.textContent = s; return div.innerHTML` 的 DOM 惯用法。假元素若不让 `textContent` 影响 `innerHTML`，`esc()` 会恒返回空串 —— 表现为“渲染结构对、内容全空”，**这是桩的问题，不是代码 bug**（我第一次就被误导了）。
       - 实测结果：渲染契约 8 项全 PASS（chip 数 9、无 undefined/NaN）；轮询 pending→到位后自动切换并停止；新查询会停掉旧轮询。
- ⚠️ **OpenSky 的“历史航班”`/api/route` → `openskyFlights` 线上同样不可用**（需凭据 + 且链路不通）。但 FlightAware 的 `historicalFlights`（约 23 条）是通的、且已返回，只是前端还没做 UI。
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
