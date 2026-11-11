# Pi Desktop 0.7.1 · Rust + Tauri

为 Pi 1.5.0 构建的 Windows 桌面客户端。React / TypeScript 提供界面，Rust 管理 Pi RPC、进程、会话与本地文件，Tauri 2 使用系统 WebView2 显示窗口。

生产版不再使用 Electron 或 Node.js。Pi 的模型、MCP、工具和扩展继续通过现有 `pi.exe` 运行。

## 上下文与底部统计

上下文圆环悬停/点击显示紧凑卡片：已用百分比、用量/容量、自动压缩状态与设置入口。输入框底部显示速度和花费。Pi 速度为最近一次完整回复的输出 token / 本地接收耗时，包含等待与传输，切换会话或模型后重新统计；费用沿用 Pi 会话统计。Antigravity 显示 CLI 上报费用，暂无可靠速度数据时显示 `—`。未知数据不显示为零。

## 0.7.1 消息复制与编辑

悬停用户消息可复制或编辑，键盘聚焦也会显示操作。助手回复保留复制入口。编辑时可保留或移除原消息图片，普通输入框的草稿、附件和文件引用独立保留。

Pi 保存编辑后在当前会话内回到原消息之前并重新发送，会话 ID 和文件保持不变，左侧不新增会话；原消息及后续回复保留在同一会话的历史分支中。清空文字、仅保留图片时沿用普通发送的默认文字。Antigravity 使用“编辑为新消息”，在当前会话追加修改后的内容。

## 0.7.0 权限与上下文

输入栏提供请求批准、帮我批准、完全访问和自定义规则。Pi 的主会话/子代理在工具执行前接原生授权门；Antigravity 按 CLI 授权请求处理。上下文圆环可悬停/点击查看已用、剩余、窗口和压缩状态；Pi 标明估算，CLI 未报告时保持未知。详见 [契约与限制](docs/PERMISSIONS-CONTEXT.md)。

## 0.6.0 Antigravity CLI

0.6.1 输入栏直接显示当前模型和推理档位；左侧权限可切换“按需确认 / 完全访问”。切换权限会用官方启动参数重连当前会话，保留消息、模型、草稿与附件。完全访问会跳过 CLI 工具确认，仅影响当前桌面运行，重启桌面后恢复默认权限。

0.6.2 补齐桌面重开后从历史恢复模型和推理档位；只恢复当前 CLI 仍支持的选项，不会仅修改显示文字。

0.6.3 配置被 CLI 明确拒绝时保留连接并显示实际配置；通信失败仍断开并保留历史。断开后的“恢复会话”和“新会话”分别继续旧会话、连接并新建空白会话。

左侧选择 **Antigravity** → **连接已有登录**。客户端调用本机官方 `agy acp`，复用 CLI 已缓存的登录；在模型/推理面板选择 CLI 实际返回的模型。支持流式回复、图片与文本附件、停止、工具权限确认、新建和恢复历史；切回 Pi 保留双方会话和文本草稿。首次登录仍在官方 CLI 中完成。

CLI 默认位置为 `%LOCALAPPDATA%\agy\bin\agy.exe`，其它位置可在“连接设置”中选择。启动读取 Windows HTTP/HTTPS 系统代理，界面不接触 OAuth 令牌。Pi 的上下文/子代理/MCP 面板继续管理 Pi；Antigravity 使用自己的工具、配置和会话。具体边界见 [ACP 接入说明](docs/ANTIGRAVITY-ACP.md)。

## 0.5.0 当前状态

新增多角色子代理与 worktree 清理、SQLite 任务索引、会话正文检索与命中导航、命令运行器、独立审阅窗口、托盘通知、外观与快捷键设置、本地崩溃诊断及存储保留策略。桌面 MCP 客户端支持工具发现与调用；扩展面板只核查清单和签名，MCP Apps 仍使用内置演示组件。

`npm run package` 记录 Git 提交、工作区状态和源码指纹，并在构建前后校验输入未改变。`npm run deploy -- --to <目标发布目录>` 校验程序 SHA-256、保留旧版并切换发布目录；`--from <备份目录>` 可回退。目标父目录必须存在，程序应先退出。发布文件不包含用户配置、会话或签名私钥。来源字段是诊断信息，不受现行清单签名保护。

完整状态见[开发记录](docs/DEVELOPMENT.md)，打包与回退步骤见[发布说明](docs/RELEASE.md)。以下 0.4 / 0.3 小节保留各版本历史行为。

