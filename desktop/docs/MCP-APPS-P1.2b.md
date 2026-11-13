# MCP Apps 沙箱宿主 P1.2b（0.4.1 增量）

2026-11-13 的开发分支新增真实服务器资源宿主，使用标准 MCP Apps postMessage 协议、HTML 资源与实际工具调用。当前契约见 [MCP Apps 宿主](MCP-APPS-HOST.md)。本文件保留早期内置演示的设计与验证过程。

路线图《Pi Desktop → ChatGPT 级桌面端》的 P1.2b：让 MCP 服务器提供的 widget **能显示但碰不到宿主能力**。宿主只暴露一份固定白名单，默认拒绝，逐项授权。

## 为什么不是 iframe

最初打算用 `iframe sandbox + postMessage` 复刻 ChatGPT 的形态，分析后发现与本仓库现有 CSP 冲突：

- 生产 CSP 是 `script-src 'self'` 且没有 `frame-src`（回落到 `default-src 'self'`）；
- 带 `sandbox` 且不给 `allow-same-origin` 的框架是不透明源，`'self'` 不再匹配，框架内的模块脚本会被拦；
- 若改用 `srcDoc` / `data:` 还会额外触碰 `frame-src`。

放宽 CSP 或给 `allow-same-origin` 都会削弱隔离，因此改为**独立 WebView 窗口**：这也更接近 ChatGPT 桌面端的真实做法（独立分区 + preload 桥），而且不需要改 CSP。

## 隔离与通道

| 项 | 做法 |
|---|---|
| 渲染隔离 | 独立窗口 `widget-<slug>-<hash>`，加载 `widget-sandbox.html` |
| 存储隔离 | `data_directory` 指向 `<用户数据>/widgets/<label>`，与主窗口不共享 WebView2 存储 |
| 能力隔离 | 新增 `capabilities/widget.json`，窗口匹配 `widget-*`，只给事件通道；自定义命令在 Rust 侧按窗口标签二次校验 |
| 身份 | 页面不读查询参数：调用 `widget-identity` 由宿主按窗口标签反查，widget 无法自报成别的会话 |
| 导航 | 只允许 `tauri.localhost`，外链与重定向被拒绝 |

主窗口原有的 `pi_command% / `pi_subscribe` 一开始就拒绝非 `main` 窗口，所以沙箱窗口天然拿不到会话、文件与进程能力。

## 白名单（19 项）

沿用 ChatGPT 桌面端逆向观察到的两组能力，风险分级：

- **基础 12 项**：`navigate`、`notifyMcpAppsHostContext`、`notifyMcpAppsToolCancelled`、`notifyMcpAppsToolInput`、`notifyMcpAppsToolResult`、`requestMcpAppsResourceTeardown`、`runWidgetCode`、`setAdditionalGlobals`、`setSafeArea`、`setTheme`、`setWidgetData`、`setWidgetView`
- **扩展 7 项（默认拒绝，全部高风险）**：`applyAutofillCandidate`、`getCurrentPath`、`notifyMcpAppsMcpNotification`、`prepareEnvironment`、`runUserCode`、`screenshot`、`stop`

授权计算是 deny-by-default：请求了但没勾选 → `denied`；不在白名单 → `unknown`（两者都不会被放行）。

## 消息校验（宿主侧权威）

widget 发来的原始字符串要依次通过：

1. **大小**：单条 ≤ 64 KiB，载荷 ≤ 32 KiB；
2. **形状**：必须是 JSON 对象，带版本标记 `pi: 1`；
3. **字段**：`id` 限 `[A-Za-z0-9_-]{1,64}`，`api` 必须在白名单内**且**在该会话的授权集合内；
4. **原型污染**：任何层级出现 `__proto__` / `constructor` / `prototype` 直接拒绝；
5. **记录**：成功与失败都进审计（环形缓冲 200 条），审计里的 api 字段带 widget 前缀便于定位。

沙箱里没有真实宿主能力，`mock_result` 返回可预期的占位结果，方便演示与测试。

## 界面行为

「设置与连接」中新增 **MCP Apps 沙箱** 卡片：选择内置夹具 widget → 逐项勾选授权（基础 / 扩展分组，标注风险）→ **打开沙箱窗口** → 在窗口里点按钮触发 `setWidgetData` 等调用，或点越权按钮观察被拒；卡片下方实时显示审计，可按「刷新审计」拉取。高风险能力被勾选时给出显式提醒。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/mcp_apps.rs` | 新增：白名单目录、授权计算、消息校验、原型污染与大小限制、会话与审计、窗口标签生成、夹具目录，含 9 项单元测试 |
| `src-tauri/src/desktop.rs` | 新增 `widget-catalog` / `widget-open`（建窗+复用）/ `widget-identity` / `widget-invoke` / `widget-audit` / `widget-close`，后三者只接受沙箱窗口 |
| `src-tauri/capabilities/widget.json` | 新增：沙箱窗口的能力集合 |
| `widget-sandbox.html` + `src/widget-sandbox/main.ts` | 新增：沙箱页面（唯一出口是 `widget-invoke`） |
| `vite.config.ts` | 多页面入口（`index.html` + `widget-sandbox.html`），构建产物多出一个独立页面与 chunk |
| `src/widgets.mjs` + `src/WidgetHostPanel.tsx` | 新增：沙箱属性、消息预检、审计展示与授权面板 |
| `tests/widgets.test.mjs` | 7 项前端逻辑测试 |

## 验证

```powershell
Set-Location desktop
npm test            # JS：54 项（新增 7 项）
npm run build       # 产出 dist/index.html 与 dist/widget-sandbox.html
npm run test:rust   # Rust：lib 47 项（新增 9 项）+ 集成测试
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run test:ui     # 真实 WebView2 验收，确认没有破坏既有界面
```

## 已知限制

- 夹具 widget 是内置的（`fixture_catalog`）；从真实 MCP 服务器把 widget 资源接过来是下一步。
- 沙箱窗口没有独立的进程沙箱：它仍是同一个应用进程里的另一个 WebView，靠窗口标签、能力集与授权集合隔离；要更强的隔离需要单独的渲染进程策略或独立进程。
- 授权是会话级的（内存中），应用重启后回到默认拒绝；没有持久化授权与「记住选择」。
- `mock_result` 只模拟少量能力；真实能力（截图、自动填充等）尚未接入宿主实现。
