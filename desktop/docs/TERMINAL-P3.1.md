# 工作区命令面板 P3.1（0.4.1 增量）

路线图 P3 的第一块：在**当前工作区**跑命令并流式看输出。这是命令运行器，不是完整 TTY；分层（start / cancel / history）与事件形状为后续交互式 PTY 预留。

## 行为

- 左侧侧栏新增 **终端** 入口，打开工作区命令面板：选择 shell（cmd / Windows PowerShell / PowerShell 7）、输入命令、Enter 运行。
- 输出按行流式推送（`terminal://event`），可勾选「跟随输出」；单次输出上限 512 KB，超出从头丢弃并标记 `truncated`。
- 左侧保留最近 20 次运行记录，显示命令、状态（运行中 / 已完成 / 失败 / 已取消）与退出码；点击可回看历史输出。
- **取消**会结束进程树（`taskkill /T /F` 兜底），而不只是结束外层 shell；取消后状态是「已取消」，不会被误报为失败。
- 同一时刻只允许一条命令：重复发起会直接报错，避免两条命令争用同一工作区。

## 安全边界

- 命令**只能由主窗口发起**（`window.label() == "main"`），审阅窗口与沙箱 widget 窗口都被拒绝。
- shell 是**白名单**（cmd / powershell / pwsh），不接受把整条命令行当 shell 传入。
- 命令长度上限 8 KiB；工作区目录必须存在，否则直接拒绝。
- 输出与历史都有上限，界面只渲染尾部 400 行，避免 512 KB 一次性进 DOM。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/terminal.rs` | 新增：壳白名单、受限输出缓冲、运行/取消/历史、逐行读取与事件形状，含 7 项测试（含真实进程：echo、`exit /b 3`、取消长命令） |
| `src-tauri/src/desktop.rs` | `Services` 增加 `terminal`；新增 `terminal-run` / `terminal-cancel` / `terminal-history` / `terminal-clear` |
| `src/terminal.mjs` | 新增：状态文案、退出码文案、输出尾部、流事件归并（纯函数） |
| `src/TerminalPanel.tsx` | 新增：命令面板 |
| `src/App.tsx` | 侧栏新增「终端」入口与面板挂载 |
| `tests/terminal.test.mjs` | 6 项前端逻辑测试 |

## 验证

```powershell
Set-Location desktop
npm test            # JS：65 项（新增 6 项）
npm run build
npm run test:rust   # Rust：lib 55 项（新增 7 项）+ 集成测试
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run test:ui     # 真实 WebView2 验收（确认主界面未被破坏）
```

## 已知限制

- **没有交互式 stdin**：不能跑 `python` REPL、`ssh` 之类需要输入的会话，也不能响应 `[Y/n]` 提示。
- 不是终端模拟：没有 ANSI 颜色/光标控制解析，输出按纯文本渲染；交互式 PTY（xterm.js + portable-pty）是下一步。
- 输出按行合并，stdout/stderr 顺序在极端交错场景下可能不精确。
- 环境变量继承桌面进程；没有每次运行的 env 覆盖与工作目录切换。
