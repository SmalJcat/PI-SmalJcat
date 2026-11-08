# Pi Desktop 发布验收

## 0.6.3 配置恢复失败处理（2026-11-08）

- 明确区分 CLI 的 JSON-RPC 配置拒绝、请求超时和传输失败。配置被明确拒绝或成功响应仍未改变时，保留服务端已确认的实际配置、提示并继续；超时/连接中断关闭连接，不声称配置已生效。失败前还原原会话，避免将未确认配置写回旧缓存。
- 增加 `connect-new`，断开状态区分“恢复会话”和“新会话”。用户可在同一工作区跳过失效历史，原缓存与草稿保留；不自动重发模型请求。其余功能边界保持 [开发记录](docs/DEVELOPMENT.md) 中的状态。
- JavaScript 104 项、Rust 145 项通过（2 项本机测试默认跳过），TypeScript/Vite、严格全目标 Clippy 和格式化通过。新增故障注入覆盖配置拒绝/未改变、配置中进程退出、新会话初始化失败、失效历史恢复与显式新建、旧缓存保护；短超时测试验证超时与明确拒绝的错误类型区分。
- 15:55 HKT 0.6.3 完成 56 项真实 WebView2 + fixture 验收，渲染错误 0、模型请求 0。新增在真实桌面恢复时注入模型配置拒绝，确认仍保持连接、显示 Gemini fixture / 高的实际值与简短提示，并保留对话/草稿；断开后新建绕过旧会话，旧草稿仍在。已查看 `artifacts/v063-config-warning.png`。
- 日志：`artifacts/v063-js.log`、`v063-rust.log`、`v063-clippy.log`、`v063-debug-build.log`、`v063-ui.log`，回执 `tauri-ui-result.json`。本轮未调用真实模型。

正式程序交付（16:00 HKT）：

