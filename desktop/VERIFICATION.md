# Pi Desktop 发布验收

## 0.4.1 输入候选菜单更新

从仓库 main `2d205cf` 同步后，在 `fix/composer-keyboard-completions` 分支继续开发。输入菜单支持 `/` 键盘补全、可靠的文件候选、中文输入与换行保护，以及 Esc 关闭候选优先于停止任务。

本次通过：19 项 JavaScript 测试、27 项 Rust 回归、Clippy 严格检查和格式检查；最终 0.4.1 WebView2 验收包含 29 项通过记录（含正常关闭与 Pi 进程退出），无渲染异常。发布版读取真实 Pi 的模型、命令、MCP 与有效压缩设置，不调用模型。

详细行为、同步范围和证据路径见 [0.4.1 变更记录](docs/COMPOSER-0.4.1.md)。当前发布文件版本及 SHA-256 以 `release/tauri/release.json` 和 `artifacts/tauri-release-result.json` 为准。以下保留 0.4.0 原始验收，不应将其旧程序哈希或当时的服务状态作为 0.4.1 状态。

## 0.4.0 原始发布验收

版本：Pi Desktop 0.4.0。日期：2026-11-07（香港时间；JSON 时间戳使用 UTC）。

环境：Windows x64、Rust 1.98.1 MSVC、Node.js 24.14.1、Pi 1.5.0、Tauri 2、系统 WebView2。0.3 说明、验收和原始证据已保留在 `docs/TAURI-0.3*.md`、`artifacts/versions/0.3/`。

## 本轮实现

- 上下文管理面板：当前模型窗口、用量、有效压缩配置和触发阈值；自动开关与按模型的预留 / 保留 token 配置；全局与受信任项目范围；保存后重载；手动压缩重点、取消、失败重试、摘要、前后用量估计、耗时及费用记录。
- 通过内嵌 Pi 扩展读取其项目信任及 settings/modelOverrides 解析结果。扩展保留当前连接的设置快照，外部文件修改不会被误显示为已经生效；重载后使用新扩展上下文再次读取结果。
- 原生 default 探子工作台：独立 Pi 进程与持久化子会话、4 个并发槽、排队、逐项取消、错误记录、新会话重试、原会话继续、用量、工具活动、复制与引用结果、父会话导航。
- 主 Agent 的 `desktop_scout` 工具与手动派发共用工作台。子任务绑定父工具调用；父任务取消或连接退出时清理其派发的任务，手动后台任务保持独立。主会话识别受管理的探子 PID，避免误判为外部写入冲突。
- 关闭与崩溃恢复：所属进程树受 Windows Job Object 管理；重启将未结束任务标为中断，保留已有结果与子会话，手动继续或重试，不自动调用模型。

## 检查结果

