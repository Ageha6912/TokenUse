<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="TokenUse —— 实时监测 ZCode / Codex CLI / OpenCode / Cursor 的 token 消耗与等效金额，数据全程留在本机">
</p>

<p align="center">
  <a href="https://github.com/Ageha6912/TokenUse/releases"><img src="https://img.shields.io/github/v/release/Ageha6912/TokenUse?style=flat-square" alt="最新版本"></a>
  <a href="https://github.com/Ageha6912/TokenUse/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Ageha6912/TokenUse?style=flat-square" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Windows-10%2B-b07f0a?style=flat-square" alt="Windows 10+">
</p>

<p align="center">
  <img src="./assets/readme/dashboard.png" width="100%" alt="TokenUse 仪表盘真实运行截图：今日 Tokens、今日/本月等效成本、实时活动曲线、每日趋势、模型占比、项目消耗与请求明细">
</p>

## 这是什么

TokenUse 是一台跑在你电脑上的 **token 电表**：只读读取 ZCode、Codex CLI、OpenCode 和 Cursor 的本地数据，每 3 秒增量拉取用量，按价格表折算成等效金额，在 **Web 仪表盘 / 悬浮图标 / 系统托盘** 三处常显。

当前支持的数据源：

- **ZCode**：本地 SQLite 中的模型用量
- **Codex CLI**：本地会话 JSONL 日志
- **OpenCode**：本地 SQLite 中已完成的 assistant 消息
- **Cursor**：本地 `state.vscdb` 中的 Composer/bubble 数据；可统计明确记录的输入、输出及部分仅有上下文用量的记录

数据全程留在本机，不经过任何第三方。金额是「等效成本」——按内置价格表折算，帮你心里有数，请按真实账单核价。

## 手机上实时查看

电脑跑着 TokenUse，手机连同一 Wi-Fi，扫码就能看同一份数据，刷新与 PC 同步：

1. PC 仪表盘 → 设置 → 「手机访问」→ 开启「局域网共享」
2. 手机相机扫二维码（地址已带访问令牌），或浏览器打开面板里的地址
3. iOS「添加到主屏幕」后即全屏独立窗口；令牌泄露时点「重置令牌」立即作废旧地址

安全默认：服务默认只监听本机回环；开启共享后才绑定局域网，且非本机请求必须携带令牌（静态页面除外，数据接口一律校验）。在外面（非同一 Wi-Fi）查看，可搭配 Tailscale 等组网工具访问同一地址，流量全程 WireGuard 加密。

## 工作原理

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="工作原理图：ZCode、Codex、OpenCode 与 Cursor 数据源只读接入 TokenUse 核心，经 WebSocket 推送给 Web 仪表盘、悬浮图标、系统托盘">
</p>

- **只读采集**：不写入、不加锁；SQLite 数据源会观察数据库及 WAL 变化，解析器失败会安全重试
- **增量轮询**：默认每 3 秒检查一次，只读取新增或发生变化的本地数据
- **统计口径统一**：总 tokens = 输入 + 输出 + 缓存读 + 缓存写；推理 tokens 已含在输出里，单独展示不重复计
- **金额可核价**：缓存读按折扣价，按 `provider_id` 区分「套餐内 / 按量」，`builtin:zai-start-plan` 默认套餐内；匹配不到价格的模型金额显示 `—`，tokens 照常统计
- **数据源是插件**：已支持 ZCode / Codex / OpenCode / Cursor；要支持更多工具，可在 `src/sources/` 新增解析器

## 数据来源与路径

以下是 Windows 默认路径。应用只读这些位置；如果对应工具尚未运行或文件不存在，该数据源会显示未就绪，不影响其他数据源使用。

