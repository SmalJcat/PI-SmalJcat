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
