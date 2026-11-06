# Pi Desktop 0.3 · Rust + Tauri

为 Pi 1.5.0 构建的 Windows 桌面客户端。React / TypeScript 提供界面，Rust 管理 Pi RPC、进程、会话与本地文件，Tauri 2 使用系统 WebView2 显示窗口。

生产版不再使用 Electron 或 Node.js。Pi 的模型、MCP、工具和扩展继续通过现有 `pi.exe` 运行。

## 启动

双击桌面上的 **Pi Desktop** 或 `D:\PI\Pi Desktop.lnk`。也可以直接打开：

```text
D:\PI\desktop\release\tauri\Pi Desktop.exe
```

运行要求：Windows x64、Microsoft Edge WebView2 Runtime、本机 Pi 安装。客户端会从程序位置、当前目录的上级目录和 PATH 中查找 `pi.exe`；找不到时，在左下角「设置与连接」选择它，再重新连接。

本机已经具备 WebView2。当前发布程序内嵌界面资源，不需要 Node.js；它不包含 Pi 本体、用户凭据或 WebView2 安装包。

`npm run package` 会同步程序到上述发布目录，校验复制后的 SHA-256，并生成 `release/tauri/release.json`，记录版本、程序大小、哈希和同步时间。桌面快捷方式始终指向此目录。

旧版完整程序仍位于 `release/win-unpacked/Pi Desktop.exe`，可通过 **Pi Desktop (Electron)** 快捷方式回退。旧说明与验证记录保存在 `docs/ELECTRON-0.1*.md`。

## 0.3 新功能

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

React 的主要界面仍在 `src/App.tsx`，消息状态在 `src/transcript.mjs`。渲染器不具有 Node.js 接口；生产 CSP 由 Tauri 配置注入，禁用 HTML 和远程图片自动加载，阻止外部页面导航。

客户端不修改 Pi 本体；Pi 工具的访问权限由 Pi 和操作系统决定，文件预览限制不会限制工具。

会话保护是桌面端协作锁和冲突检测，不是操作系统对会话文件的独占访问。它能阻止支持该锁的桌面客户端同时恢复同一会话；不能阻止不遵守锁的旧 CLI 直接写文件。Windows 外部进程探测针对 `pi.exe`，不识别重命名 Pi、Node.js 启动的 CLI 或其他主机。外部变化检测针对空闲阶段，不能保证识别在 Pi 正在写入期间发生的第三方写入。因此仍应避免多个不配合锁的客户端同时使用原会话，检测到不明确占用时使用副本。检查与外部程序启动之间也不构成原子互斥。

## 开发

需要 Node.js 22.19+、Rust 1.98.1（`rust-toolchain.toml` 固定版本）、Visual Studio C++ 构建工具和 Windows SDK，以及 WebView2。

```powershell
Set-Location D:\PI\desktop
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

Rust 检查：

```powershell
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

构建脚本会补充当前用户 `.cargo/bin` 到子进程 PATH，无需修改系统 PATH。当前 `.cargo/config.toml` 为本机网络使用 rsproxy 稀疏索引镜像，仍由 Cargo 校验 crate checksum；需要直接使用 crates.io 时删除该文件中的 source replacement。

`test-fixture` 是显式测试编译特性，普通 `npm run package` 不启用。模拟 Pi 进程不进入正常生产路径。界面验收通过单次进程的 WebView2 环境变量和动态本地端口临时开启调试连接，并核对客户端数据目录，防止误连其他窗口；正常启动不设置该变量。

旧 Electron 源码保留在 `electron/`，用于历史协议回归；已打包旧版可独立运行。0.3 新功能只针对 Tauri 开发和验收，不承诺旧 Electron 源码能运行当前全部界面。生产 Tauri 程序不携带 Electron 文件或依赖。

## 当前范围与限制

当前每个窗口运行一个会话；任务运行时需要先停止再切换。文件预览只读，没有内置完整代码编辑器、终端、Git 提交 / 合并操作。文件树需手动刷新，任务结束会刷新顶层。

登录 / OAuth 和 `/tree` 等终端专属功能仍通过 Pi CLI 操作；第三方扩展的自定义 TUI 控件不能直接迁移到 RPC。尚未覆盖所有第三方扩展。

发布物是本机未签名的 Windows 可执行程序，没有安装器、自动更新、macOS / Linux 发布。已经验证的是本机 Windows / WebView2 环境，不能据此保证其他机器的安装兼容性。原生拖放事件已接入；自动化覆盖附件读取和粘贴，操作系统的真实鼠标拖放动作仍需人工体验核对。