| 数据源 | 默认读取位置 |
| --- | --- |
| ZCode | `%USERPROFILE%\.zcode\cli\db\db.sqlite`（同时观察 `db.sqlite-wal`） |
| Codex CLI | `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` |
| OpenCode | `%USERPROFILE%\.local\share\opencode\opencode.db`（也支持 `XDG_DATA_HOME`） |
| Cursor 全局数据 | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Cursor 工作区数据 | `%APPDATA%\Cursor\User\workspaceStorage\` 下的工作区数据库和 `workspace.json` |

Cursor 的数据结构和字段由 Cursor 本身维护，版本升级可能导致字段变化。TokenUse 会优先读取 bubble 中明确的输入/输出 token；若只有 Composer 的上下文 token，则按可读取的 `contextTokensUsed` 作为输入侧统计。此类记录不一定代表一次完整请求，也可能缺少模型、项目或时间信息，请将其视为本地数据的近似统计。

## Cursor 数据限制

- Cursor 的本地数据库不一定保留完整账单明细，TokenUse 只能统计当前本机数据库中实际可读取的字段
- 某些 Cursor 记录只有上下文 token，没有完整的输入/输出拆分，因此可能只显示输入 token，不能据此推断完整请求消耗
- Cursor 的工作区关联信息缺失时，项目会显示为 **`(未知项目)`**；这表示无法从本地数据可靠还原项目，不代表 token 没有统计
- Cursor 数据库格式可能随版本变化；读取失败时该数据源会暂时标记异常，并在后续轮询中重试

## 下载安装

从 [Releases](https://github.com/Ageha6912/TokenUse/releases) 下载：

| 文件 | 说明 |
| --- | --- |
| `TokenUse.Setup.*.exe` | 安装版，装完自动启动，含开始菜单快捷方式 |
| `TokenUse.*.exe` | 便携版，单文件直接运行 |

首次运行如遇 SmartScreen 提示，点「更多信息 → 仍要运行」。需要本机有对应工具并产生本地数据，仪表盘才会显示相应用量；只使用 Cursor 也可以单独查看 Cursor 数据。

## 本地开发与启动

要求：Windows 10+、Node.js（建议使用当前 LTS）。在项目目录执行：

```bash
npm install
npm start        # 构建后启动 Electron：仪表盘窗口 + 托盘 + 悬浮图标
```

`npm start` 会先执行构建，再启动 Electron。也可以分步执行：

```bash
npm run build
npm run app
```

只运行监测服务（不开 Electron 壳），用浏览器访问 <http://127.0.0.1:8510>：

```bash
npm run build
npm run server
```

跑全部测试（构建 + 类型检查 + 单元测试，基于 node:test，零额外依赖）：

```bash
npm test
```

## 配置文件（都在用户数据目录下，可直接编辑）

打包版和 Electron 开发启动时，默认使用 `%APPDATA%\TokenUse\`；独立 `npm run server` 也使用同一目录。开发早期项目内的 `data/` 会在首次启动时迁移到用户数据目录（若目标目录尚无配置）。

- `settings.json` — 轮询间隔（默认 3 秒）、美元汇率、各 provider 计费方式、悬浮图标开关/开机自启/局域网共享（`lanAccess.enabled` + `lanAccess.token`）
- `prices.json` — 价格覆盖表（每 1M token，CNY/USD），优先级最高
- `remote-prices.json` — 从 LiteLLM 价格库拉取的远程价（设置里点按钮更新）

<details>
<summary>目录结构</summary>

```
src/core/      类型、价格表、聚合器/存储
src/sources/   ZCode SQLite、Codex JSONL、OpenCode SQLite、Cursor state.vscdb 数据源插件
src/server/    HTTP + WebSocket 实时服务
electron/      托盘、悬浮图标、仪表盘窗口
web/           仪表盘前端（原生 TS + ECharts）
scripts/       esbuild 构建与图标生成
```

</details>

## 已知边界

- ZCode 的库是内部格式，若其升级改表结构，解析器会安全失败并在下轮重试；必要时删除用户数据目录中的配置后重启
- Cursor 的 token 记录、项目关联和模型字段取决于本地 `state.vscdb` 实际内容，可能出现未知项目、仅有上下文 token 或金额无法计价
- 请求明细最多缓存最近 2000 条（聚合数字不受影响，基于全量数据）
- 价格表未匹配的模型仍统计 tokens，但等效金额显示 `—`；等效金额不是实际账单
- 预算告警、历史导出、更多工具支持：二期候选

## License

[MIT](./LICENSE)