# 桌面端 MCP 客户端 P1.2（0.4.1 增量）

路线图《Pi Desktop → ChatGPT 级桌面端》的 P1.2：把 `mcp.rs` 从「解析 Pi 的 `/mcp` 文本输出」升级为桌面进程**按 MCP 协议直接连接服务器**，拿到结构化工具清单并可以调用。这也是 MCP Apps 沙箱宿主的前置。

## 与现有 `mcp.rs` 的关系

| 通道 | 视角 | 用途 |
|---|---|---|
| `mcp-status`（原有） | Pi | 解析 Pi 内置 `/mcp` 命令的文本，展示 Pi 自己管的连接 |
| `mcp-servers` / `mcp-tools` / `mcp-call` / `mcp-disconnect`（新增） | 桌面 | 桌面自己连接、列工具、调用 |

两者共用同一份 `mcp.json`，因此不会出现「Pi 连了但桌面看不到」的错位；断开桌面连接也不影响 Pi。

## 服务器定义

沿用 Pi 的 `<agent 目录>/mcp.json` 的 `mcpServers` 结构，支持：

- stdio：`command` / `args` / `env`
- HTTP：`url` / `headers`
- `enabled`（默认 true）、`timeout`（秒，工具调用超时）、`exposure`（原样展示）
- `PLACEHOLDER` 形式的环境变量引用（env 与 headers 都会展开）

缺失的环境变量**不会被静默替换**：列表里对该服务器给出「缺少环境变量 X」的告警，界面直接显示。既没有 command 也没有 url 的条目判为「定义无效」。

## 协议行为

- 握手：`initialize`（协议版本 `2025-06-18`，clientInfo `pi-desktop`）→ `notifications/initialized`；握手超时 30 秒。
- 工具：`tools/list` 结果按界面需要投影（name / description 截断到 400 字 / required / inputSchema 截断到 8 KB），并在会话内缓存；`refresh` 可强制刷新。
- 调用：`tools/call` 带 `arguments`；**服务器返回 isError 时不抛错**，原样返回给调用方判断（与 MCP 语义一致）。
- 超时：默认 60 秒，服务器可用 `timeout` 覆盖（例如 `rea` 的 450 秒）。超时信息里附带子进程 stderr 尾部，便于定位。
- 结果上限：单次调用结果超过 256 KB 时截断并标记 `truncated`；参数必须是 JSON 对象，否则直接拒绝。
- 生命周期：连接按名字复用；`mcp-disconnect` 支持单个或 `*` 全部；关闭应用时统一断开。会话 `Drop` 与 `kill_on_drop` 双保险，避免留下孤儿进程。

## 界面行为

「设置与连接」中新增 **MCP 连接（桌面）** 卡片：

- 每个服务器一行：状态徽标（已连接 / 未连接 / 已禁用 / 定义无效）、传输类型、命令或 URL、超时、exposure、工具数。
- 按钮：**连接 / 刷新工具**、**断开**、**工具列表**（可折叠）。
- 工具列表可搜索；点选工具后按必填字段生成参数骨架，改完 JSON 直接**调用工具**，结果按文本块渲染，图片/音频/资源显示占位符，`isError` 结果用红色左边框标出。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/mcp_client.rs` | 新增：`mcp.json` 解析与环境变量展开、stdio 会话（JSON-RPC + 超时 + stderr 尾部）、HTTP 传输（curl 请求/响应，兼容 SSE）、工具投影、结果限长、`McpManager`，含 7 项单元测试 |
| `src-tauri/src/bin/mcp-fixture.rs` | 新增：测试用 MCP 服务器（`echo` / `add` / `fail`），不依赖任何外部运行时 |
| `src-tauri/tests/mcp_client.rs` | 新增：3 项端到端测试（真实子进程）+ 1 项 `#[ignore]` 本机实测 |
| `src-tauri/src/desktop.rs` | `DesktopState` 持有 `McpManager`；新增 5 个通道；关闭应用时统一断开 |
| `src-tauri/src/update.rs` | `curl_exe()` 改为公开，供 MCP HTTP 传输复用 |
| `src/mcp.mjs` | 新增：状态文案、告警归属、工具筛选、schema 字段解析、参数校验与骨架、结果渲染 |
| `src/McpToolsPanel.tsx` | 新增：服务器/工具/调用面板 |
| `src/bridge.ts` / `src/types.ts` | 新命令与类型 |
| `src/styles.css` | 卡片样式（工具列表、参数框、结果块） |
| `tests/mcp.test.mjs` | 7 项前端逻辑测试 |

## 验证

```powershell
Set-Location desktop
npm test            # JS：47 项（新增 7 项）
npm run build       # TypeScript + Vite
npm run test:rust   # Rust：lib 39 项（新增 7 项）+ mcp_client 端到端 3 项
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

本机实测（可选，默认 `#[ignore]`）：

```powershell
$env:PI_DESKTOP_LIVE_SERVER = 'rea'   # 默认就是 rea
node scripts/native.mjs cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --test mcp_client -- --ignored --nocapture
```

它会读取真实的 `mcp.json`，连接指定服务器、列出工具并调用一个无副作用的工具（如 `binary_session`）。

## 已知限制

- HTTP 传输是**请求/响应**模型：不维持 SSE 长连接，也不处理服务端主动通知；会话 id（`mcp-session-id`）尚未在多次请求间复用。stdio 是完整实现。
- 未处理 `notifications/tools/list_changed`：工具清单只在连接或显式刷新时更新。
- 未做 MCP `resources` / `prompts`：本阶段只桥接 `tools`（与 DSH mcp-client 的取舍一致）。
- 连接由桌面进程托管，不向 Pi 注入工具；要让 Pi 用上这些工具仍走 Pi 自己的 MCP 配置。
- 尚无 MCP Apps 沙箱宿主（那是 P1.2 的下一步，需要独立 WebView + 白名单 API）。