- TypeScript、Vite、测试程序与 release 构建通过；`cargo clippy --all-targets --features test-fixture -- -D warnings` 和 `cargo fmt -- --check` 通过。日志：`artifacts/v04-ui.log`、`v04-package.log`、`v04-clippy.log`、`v04-fmt.log`。
- 14 项 JavaScript 测试通过；包括自动压缩开始后保持运行状态、等待权威空闲状态后解锁的事件顺序。日志：`artifacts/v04-js-tests.log`。
- 27 项 Rust 测试通过：13 项模块测试、4 项任务管理集成测试、6 项协议 / 进程 / Git 集成测试、4 项文件工作流测试。覆盖配置保留与非法输入、活跃和过期锁、压缩中断记录、独立子会话、四并发与排队、运行 / 排队取消、父工具取消与手动任务隔离、模型错误、新会话重试、原会话继续、关闭与重启恢复、越界恢复拒绝。日志：`artifacts/v04-rust-tests.log`。
- 25 项真实 Tauri / WebView2 模拟 Pi 验收通过，渲染错误为 0。保留 0.3 流式对话、模型、扩展弹窗、附件、会话保护与文件审阅覆盖，并加入压缩配置、压缩失败 / 重试 / 取消、子代理队列与并发、逐项取消、重试与继续、用量与引用、主工具派发与回传、派发响应前取消、模型错误，以及运行中强制退出应用后重新打开并继续同一子会话。会话确认已落盘后才执行崩溃测试；退出后核对所属 Pi PID 已结束。证据：`artifacts/tauri-ui-result.json`、`artifacts/v04-ui.log`、`artifacts/v04-task-records.json`。
- 真实 Pi 的配置检查通过：使用隔离的 agent 配置、工作区与主会话，验证全局 / 项目按模型覆盖、未重载文件修改不改变已加载快照、保存后运行时生效、全局配置保持、无关字段保持、项目覆盖保护；模型调用为 0。日志：`artifacts/v04-real-context.log`。
- 真实 Pi 工具权限检查通过：探子仅有 `find / grep / ls / read`，MCP 禁用，模型调用为 0。日志：`artifacts/v04-agent-contract.log`。
- 真实探子模型检查通过：默认跟随 `openai/gpt-6.1-sol`，返回 `PI_DESKTOP_AGENT_OK`，状态 completed，独立会话已保存；主会话在探子进程存在时可正常操作。成功检查发起 1 次短模型调用，Pi 报告总计 5,565 tokens（含缓存读取 4,096）和费用约 $0.00342。工作区、主会话与子会话都在隔离临时目录。日志：`artifacts/v04-real-agent.log`。
- Tauri + Vite 开发窗口连接与正常关闭通过，版本 0.4.0，渲染错误为 0。证据：`artifacts/tauri-dev-result.json`、`artifacts/v04-dev-ui.log`。
- 最终 release 程序连接真实 Pi 通过：实际版本 0.4.0、61 个模型、31 个命令、无 Node integration、压缩开关开启，当前模型预留 140,000 / 保留 20,000 tokens，触发阈值 671,200。正常关闭且所属 Pi 退出。发布启动验收不调用模型。证据：`artifacts/tauri-release-result.json`、`artifacts/v04-release-ui.log`。
- 已查看上下文概览、压缩历史、子代理工作台、任务结果与恢复界面截图。截图：`artifacts/v04-context-overview.png`、`v04-context.png`、`v04-agents-overview.png`、`v04-agents.png`、`v04-agents-recovered.png`。

## 发布物

程序：`release/tauri/Pi Desktop.exe`，Windows 文件资源中的实际产品版本为 0.4.0。程序 12,589,568 字节；发布目录包含图标与清单共 12,593,475 字节（约 12.01 MiB）。不包含 Pi 本体、WebView2、用户数据。

SHA-256：

```text
B3739AC0188B03F7768636A7E21637C8E2F4FFCDADE1E2263EF199A9CA9C0260
```

构建源文件、发布文件、`release/tauri/release.json` 与发布验收记录哈希一致。桌面及 `D:\PI` 的快捷方式均指向该 0.4.0 程序。核验记录：`artifacts/v04-release-metadata.json`。0.3 可执行程序与清单保留在 `release/tauri-0.3/`，0.2 和 Electron 旧版也保留。

## 已知范围与限制

- 初次真实调用发现用户 default 定义中的 `gpt-6.1-terra` 被当前模型接口拒绝（404 model_not_found，返回用量为 0）。该记录保留在 `artifacts/v04-real-agent-terra.log`。新版默认跟随主模型；原代理定义保持，仍可显式选择其模型。重试沿用原任务配置，换模型需新建任务。本轮共两次探子请求尝试：一次模型不支持，一次成功。
- 本轮未对用户长会话执行真实模型压缩；压缩 UI、前后估计和错误 / 取消事件使用确定性协议模拟验收，真实 Pi 验证覆盖有效配置、保存与运行时重载。
- 工作台当前只管理 default 只读探子和 `desktop_scout` 派发的任务；旧 `subagent` 扩展的任务保留原工具卡片显示，不提供逐项控制。尚无多主会话并行、多种代理角色、执行型代理或自动 worktree 合并。
- 显示最近 300 条任务、前 128 KB 结果及最近 40 项工具活动；每次运行最长一小时。未实现任务目录清理界面。中断后需用户手动继续，不恢复已丢失的模型流式片段。
- 当前真实 MCP 状态：node_repl、blender、rea connected；agentdock failed，故障尚未修复。探子不连接 MCP。
- Vite 主 JavaScript 分块约 536.38 kB，gzip 164.45 kB，仍有超过 500 kB 的构建提示。
- 保留 README 中会话协作锁、外部写入检测、终端专属功能与第三方扩展的兼容边界。未做其他 Windows 机器、真实系统拖放手势、OAuth 或 macOS / Linux 的完整验收；当前未签名，没有安装器或自动更新。