## 启动

双击桌面上的 **Pi Desktop** 或 `D:\PI\Pi Desktop.lnk`。也可以直接打开：

```text
C:\Users\1\AppData\Local\Programs\Pi Desktop\fdea6c4\Pi Desktop.exe
```

运行要求：Windows x64、Microsoft Edge WebView2 Runtime、本机 Pi 安装。客户端会从程序位置、当前目录的上级目录和 PATH 中查找 `pi.exe`；找不到时，在左下角「设置与连接」选择它，再重新连接。

本机已经具备 WebView2。当前发布程序内嵌界面资源，不需要 Node.js；它不包含 Pi 本体、用户凭据或 WebView2 安装包。

源码仓库位于 `D:\PI-SmalJcat`，构建暂存程序位于 `<repository>\desktop\release\tauri\Pi Desktop.exe`。正式安装入口统一为 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4\Pi Desktop.exe`；`fdea6c4` 是兼容现有快捷方式的目录名，不代表构建提交。桌面和 `D:\PI` 的快捷方式都指向该安装入口。`npm run package` 生成暂存程序及来源清单，再通过 `npm run deploy -- --to <安装目录>` 更新安装。

侧栏按项目组织对话，支持折叠、跨项目搜索、会话置顶、归档及恢复；项目菜单还支持显示名、项目置顶、分区管理、打开目录及移除/恢复项目，详见 [项目侧栏](docs/PROJECT-SIDEBAR.md)。旧安装副本和 Electron 回退快捷方式按用户要求清理，源码与历史说明仍保留。

## 0.4.1 输入框候选菜单

输入 `/` 查找技能、模板和扩展命令，输入 `@` 查找工作区文件。上下键循环选择，Tab 或 Enter 补全候选，不会在补全时发送消息；输入框只有完整命令时，Enter 保持直接执行的行为。Shift+Enter 始终换行，中文输入法组词阶段的 Enter 不选择候选也不发送。

Esc 优先关闭候选菜单，包括文件搜索等待和空结果状态；菜单关闭后再按 Esc，才会停止运行中的任务。快速修改关键词或切换工作区后，旧搜索结果和旧错误不会覆盖当前候选。搜索期间按 Enter / Tab 不会发送尚未补全的文件引用。文件搜索失败、无匹配或结果不完整时会在菜单中显示原因。

## 0.4 新功能

左侧新增「上下文」与「子代理」入口。

**上下文管理**：显示当前连接已加载的有效压缩配置、模型窗口、上下文用量及触发阈值。可以调整自动开关、预留 tokens、保留近期 tokens，保存到所有项目或已受信任的当前项目；token 设置只覆盖当前模型。保存会保留其他配置项，并让 Pi 重新加载设置。手动压缩支持指定保留重点、停止、失败后重试；历史展示摘要、压缩前 tokens、压缩后估计、耗时和用量。压缩后估计不是提供方的精确计费值，下一次模型响应前的上下文用量可能暂不可用。

配置通过随程序内嵌的 Pi 扩展读取，沿用 Pi 自身的项目信任和 modelOverrides 解析；从外部编辑设置后，当前连接仍显示其已加载的配置，需重新加载或重新连接后生效。保存配置时兼容 Pi 的设置锁，不覆盖其他设置；存在项目覆盖时，面板要求保存到当前项目。

**子代理工作台**：管理 `default` 只读探子，一次可批量添加 8 项，最多 4 项并行，最多 32 项运行或排队。每项任务都有独立 Pi 进程和持久化子会话；可查看实时文本、工具活动、token 用量和费用，单独取消、重试为新会话，或在中断后继续原会话。结果可以复制或引用到主输入框，父会话可以跳转查看。

探子固定使用 `read / grep / find / ls`，关闭 MCP、其他扩展、技能、模板及自动上下文资源，不带入主对话历史。系统提示可沿用 `~/.pi/agent/agents/default.md`；默认模型跟随主会话，也可以选择代理定义中的模型或手动指定。探子继承主会话已确认的项目信任，用于读取项目模型和设置；代码修改与最终验证由主 Agent 负责。

主 Agent 可使用 `desktop_scout` 工具派发探子，这些任务与手动创建的任务显示在同一工作台。停止父任务会取消该工具派发的任务；手动创建的独立后台任务保留。旧 `subagent` 扩展保持兼容，其任务仍显示在普通工具卡片中，不纳入新工作台的逐任务控制。

任务记录保存在客户端数据目录的 `agents/`，压缩尝试保存在 `context-attempts.json`。重新打开应用时，未结束的任务标记为中断，需要手动继续或重试；不会自动发起模型调用。任务列表展示最近 300 项，文本展示前 128 KB，工具活动保留最近 40 项，每次运行最长一小时。完整历史保存在任务专用的 Pi 会话中。运行中的费用为已返回用量，结束后以 Pi 会话统计为准。

0.3 程序保留在 `release/tauri-0.3/Pi Desktop.exe`；说明与验收记录见 `docs/TAURI-0.3*.md`。

## 0.3 功能

**会话保护与恢复**：恢复已有会话前检查桌面独占锁和本机 `pi.exe` 进程。Pi 1.5.0 不提供跨客户端会话锁，所以检测到其他 Pi 进程且无法确认它使用哪个会话时，会提示「复制为新会话」。复制调用 Pi 原生 `--fork`，保留历史但不修改原文件。当前会话在空闲状态下被外部改写时，下次写操作会被拦截。进程退出会释放桌面锁，磁盘锁文件可以保留，不代表仍被占用。

恢复信息保存在客户端数据目录的 `recovery.json`。重新打开应用时可以恢复上次保存的会话；未结束的任务会标记为中断，不会自动重发。断线后仍能编辑文本草稿。重新连接当前会话（包括设置里的「重新连接 Pi」）或复制会话时，保留输入框文本、附件和文件引用；连接期间继续输入的文字也会保留。已经发出但尚未执行完的动作不会被自动重试。

**MCP 面板**：左下角「MCP 连接」查看当前 Pi 会话的服务器、状态、工具数、exposure 和错误详情，支持刷新与单服务器重连。通过内置 `/mcp`、`/mcp reconnect` 操作当前连接，不另建 MCP 客户端，不调用模型。任务运行中需等待或停止再检查。替代内置 `/mcp` 的第三方扩展暂不兼容这个面板；服务器启停和配置编辑尚未加入。

**`@文件` 引用**：输入 `@` 搜索工作区文件，使用上下键选择、Enter / Tab 确认。所选文件显示在引用标签中；发送时 Rust 读取当时的文件文本并附加到消息。一次最多 8 个文件、每个 256 KB、总计 1 MB；仅支持 UTF-8 文本。搜索遵循 `.gitignore`，跳过依赖、构建与产物目录，扫描有数量和时间上限。标签移除后不会再附加内容；输入中的路径文本仍可由你编辑。

**改动审阅**：右侧按未暂存 / 已暂存分组，同一文件可以出现在两组。点击文件查看左右版本或补丁：未暂存比较暂存区与工作区，已暂存比较 HEAD 与暂存区。支持常用语言高亮、行号跳转、复制代码、引用到消息，以及通过 VS Code URI 打开对应行（需安装 VS Code 并注册协议）。对话里的相对文件链接也可打开预览。预览仍为只读。

0.2 发布程序备份在 `release/tauri-0.2/Pi Desktop.exe`；对应说明见 `docs/TAURI-0.2.md`。

## 已迁移功能

- 新建、搜索、恢复、重命名会话；当前工作区 / 全部会话筛选。
- 工作区选择与最近工作区。
- Markdown、流式消息、折叠思考内容、工具参数和执行输出。
- 模型与思考强度切换，`/` 技能 / 模板 / 扩展命令查找。
- 运行中发送补充指令或后续任务。停止时先取回队列，再中止运行。
- 文本 / 图片文件选择、原生文件拖放、剪贴板图片粘贴。
- 工作区文件树、文本预览、引用路径到消息、Git 差异。
- 扩展确认 / 选择 / 输入 / 多行编辑弹窗、通知、状态和文本小组件。
- HTML 导出、手动压缩上下文、会话文本草稿。
- 原生窗口控制、单实例、关闭运行中任务时的确认。

快捷键：`Enter` 发送，`Shift+Enter` 换行，`Esc` 停止，`Ctrl+N` 新会话，`Ctrl+O` 选择工作区，`Ctrl+,` 设置。中文输入法组词阶段的 Enter 不发送消息。

一次最多 8 个附件，总大小 20 MB；单个文本附件最多 256 KB。文件预览最多显示前 256 KB。侧栏列出最近 300 个会话，聊天默认展示最近 100 条可见消息，可加载更早历史。

## 配置与迁移

Pi 配置仍使用 `~/.pi/agent` 或 `PI_CODING_AGENT_DIR`；会话目录遵循 Pi 的 `sessionDir` / `PI_CODING_AGENT_SESSION_DIR`。客户端不另存 API 密钥，也不修改 Pi 本体。

Tauri 偏好默认保存在：

```text
%APPDATA%\local.pi.desktop\preferences.json
```

首次启动且没有 Tauri 偏好时，会读取 `%APPDATA%\pi-desktop\preferences.json`，复用 Electron 版的 Pi 路径和最近工作区。旧偏好保持原样。WebView2 使用独立数据目录，因此 Electron 尚未发送的本地草稿不会自动迁移；Pi 已保存的会话可以正常恢复。附件不跨会话保存。

工作区默认沿用 Pi 已保存的信任设置。在设置中勾选「本次连接加载当前项目的配置与扩展」再重新连接，会给本次 Pi 进程添加 `--approve`，不改变全局信任文件。

环境变量：`PI_DESKTOP_EXECUTABLE` 指定 Pi 可执行文件，`PI_DESKTOP_WORKSPACE` 指定首次默认工作区，`PI_DESKTOP_USER_DATA` 指定客户端偏好和 WebView2 数据目录。已有偏好优先于默认工作区变量。

## Rust 后端设计

`src-tauri/src/rpc.rs` 使用 Tokio 持续消费 stdout，按 LF 解析 JSONL，支持分片 UTF-8、CRLF、请求 ID 关联、背压、超时、取消和异常退出。`agent_settled` 才表示任务结束。Windows Job Object 关联 Pi 及其子进程，正常关闭先结束 stdin，超时后清理进程树；输入管道阻塞时也可以退出。该 Job Object 只管理进程生命周期，不是工具执行沙箱。

`src-tauri/src/core.rs` 管理连接代次、会话切换、命令并发、扩展弹窗、偏好和对前端公开的数据。会话恢复沿当前 leaf 的 parent 链选择历史；保留压缩前的可见历史。

`src-tauri/src/workspace.rs` 管理有缓存的会话索引、附件、文件预览和 Git 查询。同步文件工作放到后台线程；预览检查真实路径，拒绝 `..`、symlink / junction 越界。Git 使用参数数组和字面路径，禁用外部 diff / textconv，限制查询时间和输出。

`src-tauri/src/desktop.rs` 提供受限的 Tauri 命令、原生文件选择器、窗口生命周期和外部链接处理。模型事件经有序 IPC Channel 传到 `src/bridge.ts`。只有主窗口具有必要的事件监听和拖动权限，没有给前端开放通用 shell 或文件系统插件。

额外 Rust 模块：`session_guard.rs` 负责协作锁和文件变化检查，`mcp.rs` 解析当前内置 MCP 状态文本，`review.rs` 负责文件搜索、引用与版本比较。界面新增 `src/ReviewPanel.tsx` 与 `src/workflows.mjs`。

0.4 的 `agents.rs` 管理任务、并发槽、取消、进程与子会话，`context.rs` 管理压缩记录和设置写入；`src/WorkspacePanels.tsx` 提供两个面板。主会话会识别本桌面管理的探子 PID，避免将其当作外部会话冲突。关闭运行中后台任务时同样会确认，并清理所属进程树。

React 的主要界面仍在 `src/App.tsx`，消息状态在 `src/transcript.mjs`。渲染器不具有 Node.js 接口；生产 CSP 由 Tauri 配置注入，禁用 HTML 和远程图片自动加载，阻止外部页面导航。

客户端不修改 Pi 本体；Pi 工具的访问权限由 Pi 和操作系统决定，文件预览限制不会限制工具。

会话保护是桌面端协作锁和冲突检测，不是操作系统对会话文件的独占访问。它能阻止支持该锁的桌面客户端同时恢复同一会话；不能阻止不遵守锁的旧 CLI 直接写文件。Windows 外部进程探测针对 `pi.exe`，不识别重命名 Pi、Node.js 启动的 CLI 或其他主机。外部变化检测针对空闲阶段，不能保证识别在 Pi 正在写入期间发生的第三方写入。因此仍应避免多个不配合锁的客户端同时使用原会话，检测到不明确占用时使用副本。检查与外部程序启动之间也不构成原子互斥。

## 开发

需要 Node.js 22.19+、Rust 1.98.1（`rust-toolchain.toml` 固定版本）、Visual Studio C++ 构建工具和 Windows SDK，以及 WebView2。

```powershell
Set-Location <repository>\desktop
npm ci
npm run dev
```

常用命令：

```powershell
npm run build       # TypeScript + Vite
npm run package     # Rust release + 内嵌前端，复制到 release/tauri
npm start           # 打开 release/tauri 中的程序
npm test            # JS 消息状态和旧版协议回归
npm run test:rust   # Rust 核心、进程与文件测试
npm run test:pi     # Rust 连接真实 Pi，不调用模型
npm run test:context # 真实 Pi 隔离配置保存与重载，不调用模型
npm run test:agent:contract # 核验真实 Pi 探子只开放四个只读工具，不调用模型
npm run build:test  # 测试专用 Tauri debug 程序
npm run test:ui     # 先构建测试程序，再做真实 WebView2 + 模拟 Pi 交互验收
node tests/tauri-smoke.mjs --real     # 测试程序连接真实 Pi
node tests/tauri-smoke.mjs --release  # 验证最终发布程序
node tests/tauri-dev-smoke.mjs        # Tauri + Vite 开发启动验证
node tests/pi-session-contract.mjs   # 真实 Pi 副本恢复，原会话保持不变，不调用模型
```

直接运行 `tauri-smoke.mjs` 前需先运行 `npm run build:test`；`npm run dev` 会把同一路径下的 debug 程序切换为依赖 Vite 的开发版本。`npm run test:ui` 会自动重建，避免误用该程序。

界面验收结果保存在 `artifacts/tauri-ui-result.json`、`tauri-real-result.json`、`tauri-release-result.json` 和 `tauri-dev-result.json`。结果记录程序版本、通过项、渲染错误和关闭后的 Pi 进程检查；前三项还记录实际程序的 SHA-256。测试启动时先标记未通过，全部断言和退出检查完成后才标记成功。

显式真实模型验证，会消耗一次模型调用用量，不保存会话，且关闭工具、扩展与上下文资源：

```powershell
node scripts/native.mjs cargo run --manifest-path src-tauri/Cargo.toml --no-default-features --bin pi-rpc-check -- --model
```

真实探子模型验收（一次短模型调用，使用临时工作区和会话，并核验主会话可在探子运行时操作）：

```powershell
node scripts/native.mjs cargo run --manifest-path src-tauri/Cargo.toml --no-default-features --bin pi-workspace-check -- --model
```

Rust 检查：

```powershell
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

