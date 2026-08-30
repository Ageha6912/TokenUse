# TokenUse

实时监测 AI 编程工具（ZCode / Codex CLI）token 消耗与等效金额的本机工具。
数据全程留在本机，不经过任何第三方。

## 快速开始

```bash
npm install
npm run build
npm start        # 启动 Electron 应用：仪表盘窗口 + 托盘 + 悬浮数字条
```

也可以只跑监测服务（不开 Electron 壳），用浏览器访问 http://127.0.0.1:8510：

```bash
npm run server
```

## 数据来源

| 来源 | 方式 | 说明 |
| --- | --- | --- |
| ZCode | 只读挂载 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` / `session` 表 | 每次模型请求一行，含项目路径、模型、Agent；监听 db 与 db-wal 变化增量拉取 |
| Codex | 解析 `~/.codex/sessions/**/*.jsonl` 的 `token_count` 事件 | 用 `last_token_usage` 得到单请求粒度 |

数据源做成插件（`src/sources/`），要支持 Claude Code 等工具时新增一个解析器即可。

## 统计口径

- 总 tokens = 输入 + 输出 + 缓存读 + 缓存写（两家的 input 字段都不含缓存，口径一致）；推理 tokens 已含在输出里，单独展示不重复计
- 金额为「等效成本」：按价格表折算，缓存读用折扣价；按 `provider_id` 区分「套餐内 / 按量」，`builtin:zai-start-plan` 默认套餐内
- 匹配不到价格的模型金额显示 `—`（计入"未定价"条数），tokens 照常统计

## 配置文件（都在 `data/` 下，可直接编辑）

- `settings.json` — 轮询间隔（默认 3 秒）、美元汇率、各 provider 计费方式、悬浮条/开机自启
- `prices.json` — 价格覆盖表（每 1M token，CNY/USD），优先级最高
- `remote-prices.json` — 从 LiteLLM 价格库拉取的远程价（设置里点按钮更新）

## 目录结构

```
src/core/      类型、价格表、聚合器/存储
src/sources/   ZCode SQLite 与 Codex JSONL 数据源插件
src/server/    HTTP + WebSocket 实时服务（仅绑定 127.0.0.1）
electron/      托盘、悬浮数字条、仪表盘窗口
web/           仪表盘前端（原生 TS + ECharts）
scripts/       esbuild 构建与图标生成
```

## 已知边界

- ZCode 的库是内部格式，若其升级改表结构，解析器会安全失败并在下轮重试；必要时删 `data/` 重启
- 请求明细最多缓存最近 2000 条（聚合数字不受影响，基于全量数据）
- 预算告警、历史导出、更多工具支持：二期候选
