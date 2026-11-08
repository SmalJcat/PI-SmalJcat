# 多窗口：独立审阅窗口 P2.2（0.4.1 增量）

路线图《Pi Desktop → ChatGPT 级桌面端》的 P2.2：把改动审阅放进**独立窗口**，长对话与看 diff 互不挤占，并可把文件引用回主窗口输入框。

## 窗口模型

| 项 | 做法 |
|---|---|
| 标签 | 固定 `review`（单实例：重复打开只聚焦并刷新） |
| 页面 | 打包产物 `review-window.html`（Vite 多页面第三个入口） |
| 存储隔离 | `data_directory` 指向 `<用户数据>/review-window` |
| 能力 | 新增 `capabilities/review.json`，窗口匹配 `review`，只给事件通道 |
| 命令校验 | `review-context` / `review-changes` / `review-diff` / `review-reference` 只接受 `review` 标签 |
| 导航 | 只允许 `tauri.localhost` |

工作区路径**不落盘**：审阅窗口每次调用都从实时会话读取 `core.current().cwd`，所以主窗口切换工作区后，审阅窗口刷新即跟随。窗口只保存打开时的初始选择（文件 + 暂存分组）。

## 双向交互

- **主窗口 → 审阅窗口**：检查器标题栏的按钮以当前预览文件为初始选中打开窗口；重复打开会发 `review://refresh` 让已有窗口刷新。
- **审阅窗口 → 主窗口**：`review-reference` 由 Rust 侧发出 `review://reference`，主窗口把它拼成既有引用格式（`请查看文件：<路径>:<行号>`）写入输入框并加入引用标签（沿用一次最多 8 个文件的既有上限）。

## 界面行为

审阅窗口左侧按未暂存 / 已暂存分组列出改动（状态文案：已修改 / 新增 / 已删除 / 已重命名 / 未跟踪），右侧显示补丁或完整文件：补丁按增删着色并显示 `+n −m` 统计，完整文件带行号。标题栏显示工作区路径、当前分组与「引用到主窗口」。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/desktop.rs` | 新增 `ReviewWindows`（初始选择）、`Services` 结构（把 5 个子系统收敛成一个参数，dispatch 不再膨胀）、6 个审阅窗口通道 |
| `src-tauri/capabilities/review.json` | 新增：审阅窗口能力集 |
| `review-window.html` + `src/review-window/main.ts` | 新增：审阅窗口页面 |
| `src/window-review.mjs` | 新增：状态文案、初始选中、补丁统计、引用文本（纯函数） |
| `src/App.tsx` | 检查器新增「在新窗口打开审阅」按钮；监听 `review://reference` 写入输入框 |
| `vite.config.ts` | 多页面入口增加 `review-window.html` |
| `tests/window-review.test.mjs` | 5 项前端逻辑测试 |

## 验证

```powershell
Set-Location desktop
npm test            # JS：59 项（新增 5 项）
npm run build       # 三个页面：index / widget-sandbox / review-window
npm run test:rust   # Rust：lib 48 项 + 集成测试
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run test:ui     # 真实 WebView2 验收（确认主界面未被破坏）
```

## 已知限制

- 审阅窗口是**只读**的：不能暂存/还原改动，也不能切换工作区（跟随主窗口）。
- 与主窗口共享同一个 Pi 会话：不新增连接，也不触发会话锁；这是刻意的取舍，避免第二客户端争用同一会话。
- 行号定位尚未做：引用回主窗口时行号固定为 1（补丁行的精确映射需要额外的补丁解析）。
- 未做窗口位置/大小记忆。