构建脚本会补充当前用户 `.cargo/bin` 到子进程 PATH，无需修改系统 PATH。仓库默认使用 crates.io；如需本机镜像，可自行创建被 Git 忽略的 `.cargo/config.toml`，避免把个人网络配置强加给协作者。

`test-fixture` 是显式测试编译特性，普通 `npm run package` 不启用。模拟 Pi 进程不进入正常生产路径。界面验收通过单次进程的 WebView2 环境变量和动态本地端口临时开启调试连接，并核对客户端数据目录，防止误连其他窗口；正常启动不设置该变量。

旧 Electron 源码保留在 `electron/`，用于历史协议回归；已打包旧版可独立运行。0.3 / 0.4 新功能只针对 Tauri 开发和验收，不承诺旧 Electron 源码能运行当前全部界面。生产 Tauri 程序不携带 Electron 文件或依赖。

## 当前范围与限制

当前只有一个主会话，审阅可以独立开窗，子代理可以并行运行；主任务运行时需要先停止再切换主会话。可写角色使用独立 worktree，不自动合并。文件预览只读，没有完整代码编辑器或交互式 PTY 终端，已有命令运行器；没有 Git 提交 / 合并界面。文件树需手动刷新，主任务结束会刷新顶层。

登录 / OAuth 和 `/tree` 等终端专属功能仍通过 Pi CLI 操作；第三方扩展的自定义 TUI 控件不能直接迁移到 RPC。尚未覆盖所有第三方扩展。

发布物是未做 Authenticode 签名的 Windows 可执行程序，支持构建 NSIS 安装器。应用内更新已实现下载、校验及下次启动替换；远端更新和安装器实际安装尚未完成端到端验收。没有 macOS / Linux 发布。已经验证的是本机 Windows / WebView2 环境，不能据此保证其他机器的安装兼容性。原生拖放事件已接入；自动化覆盖附件读取和粘贴，操作系统的真实鼠标拖放动作仍需人工体验核对。
