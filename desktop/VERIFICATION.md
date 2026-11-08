# Pi Desktop 发布验收

## 0.5.3 参考图输入栏（2026-11-08）

- 新增工作区/此计算机顶栏、分层圆角输入卡片、访问设置入口、蓝色发送按钮，以及模型/推理强度浮层。访问入口复用现有设置，不虚构完整权限模式或语音能力。
- 模型列表可搜索并支持键盘选择；推理滑条按当前模型支持档位生成，支持鼠标和键盘保存。选择失败保留列表，可直接重试；运行时禁用修改。Escape 关闭浮层、恢复焦点且不停止任务。
- 新浮层渲染到 body 并跟随按钮位置，在 1024×640 窗口仍位于视口内。测试已覆盖模型切换后重新读取档位、无推理模型禁用滑条、设置中/低/高档位、失败重试、Esc 与原有发送/停止/补全行为。
- JavaScript 102 项、Rust 132 项通过（1 项本机 MCP 测试跳过）；TypeScript/Vite、严格 Clippy 与格式检查通过。真实 WebView2 + 模拟 Pi 验收 48 项通过，渲染错误 0，模型调用 0。
- 已查看正常及窄窗口截图：`artifacts/v053-composer-popup.png`、`v053-composer-models-small.png`，输入栏近景为 `v053-composer-detail.png`。Electron 历史验收脚本同步改用新模型控件，未额外运行 Electron 全套验收。

正式程序交付（09:54 HKT）：

- release 构建成功，源提交 `6d46c565866873dded317279c14905871ca69686`，构建时工作区干净。
- 程序 16,673,792 字节；SHA-256：`b1a96233a05cc467f52f264296e3e374707d0ca794d228c44086af14897e2307`。
- 已同步到 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4` 与 `D:\PI\desktop\release\tauri`；ProductVersion 和 SHA-256 均核对一致，Windows 桌面快捷方式仍指向已更新的安装目录。
- 安装目录旧版备份：`fdea6c4.backup-2026-11-08T01-54-13-405Z-9955ec79`；D:\PI 旧版备份：`tauri.backup-2026-11-08T01-54-13-853Z-dcc209a7`。
- 本轮未重跑正式版真实 Pi 启动检查或生成 NSIS 安装器；用户原有窗口保持运行，退出并重新打开后加载新版。48 项桌面验收针对隔离测试构建，模型请求为零。

## 0.5.2 长输出与原生模型菜单（2026-11-08）

- 修复长 URL / JSON 错误文本突破 flex 气泡边界；错误与通知完整换行，代码块只在内部横向滚动。模型原生选项显式设置背景/文字色，并增大选择控件字号和宽度。
- JavaScript 102 项、Rust 132 项通过（1 项真实 MCP 测试跳过）；TypeScript/Vite、Clippy 和格式检查通过。
- 09:17 HKT 真实 WebView2 + 模拟 Pi 验收共 46 项通过，渲染错误 0，模型调用 0。覆盖 1440px / 1024px 的长错误边界、横向溢出、内容完整性，以及三种主题的选项不透明背景和至少 4.5:1 文字对比度。
- 已查看 `artifacts/v052-error-1440.png` 和 `v052-error-1024.png`。另用 computer-use 打开隔离测试窗口的 Windows 原生模型菜单，确认未选项深底亮字、选中项文字可读，随后关闭测试窗口；Playwright 页面截图不能替代原生弹层检查。
- 本轮只修正显示，不改变模型请求、错误原文或用户配置。
- 09:20 HKT 已部署到 `D:\PI\desktop\release\tauri` 和 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4`，两处 ProductVersion 为 0.5.2，实际桌面快捷方式已核对。程序 16,671,744 字节，SHA-256：`48332ba58b74dedf54a21be097d104ecc712f7124ea0b79140a1af3ef9b7baa3`；源提交 `d943556baf5147c22d431affcc3b113fdff6696e`，构建时工作区干净。
- 安装目录旧版备份为同级 `fdea6c4.backup-2026-11-08T01-20-29-902Z-6d8ad984`；D:\PI 旧版备份为 `tauri.backup-2026-11-08T01-20-30-397Z-a05c7b82`。用户正在运行的旧窗口未被打断，重开应用加载新版。
- 未重新运行正式版真实模型启动检查或构建安装器；本轮验证使用隔离的模拟 Pi，不消耗模型调用。原生菜单检查临时目录的清理命令被自动审批以 `blocked by policy` 拒绝，测试窗口已正常关闭，临时目录保留。

## 0.5.1 UI 整理（2026-11-08）

本轮修复工具导航懒加载导致的布局跳变，调整首页、子代理、设置、MCP、上下文与命令面板，并精简说明文字。完整变更见 [开发记录](docs/DEVELOPMENT.md)。

- JavaScript 102 项通过；Rust 132 项通过、1 项本机 MCP 测试跳过；TypeScript/Vite 构建、严格 Clippy 和格式检查通过。
- 09:01 HKT 的真实 WebView2 + 模拟 Pi 验收：44 项通过、渲染错误 0、模型调用 0。新增检查比较冷启动与首次打开子代理/上下文后的按钮矩形，验证欢迎区与输入框距离、新建任务展开/草稿保留，以及 1024px 设置分组、MCP 范围切换和命令入口。
- 已查看首页、新任务、任务结果、上下文与小窗口设置截图。证据：`artifacts/v051-home.png`、`v051-agent-create.png`、`v051-settings-small.png`、`v04-agents.png`、`v04-context-overview.png`；验收 JSON 和日志在 `artifacts/tauri-ui-result.json`、`v051-ui.log`、`v051-js.log`、`v051-rust.log`。
- 测试启动时曾被用户正在运行的正式版单实例门禁拦截；现在仅对显式隔离的 fixture 进程跳过该门禁，正式程序维持单实例。新增冷启动回归随后完整通过。