- 来自干净提交 `f47d47b31051b072f8b8f06fca2549077da0e820`；122 个文件的源码指纹 `31fd915398f3e6f4ee7ae2d52cd84fbae9ae61ffecfa4d623af5da63f8ac15ca`。程序 17,251,328 字节，SHA-256：`5db969054fdcacc9807dacefe5dd56811b6123bb442ead6d9358d7d948565ddc`。
- 15:59 HKT 正式 0.6.3 通过 6 项真实 Pi/官方 ACP 检查，渲染错误 0、模型请求 0；已查看 `artifacts/v063-official-desktop.png`。回执和程序、清单 SHA-256 一致。
- 已同步实际 Windows 桌面安装目录 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4` 和 `D:\PI\desktop\release\tauri`，两处 ProductVersion 为 0.6.3，快捷方式目标已核对。原 0.6.2 备份分别为 `fdea6c4.backup-2026-11-08T08-00-54-073Z-975c0d8b`、`tauri.backup-2026-11-08T08-00-54-512Z-4912377c`。
- 记录：`v063-package.log`、`v063-release.log`、`v063-deploy-installed.log`、`v063-deploy-runtime.log`；用户原窗口确认空闲后正常关闭，用户凭据、设置和历史均保留。未生成新 NSIS 或进行 Windows 代码签名。

## 0.6.2 历史模型恢复（2026-11-08）

- 补齐 0.6.1 真实旧会话复查发现的问题：CLI 新进程恢复历史时可能返回默认模型配置。现在按缓存重新设置仍受支持的模型/推理选项，服务端成功后再落盘，界面保持服务端确认过的值。
- Rust 141 项通过（2 项默认跳过），全目标严格 Clippy 通过；加强的回归验证 manager 重开与缓存恢复后的模型和档位。官方 CLI 1.5.3 的 metadata-only 检查额外验证关闭旧 manager、建立新连接并恢复同一历史后的 Claude Opus 5.5 / low 配置；本轮模型请求 0。证据：`artifacts/v062-rust.log`、`v062-clippy.log`、`v062-official-metadata.log`。
- 15:24 HKT 新构建的 0.6.2 完成 54 项 WebView2 + fixture 验收，渲染错误 0、模型请求 0；前端 JS 104 项沿用 0.6.1 的通过记录，本次没有改变其运行逻辑。15:25 HKT 正式程序另通过 6 项真实 Pi / ACP 检查，模型请求 0；已查看 `artifacts/v062-official-desktop.png`。证据：`v062-debug-build.log`、`v062-ui.log`、`v062-release.log`、`tauri-ui-result.json`、`tauri-release-result.json`。
- 15:26 HKT 已将最终 0.6.2 同步到 Windows 桌面快捷方式对应安装目录及 `D:\PI\desktop\release\tauri`，两处 ProductVersion、清单和验收文件哈希一致。程序 17,234,432 字节，SHA-256：`c8f28f98a2abb18f3ce98db67e84b147dac7c1d448df016c91595a1fe262b0bd`。
- 构建来自干净提交 `87b70b985d83e2f41c8b077955a1b34571e0b0c4`；122 个文件的源码指纹 `c16957029e4a841b90cff05fc7699afab34c624d1f3ade973743076c3e8494b1`。原 0.6.1 备份为 `fdea6c4.backup-2026-11-08T07-26-33-265Z-348c8a00` 与 `tauri.backup-2026-11-08T07-26-33-710Z-af5b433a`；0.6.0 备份仍保留。未生成新 NSIS 或 Windows 代码签名。

## 0.6.1 输入栏与权限（2026-11-08）

- Pi / Antigravity 输入栏直接显示当前模型和推理档位；Antigravity 权限从静态文字改为真实的按需确认 / 完全访问选择。通过官方 CLI 启动参数切换，不修改全局配置；重连恢复当前会话、有效模型/推理、草稿和附件。收紧权限失败后也保持按需确认。具体边界见 [接入说明](docs/ANTIGRAVITY-ACP.md)。
- JavaScript 104 项、Rust 141 项通过（2 项本机服务测试默认跳过），TypeScript/Vite、全目标严格 Clippy 与格式化通过。新增 ACP 集成覆盖权限双向切换、同会话重连、配置保留、双向切换失败、长 Unicode 流及图片能力/类型校验和缓存重开恢复。
- 15:12 HKT 真实 WebView2 + fixture 验收 54 项通过、渲染错误 0、模型请求 0。新增当前模型/档位的可见文字、权限进程切换与旧 PID 退出、会话/草稿/附件保留、发送失败保留附件、运行中禁止切换权限，以及 2048 组中文/emoji 加长 URL 的完整流式输出和消息宽度检查。已查看正常/1024px 截图：`artifacts/v061-antigravity.png`、`v061-antigravity-small.png`。
- 本机官方 CLI 1.5.3 的 metadata-only 集成验证通过：真实 `--dangerously-skip-permissions` 与默认模式双向切换后恢复同一会话、模型/推理。模型调用 0，没有改全局 CLI 账号或权限设置。记录：`artifacts/v061-official-metadata.log`；本轮未再次执行真实模型任务。
- 回执/日志：`artifacts/tauri-ui-result.json`、`v061-ui.log`、`v061-js.log`、`v061-rust.log`、`v061-clippy.log`、`v061-debug-build.log`。已用 computer-use 确认原桌面窗口空闲并正常关闭，为正式版验收释放单实例。

正式程序交付（15:17 HKT）：

- 从干净提交 `7bb3435c3164894208cffe6c9b863f844e724d81` 构建，122 个范围内文件的源码指纹为 `72fa1433202a95673d3a5605e6db366803ffdebbd08075d4b205b8b1c1420952`。程序 17,230,848 字节；SHA-256：`375642d726605a26a17a30531bcee98c09517ca9ac0f20d746e6e7c1bf910c59`。
- 15:16 HKT 正式程序完成 6 项真实 Pi / ACP 检查，渲染错误 0、模型请求 0。真实 CLI 双向切换完全访问/按需确认，恢复同一会话、当前模型和草稿；已查看 `artifacts/v061-official-desktop.png`，确认当前 Claude Opus 5.5 与档位在关闭浮层后仍可见，输入卡片没有重复的内层焦点边框。
- 已同步 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4` 与 `D:\PI\desktop\release\tauri`，两处 ProductVersion 为 0.6.1，文件、清单和正式验收 SHA-256 一致，Windows 桌面快捷方式目标已核对。旧 0.6.0 分别保留为 `fdea6c4.backup-2026-11-08T07-17-33-061Z-42bba3f5`、`tauri.backup-2026-11-08T07-17-33-509Z-ae70a505`。
- 日志：`artifacts/v061-package.log`、`v061-release.log`、`v061-deploy-installed.log`、`v061-deploy-runtime.log`。本轮没有生成新 NSIS 安装器或进行 Authenticode 签名；凭据、个人配置、会话与构建产物不提交 Git。

