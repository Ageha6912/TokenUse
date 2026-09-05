# TokenUse 交接文档

> 写给零上下文的新会话。读完这一份就能接手，不需要翻历史对话。
> 写于 2026-09-02，v0.2.0 发布完成之后。

## 一、这个项目是什么

**TokenUse**（`E:\TokenUse`，git 仓库，remote = `github.com/Ageha6912/TokenUse`，分支 `main`）是一台跑在 Windows 上的 **token 电表**：

- 只读采集 ZCode 的本地 SQLite（`~/.zcode/cli/db/db.sqlite`）和 Codex 的会话 JSONL（`~/.codex/sessions/`），每 3 秒增量拉取
- 聚合 + 按价格表折算等效金额，通过 HTTP + WebSocket 服务对外提供（默认 `127.0.0.1:8510`）
- 展示端：Web 仪表盘（`web/`，原生 TS + ECharts）、Electron 悬浮图标 + 系统托盘（`electron/`）。悬浮图标 = 桌面右上角 44×44 小图标（应用 logo），点击向下展开 252×232 用量面板（今日 tokens/花费/请求数 + 本月 tokens/花费 + 仪表盘/隐藏按钮），再点收起或点击别处（窗口失焦）自动收起；收起态可按住拖动，已无缩放功能。尺寸与钳制几何全部在 `electron/floating-geometry.ts`（纯模块，有单测）
- 用户日常以**开发模式**运行：`E:\TokenUse\node_modules\electron\dist\electron.exe .`（不是安装版）
- 用户数据目录：`%APPDATA%\TokenUse`（settings.json / prices.json）；项目内 `data/` 是开发期遗留

## 二、这轮会话做了什么任务

用户问「能不能做成手机端，实时监测 token 消耗」。结论与方案（已定案，不要再重新讨论）：

**手机不采集数据，只做查看端**。数据源在 PC 本地文件里，手机读不到；正确形态是 PC 采集计价、手机通过局域网访问同一个 Web 仪表盘。具体实现：

| 模块 | 内容 |
| --- | --- |
| 服务端 `src/server/index.ts` | `settings.lanAccess { enabled, token }`；开启时绑定 `0.0.0.0`，关闭回 `127.0.0.1`，热切换；数据接口 + WebSocket 校验令牌（回环豁免、sha256 后 timingSafeEqual 防侧信道）；静态壳（HTML/JS/CSS/图标/manifest/sw）公开；`/api/lan-info` 仅限本机（返回带令牌的网卡地址列表） |
| 前端 `web/` | URL 里的 `?token=` 自动摘除转存内存，后续 fetch/WS 透明携带；设置抽屉新增「手机访问」面板（开关 / 二维码 / 复制 / 重置令牌，**手机端自动隐藏**）；≤640px 响应式布局；PWA（manifest + sw.js，SW 仅安全上下文注册） |
| 网卡排序 | `lanRank()`：私网非 `.1`（真实 Wi-Fi/以太网）> 私网 `.1`（VMware host-only 网关）> 其余（VPN/TUN）。二维码指向排序第一的地址 |

二维码生成用 `qrcode-generator`（npm 包，`qrcode(0,'M')` + `createSvgTag`），已加入 dependencies。

## 三、已完成（全部验证过）

1. **功能实现**：上述全部模块，`npm run build`（esbuild + tsc typecheck）通过
2. **鉴权实测**：回环 200；局域网无/错令牌 401；正确令牌 200；WS 同样校验；开关热切换即时生效；`/api/lan-info` 从局域网访问 404
3. **手机视口实测**：390×844 视口截图 + 视觉模型检查通过（卡片 2 列、真实数据、无溢出）；带令牌从局域网 IP 访问，数据正常加载（今日 1320 万 tokens）
4. **v0.2.0 已发布**：提交 `07b3ab4`（功能）+ `bf8c9d3`（版本号）；tag `v0.2.0` 推送触发 CI（`.github/workflows/release.yml`，push `v*` 即构建发版），2 分 12 秒构建成功，5 个产物齐全；中文发布说明已补写（含使用方法/安全设计/已知边界）
5. 用户本机应用已重启加载新版，「手机访问」当前**开启状态**，地址 `http://192.168.10.244:8510/?token=…`（WLAN 网卡）

## 四、当前状态：没有卡点

