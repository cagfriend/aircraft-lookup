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

## 数据源（都在 src/ 模块）

| 模块 | 数据源 | 用途 |
|------|--------|------|
| airportdata.js | airport-data.com | 机型/机龄/出厂号/发动机/所有者/ICAO24/执飞航线（核心） |
| planespotters.js | planespotters.net | 照片 |
| opensky.js | OpenSky Network | ADS-B 实时位置（按 ICAO24） |
| flightroute.js | FlightAware | 按呼号**按需**补全起降机场 |
| airports.js (+airports.data.js) | OurAirports | 9057 机场坐标 → 最近机场匹配 |

- `aggregate.js`：编排+机龄计算+缓存(30min)+最近机场+国家。
- `fetch.js`：HTTP 客户端，**双环境**（Node 用 https+IPv4；Cloudflare 用全局 fetch）。
- `register.js`：注册号规范化 + 连字符变体（B7973↔B-7973 等）。

## 关键决策 & 已踩的坑

1. **不用 Flightradar24/飞常准**：都需密钥/Cloudflare 反爬。改用 airport-data + planespotters + OpenSky + FlightAware（按需）。
2. **cloudflare 创建向导实际是 Worker，不是 Pages**：曾误用 `functions/`（Pages Functions），部署老是 Missing entry-point。**最终改为 Worker 单入口 + assets**（`src/worker.js` + `wrangler.jsonc`）。
3. **图片代理 `/api/img` 只允许 planespotters 域名**（worker.js 白名单），防盗链+防开放代理。
4. **注册号复用**（如 N29978 曾被 Bell 直升机用过）导致字段串了（发动机显示涡轴）。已修复：airportdata.js 把每个构造表独立收集，**按标题 C/N 匹配当前那架**。
5. **注册国空白**（如 B18001）：已加 `countryFromRegistration()` 按注册号前缀推断（B=中国、N=美国、JA=日本…），地址缺失时兜底。
6. **主题定时**：默认按北京时间(GMT+8) 6-19 点浅色，其余深色；`scheduledTheme()` 在请求时算；手动点击仍可覆盖（localStorage）。
7. **airport-data.com 会限流**：本地 IP 高频抓取后曾 403，过段时间自动恢复；**Cloudflare 云端出口不受影响**。调试/测试注意别刷爆。

## 部署注意

- 推送到 GitHub main → Cloudflare **自动部署**（autoDeploy 已开）。
- 本地推 GitHub 需要 VPN(clash 代理 127.0.0.1:7897)，git 已配 proxy；VPN 断了会失败。
- 若域名/DNS 有问题，域名在腾讯云买，NS 指向 Cloudflare（michelle/kenneth.ns.cloudflare.com）。

## 待办 / 开放问题

- 无重大未完成项。可考虑：主题"到点自动切换（无需刷新）"功能（当前刷新才生效）。
- README 已含功能、API、目录、部署、局限说明。

## 常用命令

```bash
npm start              # 本地 http://127.0.0.1:3000
git push origin main   # 需 VPN + 已配 proxy
# 线上验证：https://searchplane.site/api/query?reg=B18001  /api/health
```