正式程序交付（09:05 HKT）：

- release 构建成功，源提交 `6edacfb623aa22e3de39e5929e594b4e744a8ba9`，构建时工作区干净。
- 16,671,744 字节；SHA-256：`35e6af7183ef4d543df53bf086719c3646289d7435ae279e4106bf4c32cfc95a`。
- 已同步至 `D:\PI\desktop\release\tauri` 和 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4`；两处文件 ProductVersion 均为 0.5.1，哈希与源清单一致；实际 Windows 桌面快捷方式已核对。
- 安装目录旧版备份：`fdea6c4.backup-2026-11-08T01-04-59-594Z-762d4ffa`；D:\PI 旧版备份：`tauri.backup-2026-11-08T01-05-11-321Z-bc409a18`。
- 保留了用户正在运行的旧窗口，重开应用后加载新程序。本轮没有运行正式版真实 Pi 启动检查（生产单实例会激活现有窗口）；44 项 UI 验收针对隔离的测试构建，不能声称本轮已完成正式版启动验收。没有生成新 NSIS 安装器。

## 0.5.0 本机交付（2026-11-08）

本轮统一此前增量功能版本，增加发布来源记录、可回退本地部署工具与 PowerShell 7 验收入口。当前功能与已知边界见 [开发记录](docs/DEVELOPMENT.md)。

实现前基线：JavaScript 96 项通过；Rust 132 项通过、1 项真实 MCP 环境测试跳过；TypeScript/Vite 与 desktop feature 编译检查通过。历史 WebView2 记录为 2026-11-08 08:14 HKT，0.4.1 / 41 项通过，不能作为 0.5.0 最终发布验收。

最终结果（本机 Windows / WebView2，2026-11-08）：

- JavaScript 102 项通过（含 5 项部署/回退测试和 1 项源码来源测试）；Rust 132 项通过、1 项真实 MCP 环境测试跳过。`cargo fmt --check`、带 desktop/test-fixture 的严格 Clippy 和 TypeScript/Vite 构建通过。
- 新构建的 0.5.0 debug 程序完成 41 项真实 WebView2 + 模拟 Pi 验收（08:31 HKT），渲染错误 0，模型调用 0；已查看聊天及设置截图。记录：`artifacts/tauri-ui-result.json`。这是模拟模型流程覆盖，不代表所有新增功能已在真实模型下验证。
- 正式 release 构建成功；正式程序完成真实 Pi 启动验收（08:33 HKT），读取模型、命令、MCP 和有效上下文配置，正常关闭且所属 Pi 退出；5 项通过、渲染错误 0、模型调用 0。记录：`artifacts/tauri-release-result.json`、`v050-package.log`、`v050-release.log`。
- 08:34 HKT 已部署到 `D:\PI\desktop\release\tauri`，快捷方式目标未变；源发布程序、目标程序、清单及 release 验收记录 SHA-256 一致，Windows ProductVersion 为 0.5.0。记录：`artifacts/v050-deploy.log`。
- 程序 16,670,720 字节；SHA-256：`31076c5b6e763464b40ff7884ea7d1aa54da13e86a54524cee84592a5de1ce77`。
- 构建源提交：`3a837afe44c9de90e80247ff7e1b75096b453085`，构建时工作区干净；113 个范围内文件的指纹：`464202a834ae74df309bfca84ff72986ecf61e33dde087cf3af0f64ea18ffb1a`。后续验收文档提交不改变程序源码。
- 旧运行版本保留在 `D:\PI\desktop\release\tauri.backup-2026-11-08T00-34-07-021Z-8b54cc75`；回退可将该目录作为 `npm run deploy -- --from` 的来源。

### 08:36 HKT 安装目录补同步

用户反馈实际桌面快捷方式指向 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4\Pi Desktop.exe`。前述 08:34 核验的是 `D:\PI\Pi Desktop.lnk`，遗漏了 Windows 桌面（本机为 OneDrive Desktop）上的同名快捷方式，导致用户仍启动 0.4.1。

已将相同且验收通过的 0.5.0 发布物部署到该安装目录，复核 ProductVersion、程序 SHA-256、清单及真实桌面快捷方式目标一致。保留 `fdea6c4` 目录名以兼容现有快捷方式；目录名不再代表当前构建提交，来源以清单为准。旧版备份为安装目录同级的 `fdea6c4.backup-2026-11-08T00-36-42-447Z-3154e9f5`。后续本机交付必须同时核对桌面、开始菜单、任务栏入口和运行副本，不能只检查仓库旁的快捷方式。

本轮未重新生成或安装 NSIS 包，未验证远端更新；已有 0.4.1 安装器不能代表 0.5.0。程序未做 Authenticode 签名。本轮 0.5.0 清单未签名，来源字段仅为诊断。Vite 主 chunk 约 533 kB 的体积提示仍在。构建产物、私钥、实际用户配置和会话均不提交到 Git。

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