所有任务完成，无未完成事项，无待用户决策的问题。git 干净（除本文件），本地与远端同步。

## 五、下一步计划（候选，均非紧急）

- **二期候选**（README 里列过）：预算告警、历史导出、新增 Claude Code 数据源插件（`src/sources/` 加一个解析器即可，插件机制已就位）
- **手机访问增强候选**：局域网 IP 变化后二维码自动刷新（现在需手动重开面板）；HTTPS——Tailscale `serve` 方案见第八节（比自签证书省事）；二维码面板可考虑把 Tailscale 地址也列进去
- 发版流程已固化：`npm version minor --no-git-tag-version` → commit → `git tag vX.Y.Z` → push main + tag → CI 自动构建发 Release → `gh release edit vX.Y.Z --notes "…"` 补中文说明

## 六、踩过的坑——绝对不要再踩

这是本文档最重要的部分，全部是真实复现并修过的问题：

1. **`server.close()` 会被长连接挂死（本轮最大坑）**。close 的完成回调要等所有连接结束，仪表盘的 WebSocket 永不主动断开 → 回调永不触发 → 服务卡死在「已停止接受、未重新绑定」的中间态，**永久假死且无任何报错日志**。任何「先 close 再 listen」的换绑代码，必须**先 `terminate()` 全部 WebSocket 客户端 + `closeAllConnections()`**，再 await close。当前实现在 `doEnsureBinding()`，换绑还做了串行化（promise 链）、listen 失败重试 5 次、全部失败回退原地址。

2. **换绑会杀掉正在响应的连接**。用户点「开启」的 POST `/api/settings` 还没发完响应，换绑就把这条连接断了 → 客户端 curl 卡死。必须**先 `json(res, …)` 回响应，再 `setTimeout(100ms)` 后换绑**。

3. **手机首访 401 裸奔**。手机从 `/?token=…` 进入，但页面引用的 `/app.js`、`/style.css` 子资源请求**不携带令牌** → 全部 401 → 页面裸 HTML 卡「连接中」。所以静态壳文件必须公开（它们不含数据），令牌只拦数据接口。前端 `loadLanSection` 也带 600ms×3 重试，因为开关切换的瞬间连接必断一次。

4. **UDP connect 探测默认路由在这台机器上是错的**。用户机器有 FlClash（TUN，198.18.0.1）、Radmin VPN、两块 VMware 网卡，UDP connect 会选到 TUN。用静态评分 `lanRank()` 替代（见第二节）。改任何网卡选择逻辑前，先跑 `Get-NetIPAddress -AddressFamily IPv4` 看这台机器的真实网卡情况。

5. **Electron 改代码不重启不生效**。用户的应用是常驻进程，旧代码在内存里，重新 `npm run build` 后**必须重启进程**才加载。用户自己重启前会说「没有变动」——先想到这个。

6. **测试不要占用用户的 8510 端口**。用户应用一直在跑。测试用独立端口 + 独立数据目录：
   ```bash
   mkdir -p .tmp-run/TokenUse && printf '{"port":8519}' > .tmp-run/TokenUse/settings.json
   APPDATA="E:\\TokenUse\\.tmp-run" node dist/server/cli.js   # 后台跑
   ```
   数据源走 `os.homedir()`，APPDATA 覆盖不影响读真实用量。测完 `rm -rf .tmp-run` 并停掉后台任务。

7. **Service Worker 需要安全上下文**。局域网 HTTP 下 `navigator.serviceWorker` 直接是 undefined（不是报错）。代码里用 `'serviceWorker' in navigator` 前置守卫了，别去掉。后果：Android「添加主屏幕」是快捷方式，iOS 走 apple meta 标签不受影响。

8. **CI 发版靠 tag 触发**：push `v*` tag → `Build & Release` workflow → electron-builder + softprops/action-gh-release。不要本地跑 `npm run dist` 再手动传（历史上这么干过，后来改 CI 了）。构建约 2 分钟，`gh run watch <id> --exit-status` 盯完。

9. 小坑：`gh release view --json` 不支持 `isLatest` 字段；jq 表达式里别用中文 key（解析报错）。

