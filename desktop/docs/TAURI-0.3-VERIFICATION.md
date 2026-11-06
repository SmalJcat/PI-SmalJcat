# Pi Desktop 0.3 发布验收

版本：Pi Desktop 0.3.0。日期：2026-11-07（香港时间；JSON 时间戳使用 UTC）。

环境：Windows x64、Rust 1.98.1 MSVC、Node.js 24.14.1、Pi 1.5.0、Tauri Rust 2.12.5 / CLI 2.12.4、系统 WebView2。0.2 历史记录保留在 `docs/TAURI-0.2-VERIFICATION.md`。

## 本次修复与发布流程

- 重新连接当前会话时，所有入口默认保留输入框文本、图片附件和文件引用。连接期间继续输入的文字也会保留，连接完成后不再用连接开始时的草稿覆盖它。
- 新增真实 WebView2 回归检查：在设置中重连，暂停后端响应，继续编辑，再验证文本、图片、引用和当前会话均保留。修复前的附件丢失记录见 `artifacts/versions/0.3/v03-ui-before-fix.log`。
- `npm run test:ui` 自动重建测试程序，避免误用 `npm run dev` 生成的依赖 Vite 的 debug 程序。
- 界面测试使用动态 CDP 本地端口，并核对客户端数据目录。结果 JSON 保存版本、通过项、渲染错误和实际程序哈希；正常关闭后检查所属 Pi 进程也已退出。
- 打包脚本检查 package / Tauri / Cargo 版本一致，先复制到临时文件并核对哈希，再替换发布程序，生成 `release/tauri-0.3/release.json`。

## 已完成检查

- TypeScript 类型检查、Vite 前端构建、Tauri 测试程序构建和最终 release 构建通过。日志：`artifacts/versions/0.3/v03-build-test.log`、`artifacts/versions/0.3/v03-package.log`。
- `cargo clippy --all-targets --features test-fixture -- -D warnings` 和 `cargo fmt -- --check` 通过。日志：`artifacts/versions/0.3/v03-clippy.log`、`artifacts/versions/0.3/v03-fmt.log`。
- 13 项 JavaScript 测试通过，包含消息状态、旧版协议和文件引用 / 本地链接 / Git 分组工作流。日志：`artifacts/versions/0.3/v03-js-tests.log`。
- 18 项 Rust 测试通过：8 项模块单元测试、6 项集成测试、4 项工作流测试。覆盖协议与进程生命周期、会话历史、路径穿越与 junction、会话锁和外部改写、忽略规则、文件引用内容与大小限制、暂存和工作区版本比较。日志：`artifacts/versions/0.3/v03-rust-tests.log`。
- 16 项真实 Tauri + WebView2 模拟 Pi 验收通过，渲染错误为 0。覆盖连接、文件预览与引用、中文输入、流式消息、工具、安全 Markdown、模型切换、扩展确认、停止与取回队列、会话重命名与副本恢复、图片粘贴、设置重连期间编辑、MCP 状态与重连、`@文件` 实际内容发送、左右差异、外部会话变化拦截、崩溃恢复和正常退出。另验证未允许的 `bash` 命令被后端拒绝。证据：`artifacts/versions/0.3/tauri-ui-result.json`、`artifacts/versions/0.3/v03-ui.log`。
- Tauri + Vite 开发模式识别版本 0.3.0，连接模拟 Pi，正常关闭且所属 Pi 已退出，渲染错误为 0。证据：`artifacts/versions/0.3/tauri-dev-result.json`、`artifacts/versions/0.3/v03-dev-ui.log`。
- Rust RPC 连接真实 Pi，读取到 61 个模型、30 个命令；无持久化会话，不调用模型，进程正常退出。日志：`artifacts/versions/0.3/v03-real-rpc.log`。
- 真实 Pi 的原生 `--fork` 合约检查通过：新会话 ID 和文件路径不同、历史保留、原会话字节不变，模型请求为 0。全部输入与输出会话位于隔离临时目录。日志：`artifacts/versions/0.3/v03-session-contract.log`。
- 测试程序与最终发布程序都通过真实 Pi / WebView2 启动验收：Rust/Tauri、0.3.0、61 个模型、30 个命令、无 Node integration，正常关闭且所属 Pi 已退出。证据：`artifacts/versions/0.3/tauri-real-result.json`、`artifacts/versions/0.3/tauri-release-result.json`、`artifacts/versions/0.3/v03-release-ui.log`。
- 已查看发布程序首页、MCP 面板及左右差异截图，界面显示正常。截图：`artifacts/versions/0.3/tauri-real.png`、`artifacts/versions/0.3/v03-mcp.png`、`artifacts/versions/0.3/v03-review.png`。

## 发布物与入口

程序：`release/tauri-0.3/Pi Desktop.exe`。Windows 文件资源中的实际产品版本为 0.3.0；前端资源内嵌，无 Electron / Node.js 运行依赖，需要已有 Pi 安装和系统 WebView2。

程序大小：11,997,696 字节。发布目录共 12,001,603 字节（约 11.45 MiB），包含程序、图标与发布清单，不包含 Pi 本体、WebView2 或用户数据。

SHA-256（构建源文件、发布文件、清单与发布验收记录相互核对）：

```text
9E267396EB604185BEF085538A121FC2A4C24124000834804F2FE597369AEE3F
```

桌面和 `D:\PI` 下的 `Pi Desktop.lnk` 均已核对，指向上述 0.3.0 程序。0.2 程序保留在 `release/tauri-0.2/Pi Desktop.exe`；Electron 旧程序保留在 `release/win-unpacked`。

## 当前连接状态与验证边界

- 真实 Pi 的 MCP 快照显示 node_repl、blender、rea 已连接，agentdock 为 `failed`。MCP 面板与解析器的失败状态显示已验收；该实际连接故障尚未排查修复，不能据此宣称所有已配置 MCP 服务均健康。状态见 `artifacts/versions/0.3/tauri-release-result.json`。
- 本轮模型请求为 0。0.2 的历史真实模型调用结果不作为本轮 0.3 模型端到端验收。
- 模拟交互使用临时工作区与客户端数据目录；未向用户现有会话发送消息。真实 Pi 启动检查只读取状态、模型、命令和 MCP 状态。
- 会话保护仍为协作锁与冲突检测，不能阻止不遵守锁的 CLI 写入；外部进程检测与写入窗口的限制见 README。
- 操作系统鼠标拖放手势、所有第三方扩展、自定义 TUI、OAuth 登录、其他 Windows 机器和 macOS / Linux 未做完整验收。
- Vite 仍提示主 JavaScript 分块大于 500 kB，当前输出约 517.61 kB，gzip 159.52 kB；构建和功能验收均通过。
- 未测量冷启动、空闲内存或大规模长会话性能。当前未签名，没有安装器或自动更新。