## 0.6.0 Antigravity CLI（2026-11-08）

- 新增独立 ACP v1 后端、主区和受管理子进程，复用官方 CLI 的已有登录。桥接、权限、历史与当前边界见 [接入说明](docs/ANTIGRAVITY-ACP.md)。
- JavaScript 104 项通过；Rust 138 项通过、2 项本机服务测试默认跳过；TypeScript/Vite、全目标 test-fixture 严格 Clippy 与格式检查通过。新增后端集成覆盖真实子进程握手、配置、Unicode 流式、缓存恢复、load 重放不重复、显式权限/非法选项、取消等待、取消超时与异常退出；额外验证旧取消 watchdog 不会杀死下一轮任务。
- 12:18 HKT 真实 WebView2 + 模拟 Pi/ACP 最终验收 52 项通过，渲染错误 0，fixture 模型调用 0。新增空 Pi 会话与 Antigravity 的单主区可见性/几何检查，以及权限允许/拒绝、模型/档位写入、新建/恢复、Pi/ACP 草稿与会话隔离、发送回执前编辑保留、取消权限、1024px 小窗口、断开后的 PID 退出检查。强制结束测试桌面父进程时不使用 `/T`，验证 Windows Job 清理 Pi 与 ACP 子进程。首次正式版截图发现欢迎页 display 覆盖隐藏状态，已提高状态隐藏规则优先级并补空会话回归；测试几何只针对可见主区。
- 使用本机官方 Antigravity CLI 1.5.3 完成一次真实 Claude Opus 5.5 只读任务：只读临时目录 README，回复其中的标记；未改项目或账号配置。此任务消耗官方 CLI 对应的模型用量，可能含内部工具轮次；与 fixture 的零调用记录分开。另验证了真实 initialize、模型/档位配置、session/list 和新建后恢复（额外模型调用 0）。记录：`artifacts/v060-official-acp.log`、`v060-official-metadata.log`。
- 已查看 `artifacts/v060-antigravity.png`，窄窗口截图为 `v060-antigravity-small.png`；完整本地回执/日志在 `tauri-ui-result.json`、`v060-ui.log`、`v060-js.log`、`v060-rust.log` 与 `v060-acp-tests.log`。测试产物、用户 CLI 凭据和会话不提交 Git。

正式程序交付（12:27 HKT）：

- release 构建来自干净提交 `7a19735e3257f77e69ff1954adda2b2a3a0fb975`；122 个范围内文件的源码指纹为 `cc9abb954afba57e030111f03e93b7892e6c47dee269b397d3871decdbaac916`。后续文档提交不改变程序源码。
- 程序 17,191,936 字节；SHA-256：`f5be5b82284cdd28b543851c0c89f8786807b9765cd5d521172d35eecde98000`。
- 12:24 HKT 正式程序完成真实 Pi 与官方 ACP 启动验收，6 项通过、渲染错误 0、模型请求 0。读取已有登录、真实模型列表，切换到 Claude Opus 5.5，断开并核对所属进程退出；已查看 `artifacts/v060-official-desktop.png`，确认只有一个主区且输入栏正常。记录：`artifacts/tauri-release-result.json`、`v060-release.log`。复现入口：`pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tests/run-tauri-ui-medium.ps1 -Mode release -Antigravity`。
- 已部署到 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4` 和 `D:\PI\desktop\release\tauri`；两处 ProductVersion 均为 0.6.0，程序、清单和正式验收 SHA-256 一致。Windows 桌面快捷方式仍指向该安装目录，退出并重新打开应用即可使用。
- 安装目录原 0.5.3 备份：`fdea6c4.backup-2026-11-08T04-27-06-083Z-a8ce704a`；D:\PI 原版备份：`tauri.backup-2026-11-08T04-27-06-568Z-c2be4499`。部署日志：`artifacts/v060-deploy-installed.log`、`v060-deploy-runtime.log`。
- 本轮没有重新生成 NSIS 安装器或进行 Authenticode 签名；用户 CLI 凭据、个人配置、会话和构建产物不提交 Git。

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
