# 云端开发与 Windows 验收

云端运行前端和 Rust 核心检查；发布平台仍为 Windows。Linux 核心检查不代表 Windows 进程树、Tauri 桥接或 WebView2 已通过。

## 云端

需要 Node 24、Git、C 编译器、rustup。进入 `desktop`，运行：

```sh
rustup show active-toolchain # 自动读取 rust-toolchain.toml，安装固定版本及组件
npm ci --ignore-scripts
npm run check:cloud
```

云端不需要 Electron、GTK 或 WebKit；不调用真实 Pi / 模型。检查包括前端构建、JS 测试、Rust 核心测试、fmt 和无 desktop feature 的严格 Clippy。

## Windows 独立验收副本

使用新目录中的 clone / worktree，不覆盖日常使用的原项目，不复制个人 `.pi`、认证文件、会话或偏好。需要 Node 24、固定 Rust/MSVC、C++ Build Tools、Windows SDK、WebView2。

```powershell
Set-Location <独立副本>\desktop
rustup show active-toolchain
npm ci
npm run check:windows
```

这会运行同样的核心检查、包含桌面桥接的 Clippy，以及测试专用 Tauri 构建和 WebView2 模拟 Pi 验收。UI 脚本使用临时工作区与客户端数据目录，不操作原项目。检查截图并确认最终 `tauri-ui-result.json` 中 `success: true`、渲染错误为空、所属 Pi 进程已退出。测试中断或任意检查失败时不得视为通过。真实模型验收另行明确安排。

## 可追溯证据与交接

每次检查输出到 `artifacts/verification/cloud/` 或 `windows/`：

- `result.json`：提交、工作区改动、源码摘要、每项退出码、耗时、总结果。
- `sources.json`：所有未忽略源码的 Git blob 哈希，经过 Git 换行规范化，便于逐文件核对两个平台。
- 每项检查的 `.log`。界面结果与截图仍保存在 `artifacts/`。

比较两端 `sourceDigest`；如果不同，比较 `sources.json` 找出差异，不要将等价重写的测试宣称为同一份源码验收。验证期间不要修改源码。检查报告可能包含本机路径，应在外发前检查。

先提交本地分阶段改动，再通过 Git bundle 或获授权的分支传递精确提交。例如在仓库根目录：

```sh
git bundle create ../pi-desktop-review.bundle main..HEAD
```

Windows 独立副本可 `git fetch <bundle路径> <分支名>`，再创建本地分支指向 `FETCH_HEAD`。首次初始化的空仓库不能直接应用增量 bundle，需要已有基线提交；完整副本可使用包含完整分支历史的 bundle。不要手工重建测试文件。

CI 的 Linux / Windows 两个 job 使用同一脚本，成功或失败均保留验收证据 14 天；不会自动发布。GitHub workflow 尚未运行前，本地成功不能代替 CI 成功。

## 重命名修复基线

本地提交 `2407b0b` 修复已暂存重命名被补丁视为整文件新增，并新增两项回归测试。此前 Windows 独立副本报告 14 项 JS、29 项 Rust、24 项 WebView2 UI 测试通过；生产文件 blob 与云端一致，但回归测试是等价重建，属于既有参考证据。本流程后续要求传递并验证精确提交。

## 可选浏览器组件检查

`npm run test:agents:ui` 使用独立的假任务数据，检查搜索、翻页、异步结果隔离、完整结果分页和归档交互；不连接真实 Pi。先 `npx playwright install chromium --only-shell`（Linux 按需加 `--with-deps`），或将 `PI_DESKTOP_CHROMIUM` 指向本机兼容的 Chromium 程序。证据在 `artifacts/agents-browser/`。运行环境拒绝浏览器启动或无法下载安装包时，记录为未完成，不计为通过；Windows 原生验收新增的 `scout-history-checks.mjs` 使用真实 Rust 桥接覆盖核心流程。

## WebView2 启动诊断

原生 UI 验收在普通环境最多等待 CDP 30 秒，在设置了 `CI` 的环境最多等待 120 秒；单次握手最多 5 秒，并受剩余总预算限制。初次启动和崩溃恢复使用同样的重试逻辑，进程退出或启动错误会提前失败，不会把超时当作通过。

`tauri-ui-result.json` 的 `startup` 包含各次启动的端点、调试参数、尝试次数、耗时、首个及最后一个连接错误、进程状态与有限长度的标准输出/错误；成功连接还记录 WebView2 版本。等待期间约每 10 秒打印一次连接错误，CI 将其保存在 `webview2.log`。这能区分端口未监听、握手超时和原生进程提前退出；若仍失败，应据此继续定位，而不是仅延长等待或跳过 UI 验收。

### 提升权限的 Windows runner

2026-11-07 的 CI run `42326325085` 使用 `windows-2025-vs2026`，进程存活但 120 秒内 CDP 始终拒绝连接。这个证据只能证明端口未监听，不能证明没有图形会话或 WebView2 崩溃。

Microsoft [安全文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags) 说明：提升权限的宿主会忽略 `WEBVIEW2_*` 环境变量和 HKCU 覆盖，但接受 API 配置。此前脚本仅传 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，同时删除了应用的端口配置，这会使提升权限环境中的 CDP 无法开启。

测试脚本现在将同一个随机端口通过 `PI_DESKTOP_DEBUG_PORT` 传入；只有 `test-fixture` 构建解析端口并调用 Tauri 的 `additional_browser_args` API。只接受 1–65535 的数字，固定绑定回环地址，不允许额外参数注入。生产构建不包含此路径。保留环境参数供已有非提升权限的非 fixture 验收使用，不写注册表、不关闭沙箱、不降级运行时，也不跳过 UI 检查。

CI 的 `webview2-environment.json` 记录镜像、会话编号、UserInteractive、提升权限状态及已注册运行时版本。fixture 原生输出标记 run/setup/core/window 阶段，用于区分应用初始化阻塞和 CDP 参数问题。若仍失败，先核对这些证据；非交互会话是独立可能性，不能仅凭 ECONNREFUSED 就认定。此修复仍必须由新的 Windows CI 实跑确认。

### 会话冲突的确定性前置条件

run `42327880060` 已在约 2 秒连接 CDP。后续“会话保护”超时源于测试未创建占用者就要求冲突弹窗；干净 runner 正常恢复会话，本机若有无关 `pi.exe` 则会触发保守保护，掩盖这个前置条件缺失。

UI 验收现在使用仅 `test-fixture` 可构建的 `pi-session-lease` 子进程，通过生产 `session_guard::acquire` 持有目标会话的真实租约。重命名后恢复与崩溃后恢复都先核对“另一个 Pi Desktop 占用”，再验证弹窗、副本路径及原文件字节不变，最后释放租约。父进程关闭 stdin 或退出时租约自动释放，不依赖用户机器上的其他 Pi 进程。`check:cloud` / `check:windows` 同时运行 `test:session-lease`，覆盖真实进程间锁冲突、释放后重新获取、原文件不变和启动失败。