10. **Service Worker 缓存壳文件：改了 `web/` 前端后用户端可能「看不到变化」**。`127.0.0.1` 是安全上下文，桌面浏览器同样会注册 SW；sw.js 以 cache-first 缓存 `/app.js` 且不回源验证，所以改代码、重启服务后，已打开的仪表盘页面仍跑旧 JS。修法：**每次改前端必须把 sw.js 里的 `CACHE` 版本号 +1**（现为 `tokenuse-shell-v5`），用户刷新 1–2 次后生效（skipWaiting + clients.claim 已配好）。另：ECharts 数值轴标签别用 `fmtTokens`（`1000.0 万` 带小数带空格，刻度一多必重叠），用 `fmtAxisTokens`（去尾零）+ `hideOverlap: true`。

11. **Windows 下 `%APPDATA%` 环境变量对 Electron 的 userData 不生效**（Chromium 的 appData 路径走系统 API 而非环境变量）：带 `APPDATA=xxx` 启动 electron 会加载真实用户数据 + 撞单实例锁 + 秒退。隔离启动 Electron 实例必须用代码里预留的 **`TOKENUSE_DATA_DIR`** 环境变量（`electron/main.ts` 开头处理，须在单实例锁之前 setPath），配合独立端口 settings.json。坑 6 的 `%APPDATA%` 覆盖法只对 `node dist/server/cli.js` 这种纯 Node 进程有效。

## 七、常用命令速查

```bash
npm run build          # esbuild 打包 4 个入口 + tsc --noEmit 类型检查
npm test               # build + 类型检查 + 全部单测（tests/，入口 scripts/test.mjs）
npm start              # build + electron .（开发模式，用户就这么跑的）
npm run server         # 只起服务不开壳
curl http://127.0.0.1:8510/api/health       # 用户应用存活探测
curl http://127.0.0.1:8510/api/lan-info     # 手机访问状态（仅本机可达）
gh run list / gh release view v0.2.0        # CI 与发布状态
```

改了 `src/` 或 `web/` 后：`npm run build` → 重启用户的 electron 进程 → 再验证。验证「手机访问」开关来回切换时，务必带一条活跃 WebSocket 再测（坑 1 只在有长连接时复现）。

## 八、Tailscale 外网访问（2026-09-02 配置完成）

用户要「在外面用手机实时查看」，方案：PC 与手机都装 Tailscale 组私有网，手机经 Tailscale IP 访问同一仪表盘（令牌鉴权不变，与局域网共用同一个 `lanAccess.token`）。

- PC 端：Tailscale 1.102.3（winget 安装），已登录（账号见本机 Tailscale 客户端），主机名 `tokenuse-pc`，Tailscale IP `100.67.185.18`，服务 StartType=Automatic 开机自启，`--accept-dns=false`
- 手机访问地址：`http://100.67.185.18:8510/?token=<settings.json 里 lanAccess.token 的值>`（100.64/10 网段地址按节点固定不变）
- **防火墙坑**：原有放行是 electron.exe 的 Public 档规则，而 Tailscale 接口是 **Private** 档 → 外部入站会被拦（本机 curl 自己的 100.x IP 测不出来，那是本地路径）。已新增入站规则「TokenUse Web 8510」（TCP 8510，Private+Public）
- 已实测：Tailscale IP 上静态壳 200 公开、`/api/state` 无令牌 401 / 带令牌 200、390×844 视口整页渲染正常
- **HTTPS/PWA 已开启（2026-09-02）**：tailnet 已 Enable HTTPS，`tailscale serve --bg 8510` 反代 `https://tokenuse-pc.<tailnet>.ts.net/` → `127.0.0.1:8510`（完整域名用 `tailscale serve status` 查），真证书（非自签）。已实测 SW 注册 active=true，Android 可装完整 PWA。关闭：`tailscale serve --https=443 off`
  - **本机 MagicDNS 解析不通**（`--accept-dns=false` + FlClash）：本机访问 ts.net 域名靠 hosts 里加的一条 `100.67.185.18 <完整 ts.net 域名>`（提权写入的）；手机端不受影响（Tailscale App 自带解析）。若换 tailnet 名/IP 需同步改 hosts
  - **经 serve 反代的请求对 TokenUse 表现为 127.0.0.1 → 令牌豁免生效**：HTTPS 地址不需要 `?token=`（tailnet 成员即边界，个人 tailnet 可接受）；直连 `100.67.185.18:8510` 仍要令牌。改 `authorized()`/`isLocal()` 逻辑时要想到 serve 的存在
- 常用：`"/c/Program Files/Tailscale/tailscale.exe" status | ip -4 | serve status`
