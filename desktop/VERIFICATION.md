# Pi Desktop 发布验收

## 0.7.1 服务器 MCP Apps 宿主交付（2026-11-13）

- 分支 codex/mcp-apps-host 按稳定版 2026-01-26 MCP Apps 接入，先发布 IPC 契约，再实现资源宿主、窗口与实际工具代理。[PR #4](https://github.com/SmalJcat/PI-SmalJcat/pull/4)
- 保留工具关联元数据，初始化声明 UI 扩展能力，按关联 URI 读取 text/html;profile=mcp-app 的 text/blob。独立 WebView 的沙箱 iframe 仅启用脚本，资源由校验窗口标签及会话 ID 的协议提供，CSP 来源经过类型、来源和控制字符校验及国际域名规范化。
- 工具逐项授权默认空，代理绑定原 MCP 连接并重新核对 App 可见性，关闭时撤销未提交请求的许可。stdio 写入与响应共享请求期限，部分写入超时关闭连接，断开可中断阻塞写入。工具传输的底层诊断链留在宿主审计，App 获得安全错误。
- JS 124 项、生产构建、侧栏 18 类、MCP 内容浏览器 4 类及 App 浏览器 4 类通过。普通 Rust 172 项、fixture Rust 174 项通过，各有 4 项真实环境检查默认忽略。格式检查与全目标严格 Clippy 通过。本机 HTTP 回环测试使用本轮进程的 NO_PROXY。
- 11:41 HKT，真实 Tauri/WebView2 + Pi/ACP/MCP fixture 71 项通过，渲染错误 0、模型请求 0。新增覆盖服务器 HTML、初始化输入/结果顺序、授权前后实际调用、iframe 来源与主窗 IPC 隔离、断线/关闭/审计，以及旧演示原生 IPC。debug 程序 SHA-256 为 52f4c31c4c97d9e87187090c2d8f1e7476ee6f285d08db73b251f6cb2e31a1a9。
- 原生调试按各隔离 WebView 的 DevToolsActivePort 连接动态端口。Windows 移除前端未使用的 JS path 插件以修复其子框架初始化异常，Rust 路径解析及原有文件/会话界面已随完整原生回归验证。独立只读复核未发现遗留的可重现代码问题。
- 证据为 artifacts/mcp-apps-verified-checks.json、mcp-apps-verified-*.log、mcp-apps-host-final.log、mcp-apps/result.json 及 tauri-ui-result.json，界面截图为 mcp-app-grants.png、mcp-app-window.png、mcp-app-rejections.png。写入超时与诊断泄漏的修复前失败回归分别保留为 mcp-apps-write-timeout-before.log、mcp-apps-diagnostics-before.log。测试使用隔离 stdio/loopback HTTP 服务。
- 当前入口在桌面 MCP 调试区，支持握手、工具输入/结果、授权后的同连接工具调用、日志及固定窗口显示模式。第三方远端 App/TLS/代理、聊天自动挂载、资源读取代理及消息/上下文协作的验证与扩展列入后续工作。[宿主契约](docs/MCP-APPS-HOST.md)
- 11:51 HKT，从干净提交 `936bd299633efab99d5c0a40f3e9f2ab6139a177` 构建并暂存 0.7.1 正式程序，18,158,080 字节，SHA-256 为 `a711bdb2095ad11cc28ba4348b60eaf8ae8c01f12efdd348c16e8985143cb9fb`。146 个文件的源码指纹为 `89ca0507df3d935466127846679ebbade0b51f4e89c469d8d3d7bb514da5c29d`，构建期间输入与提交一致。
- 11:51–11:52 HKT，正式程序先完成真实 Pi 5 项检查，再完成含官方 ACP 的 6 项检查，渲染错误 0、模型请求 0。另以 `npm run test:release -- -AppsOnly` 完成正式程序 App 专项 6 项检查，使用真实 Pi 及临时 agent/mcp.json 中的本地 stdio 服务，覆盖服务器 HTML、授权前后调用、隔离/拒绝、断线、关闭、旧演示及正常退出。全部回执程序哈希与暂存包相同。
- 11:53 HKT，通过既有部署工具更新 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4`，旧版保留为 `fdea6c4.backup-2026-11-13T03-53-18-136Z-042661d0`。安装与暂存程序的清单、大小、哈希及当前源码指纹已核对一致。交付后补充的 JS 验收入口与文档在源码指纹排除范围内。
- 正式证据为 `artifacts/package-source.json`、`mcp-apps-package.log`、`mcp-apps-release-result.json`、`mcp-apps-release-acp-result.json`、`mcp-apps-release-apps-result.json`、`mcp-apps-deploy.log` 及 `mcp-apps-release-integrity.json`。`mcp-app-window.png` 为正式程序中已授权工具返回 count 42 的截图。远端第三方 App、TLS/OAuth 及网络域实际加载仍待实测。

## 0.7.1 MCP 内容、编辑重发与 Fast 正式交付（2026-11-12，11 月 13 日补记）

- 正式包包含 `2056780` 的 MCP resources/prompts 与 CI 增量，以及 `e29c52f` 的编辑重发预检与 Fast。后者对应的远端 Windows Actions 已通过。[Windows Actions](https://github.com/SmalJcat/PI-SmalJcat/actions/runs/43164982056)
- 11 月 12 日 14:18 HKT，从干净提交 `e29c52fa00df8f65ff74db5a8bdd8a9739c83544` 构建并暂存正式程序，版本 0.7.1，17,899,520 字节。SHA-256 为 `bf16313f8b2fa463b704dbde6fb83aa0f1d0817c6138206dac74b7fd4865674f`，142 个文件的源码指纹为 `35862605236d56f11876007617d7cbfb8de602dd14b5fc4345baa623f210276b`。
- 当日 14:30 HKT，正式包完成真实 Pi / 官方 ACP 6 项检查，渲染错误 0、模型请求 0。读取真实模型、命令、MCP 及有效上下文配置，验证官方 ACP 连接与配置、正常关闭、所属进程退出和退出标记。验收程序哈希与上述正式程序一致。
- 随后通过既有部署工具更新 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4`，原安装保留为 `fdea6c4.backup-2026-11-12T06-30-13-894Z-f39d161a`。部署回执记录该安装入口及 PID 18868，阶段为 `completed`、`success: true`。
- 11 月 13 日重新计算暂存和安装程序的大小及 SHA-256，逐项比较两处发布清单，并重新计算当前源码指纹，均与构建及验收回执一致。当日复跑 JavaScript 124 项与前端生产构建通过。Rust 167/169 项、WebView2 68 项和正式包 6 项结果取自 11 月 12 日回执，远端 CI 状态另行核对。
- 构建、正式包验收与部署回执为 `artifacts/deploy-20261112-package-result.json`、`deploy-20261112-release-result.json`、`deploy-20261112-result.json`，正式验收副本为 `tauri-release-result.json`。11 月 13 日复核日志为 `review-20261113-js.log`、`review-20261113-build.log`。下方两节保留开发阶段的验证过程，当前安装交付状态以上述正式程序为准。

## 开发分支：编辑重发预检与 Fast 开关（2026-11-12）

- 先将 MCP 内容增量提交为 `2056780` 并推送 `origin/feature/mcp-resources-prompts`，对应 Windows Actions 已成功。本节修复继续在同一分支，开发验收后于当日 14:30 HKT 完成正式包验收和本机部署，见上方交付记录。[MCP 增量 Windows Actions](https://github.com/SmalJcat/PI-SmalJcat/actions/runs/43158779341)
- 编辑旧用户消息会回到父节点，后续压缩记录退出活动分支。新增策略仅在编辑标记仍为活动叶子的发送前检查取消 `threshold` 摘要；新用户消息追加后恢复通常阈值检查。手动压缩和真实溢出恢复保持原行为，未关闭全局自动压缩。Pi 仍可能短暂发出 start/aborted 事件，但不调用摘要模型。
- 原先模型弹层左上角闪电只是静态 SVG；现接入会话/模型校验、原生操作锁和扩展请求钩子。OpenAI Responses / Codex Responses / Chat Completions 传输开启发送 `service_tier: priority`、显式关闭发送 `default`；推理强度独立。状态按会话分支/模型持久化，编辑时携带现有选择；不支持的后端禁用并说明原因。兼容网关或账号的优先处理资格及实际速度未经保证。
- JavaScript **124 项**、常规 Rust **167 项**、test-fixture Rust **169 项**、TypeScript/Vite、格式及严格 Clippy 通过；Rust 两种模式各有 4 项真实环境检查默认忽略。Rust 追加 Fast 过期模型/请求校验、编辑准备后切档位幂等及运行中拒绝检查。
- `npm run test:edit-fast:contract` 使用实际 `D:/PI/pi.exe`、临时会话/配置与本机 OpenAI 兼容服务，**4 类契约通过**：高用量历史编辑重发仅一次正常请求、实际 priority/default 参数与编辑/重连恢复、手动压缩、溢出摘要及自动重试。共 7 次本机模拟请求，外部模型请求 **0**。最初夹具历史/溢出输入不足以形成压缩切点，补足可压缩历史后通过；未放宽成功断言。
- 13:51 HKT，真实 Tauri/WebView2 + Pi/ACP/MCP fixture **68 项**通过，渲染错误 **0**、模型请求 **0**。Fast 覆盖点击、Space、失败保持关闭、运行中禁用、不支持模型禁用及推理档位不变。已查看 `composer-fast-enabled.png`。debug 程序 SHA-256：`9439dea4a8ad99f546e1ed2fd1b5fbacb8c6ba33e97a1a6debdb008267c919aa`。
- 证据：`artifacts/edit-fast-js.log`、`edit-fast-full-{rust,rust-fixture,fmt,clippy,ui}.log`、`edit-fast-checks.json`、`edit-fast-contract-result.json`、`edit-fast-contract-retry.log`、`edit-fast-ui-result.json`。独立只读核验未发现新缺陷。
- 本机 Pi 的 provider 源码支持 service_tier 和请求钩子；官方 OpenAI 文档抓取返回 403，本轮未将其作为已核验来源。真实请求捕获使用 Chat Completions 兼容夹具；未实测付费远程优先档位、Codex 登录账号或 Antigravity Fast。详细契约见 [EDIT-FAST.md](docs/EDIT-FAST.md)。

## 开发分支：CI 与 MCP resources/prompts（2026-11-12）

- 分支 `feature/mcp-resources-prompts`，基于 `ab3a388`，版本为 0.7.1。本节记录打包前的 MCP 开发验收，最终正式包与本机部署见上方 11 月 12 日交付记录。
- 新增 stdio / Streamable HTTP 资源、资源模板与提示词分页枚举，资源读取及提示词获取；连接不再强制 tools/list，握手能力透传到界面。独立核验发现提示词 `resource_link` 的 URI 丢失，已补名称、URI、MIME 与回归。
- `npm ci`、TypeScript/Vite 构建、JavaScript **120 项**、常规 Rust **167 项**、test-fixture Rust **169 项**、格式检查及全目标严格 Clippy 通过。两种 Rust 模式各有 **4 项**需要本机真实配置的检查默认忽略。
- 协议回归覆盖无 tools 能力服务器、三类目录分页与不透明游标、文本/二进制内容、HTTP SSE 资源结果、提示词参数与错误、无能力拒绝、格式错误和 256 KiB 超限；MCP 定向测试 **14 项**通过，另有 1 项真实配置测试默认忽略。
- 使用 CI 同款 Playwright Chromium、`CI=true` 运行侧栏 **18 类**检查与 MCP 浏览器 **4 类**检查通过。MCP 覆盖参数校验不发请求、HTML 保持纯文本、切换后迟到响应隔离及 1440/1024px 布局。侧栏首次因焦点滚动事件晚于菜单打开而超时，增加滚动完成后键盘激活的等待后通过；启动失败清理及失败截图/回执已补齐。
- 11:21 HKT，真实 Tauri / WebView2 + 隔离 Pi/ACP/MCP fixture **67 项**通过，渲染错误 **0**，模型请求 **0**。新增 3 类 MCP 检查完整通过界面 → Rust → stdio 子进程；夹具配置只写临时 agent/mcp.json。debug 程序 SHA-256：`18a472154e6798485ddc6390a9df2a3c2285c501988541c10cbb082da9489825`。已查看本轮浏览器及原生资源/提示词截图。
- 环境排障：Playwright 下载最初继承失效代理 `127.0.0.1:7892`，仅在下载进程清空代理后成功；原生验收首次在构建阶段因临时脚本残留空 CI 变量失败，移除该环境变量后完整重跑通过。未修改用户代理配置。
- CI 工作流已新增 Chromium、侧栏/MCP 浏览器、fixture Rust、loopback NO_PROXY 及浏览器产物上传；本轮仅在本机执行这些命令，**未运行远端 GitHub Actions**。
- 证据：`artifacts/mcp-content-full-{build,js,rust,rust-fixture,fmt,clippy,ui}.log`、`mcp-content-sidebar-retry.log`、`mcp-content-browser-final.log`；回执 `sidebar/result.json`、`mcp-content/result.json`、`mcp-content-ui-result.json`；截图 `mcp-resource.png`、`mcp-prompt.png` 及 `mcp-content/`。首次失败日志保留。
- 验证边界：HTTP 使用本机 loopback 服务；未实测第三方远端 TLS/代理/OAuth，未将 MCP Apps 演示 catalog/result 接成真实第三方 WebView。资源/提示词暂不支持订阅与 completion，二进制只展示说明，不自动下载或执行内容。

## 0.7.1 Windows CI 路径别名修复与正式交付（2026-11-11）

- [PR #2](https://github.com/SmalJcat/PI-SmalJcat/pull/2) 的首次 Windows CI 在受保护配置写入检查中失败。使用 Windows 8.3 短路径作为本机 `TEMP` / `TMP`，复现了相同的 `Some(true)` / `None` 断言差异。
- 提交 `fe50b327abd72e0c5ec1e389339217834fcbfc19` 将权限路径边界比较放到现存祖先 canonicalize、缺失尾段补齐和 `..` 归一化之后，按实际目标识别短路径与 junction。新增回归验证指向受保护目录的别名下，现存文件和新建路径的 `write` / `edit` 均需批准。旧逻辑下新增回归失败，修复后普通路径及 8.3 环境均通过。
- 修复后 JavaScript 116 项、常规 Rust 164 项、test-fixture Rust 166 项、格式检查和全目标严格 Clippy 通过，两种 Rust 模式各有 4 项本机检查默认忽略。11:35 HKT，WebView2 + Pi/ACP fixture 64 项通过，渲染错误 0、模型请求 0。本轮 Rust 检查沿用测试进程的 loopback `NO_PROXY`。
- 11:38 HKT 从干净提交 `fe50b327abd72e0c5ec1e389339217834fcbfc19` 重新构建正式包，17,843,712 字节，SHA-256 为 `3c12f5a142667bb6ba4244746cbfe3c7492528ceb6c75a9e11549ef6ce8ab0a3`。139 个文件的源码指纹为 `f01914d171b1f696cf5fae92422b33ece0b9bda4cfd98b5aed9b7bf36a341a22`。
- 11:38 HKT，`npm run test:release` 5 项通过；11:39 HKT，补跑官方 Antigravity CLI 后 6 项通过。两份回执与新包哈希一致，渲染错误 0、模型请求 0，正常关闭及所属进程退出检查通过。
- 11:40 HKT，通过既有部署工具更新 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4`，原安装保留为 `fdea6c4.backup-2026-11-11T03-40-45-316Z-e45642be`。暂存程序、安装副本、清单、验收回执及源码指纹已核对一致，已从原入口重新打开安装版。
- 证据保存在 `artifacts/ci-permissions-alias-before.log`、`ci-permissions-alias-after.log`、`ci-permissions-junction-before.log`、`ci-permissions-after.log`；完整检查汇总为 `ci-closeout-20261111-checks.json`，UI 回执为 `ci-closeout-20261111-ui-result.json`，正式包回执为 `ci-closeout-20261111-release-result.json`、`ci-closeout-20261111-release-acp-result.json`。构建、验收、部署日志统一使用 `ci-closeout-20261111-*.log`，完整性回执为 `ci-closeout-20261111-integrity.json`。已查看本轮权限及官方 ACP 截图。

## 0.7.1 正式包独立验收与集成检查（2026-11-11）

- 当前代理由独立 Codex 进程承载。先正常关闭已安装的 Pi Desktop，并核对其正常退出标记及进程结束，再从 PowerShell 7 执行正式包验收。
- 10:57 HKT，`npm run test:release` 的 5 项检查通过。10:58 HKT，`npm run test:release -- -Antigravity` 的 6 项检查通过，渲染错误 0、模型请求 0。真实 Pi 返回 10 个模型、32 项命令，4 个 MCP 服务均连接；官方 ACP 1.5.3 的模型读取、配置切换、断开及所属进程退出检查通过。窗口正常退出，退出标记已落盘。
- 验收程序为 `release/tauri/Pi Desktop.exe`，17,845,248 字节，SHA-256 为 `c3bab6aafdca0a7eafc977ed4a6f6db6ed982e894745101a63049ced02c9cf85`，与安装目录 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4` 的程序和两份清单一致。构建来自干净提交 `6f57c22d7b193cf2801513c0586dbcb0b041ebf1`，139 个文件的源码指纹 `040db1027704595078f4a97dc7ca7d631b384200e096ce7a79f721da4ce737e4` 与当前源码重新计算的结果一致。
- 集成前重新运行 `npm ci`、前端生产构建、JavaScript 116 项、常规 Rust 163 项、`test-fixture` Rust 165 项、格式检查及全目标严格 Clippy，均通过。两种 Rust 模式各有 4 项本机集成检查默认忽略。11:11 HKT，`npm run test:ui` 完成 64 项真实 WebView2 + Pi/ACP fixture 检查，渲染错误 0、模型请求 0。
- 首次 Rust 检查的 8 项 loopback HTTP 测试因继承的 HTTP 代理及缺失的 `NO_PROXY` 返回 502。在本轮测试进程设置 `NO_PROXY=127.0.0.1,localhost,::1` 后，HTTP 专项和两种 Rust 全量均通过。首次失败日志及复跑日志一并保留。
- 11:12 HKT，已从原安装入口重新打开 Pi Desktop，并核对运行路径、窗口及程序哈希。发布清单、两个程序副本、三份正式包回执及源码指纹的完整核对记录为 `artifacts/closeout-20261111-integrity.json`。
- 正式包回执为 `artifacts/release-closeout-20261111-result.json`、`release-closeout-20261111-acp-result.json` 及 `tauri-release-result.json`，日志为 `release-closeout-20261111.log`、`release-closeout-20261111-acp.log`。集成检查汇总为 `artifacts/closeout-20261111-checks.json`，对应日志为 `closeout-20261111-*.log`，UI 回执为 `tauri-ui-result.json`。已查看 `closeout-20261111-pi.png`、`closeout-20261111-antigravity.png` 及本轮 fixture 截图，产物保存在被忽略的 `artifacts/`。

## 0.7.1 MCP HTTP 会话与通知（2026-11-10）

- 新增会话标识复用、初始化通知、POST JSON/SSE 按 ID 匹配、GET 通知流与断线重连；工具列表变更/断流/恢复使缓存失效。过期 404 不重放失败工具，下一次显式操作可重新连接；连接与断开串行，避免旧握手在断开后插回会话。
- curl 的 URL、头和正文改走 stdin，禁用 curlrc、URL globbing 和自动重定向；超时、断开和 Drop 关闭相应进程。增加头/行/事件/JSON 上限与错误处理。未接入 resources/prompts 或更改用户 MCP 配置。
- Rust 全量 `--no-default-features --features test-fixture` 165 项通过、4 项本机集成检查默认忽略；格式与全目标严格 Clippy 通过。新增 3 项解析单测和 8 项真实 loopback HTTP/curl 集成：会话头、初始化顺序、JSON/多行 SSE/UTF-8、通知缓存、Last-Event-ID 重连、无重放间隙变更、无状态/405、404 不重试、超时/断开/析构清理、错误正文/超限、字面 URL/转义凭据、并发连接与断开。
- JavaScript 116 项、前端生产构建、原生 Tauri/WebView2 + fixture 64 项通过，渲染错误 0、模型请求 0。原生回执完成于 22:36 HKT，debug 程序 SHA-256 为 `91019a10fb9e9de5bc09c99a5d5fab7168fac1c1a7d5bbcdd188c370d30eadeb`。
- 证据：`artifacts/mcp-http-rust.log`/`.stderr.log`、`mcp-http-js.log`、`mcp-http-ui.log`/`.stderr.log` 与 `tauri-ui-result.json`。HTTP 测试只启动临时 loopback 服务，不连接真实远程 MCP 或读取用户认证配置；远程 TLS/代理与服务器差异未作实测。
- 22:40 HKT 正式包从干净提交 `6f57c22d7b193cf2801513c0586dbcb0b041ebf1` 构建并部署至 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4`。程序 17,845,248 字节，SHA-256 为 `c3bab6aafdca0a7eafc977ed4a6f6db6ed982e894745101a63049ced02c9cf85`；139 个范围内文件的源码指纹为 `040db1027704595078f4a97dc7ca7d631b384200e096ce7a79f721da4ce737e4`。安装与暂存程序/清单逐项一致，回执 `mcp-http-release-integrity.json`，构建/部署日志 `mcp-http-package.log`/`.stderr.log`、`mcp-http-deploy.log`。
- 旧安装保留为 `fdea6c4.backup-2026-11-10T14-40-18-013Z-a2a9f4eb`；当前生产 PID 2664 保留，完全退出重开后加载新程序。正式包独立重启验收未运行，未把 fixture 验收当作生产重启验证；未生成新安装器。

## 0.7.1 精简上下文与底部统计（2026-11-10）

- 上下文卡片缩为百分比、用量/容量、进度条及压缩状态/设置；删除剩余统计、阈值和费用折叠区。费用移至输入框底部，同时显示 Pi 最近完整回复的平均输出速度；ACP 无可靠速度数据时显示 `—`。详情与测量口径见 `docs/DEVELOPMENT.md`。
- 前端生产构建、JavaScript 116 项通过。原生 Tauri / WebView2 + fixture 64 项通过，渲染错误 0、模型请求 0；新增悬停移入保持、紧凑高度、速度/费用接线、ACP 原币种费用和 1440/1024px 底部无溢出检查。首次回归因并行探子新进程触发会话保护中断，停止并行探查后完整复跑通过。未修改 Rust，本轮未重跑 Rust 全量。
- 已查看 `artifacts/compact-pi-context.png`、`composer-metrics-1440.png`、`composer-metrics-1024.png`；日志 `compact-build.log`、`compact-js.log`、`compact-ui-retry.log`/`.stderr.log`，回执 `tauri-ui-result.json`，完成于 20:14 HKT。
- 正式包来自干净提交 `ca042e210273be072adadad778ee18de8f035c9d`；137 个范围内文件的源码指纹为 `7bb952b7a46d281b317bb916613c7f5d87024da2f0b3af546d89ce8cc40ab178`。程序 17,751,552 字节，SHA-256 为 `92d0d721a2a57c74ff0cfabf8e8f708e1c1c2072def0786869788949a83a8d07`。
- 20:23 HKT 通过现有备份部署工具更新 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4`，旧版保留为 `fdea6c4.backup-2026-11-10T12-23-40-111Z-33e92f48`。安装程序大小/哈希与清单、仓库暂存包完整一致；证据 `artifacts/compact-deploy.log`、`compact-release-integrity.json`。当前生产进程 PID 7852 保留，完全退出后从原快捷方式重开才加载新界面。
- 正式程序独立重启验收尚未运行，原因是当前宿主承载主代理对话且生产程序单实例；没有结束宿主或把 debug fixture 结果当作生产重启验证。未生成新的安装器。

## 0.7.1 项目侧栏与编辑收尾（2026-11-10）

- 项目菜单、分区、会话归档/恢复及同会话编辑纳入本轮源码；修复触屏项目按钮被样式隐藏、仅保留图片的编辑发送失败，以及中文系统重复删除启动项误报。
- `npm run build`、JavaScript 113 项、侧栏专项 18 类检查通过；触屏检查使用 `hasTouch` 并确认 `(hover: none)` 下按钮在未聚焦时可见、点击可打开菜单。
- Rust `--no-default-features --features test-fixture` 全量 154 项通过、4 项显式集成检查默认忽略；`cargo fmt --check` 与全目标严格 Clippy 通过。原启动项失败已修复，既有注册/查询/重复删除回归及新增不存在路径/非法路径检查通过，没有跳过失败项。
- 真实安装 Pi 的 `installed_pi_edit_contract_preserves_session_and_excludes_selected_message` 单独执行通过：同会话 ID/文件、旧分支保留、首条消息编辑、准备后断线重连与幂等重试。使用临时配置和会话，模型请求 0。
- 18:50 HKT 真实 Tauri / WebView2 + 隔离 Pi/ACP fixture 完成 63 项检查，渲染错误 0、模型请求 0。新增仅图片编辑检查同时断言图片、会话 ID/文件、侧栏数量、普通草稿和旧历史均保留。回执 debug 程序 SHA-256：`5ef06219119226654e1e3feeb9e3530a86b94e900d226c287255ceddb667d15e`。
- 已查看 `artifacts/sidebar/project-menu.png` 与 `artifacts/v071-message-actions.png`。日志为 `artifacts/closeout-web.log`、`closeout-rust.log`/`.stderr.log`、`closeout-ui.log`/`.stderr.log`、`closeout-real-edit.log`；回执为 `artifacts/sidebar/result.json` 和 `artifacts/tauri-ui-result.json`。浏览器剪贴板为 mock，资源管理器实际开窗未自动验证。
- 18:58 HKT 正式包构建成功，来自干净提交 `0f1b9d806709b49cf4058404c797e8978c71f04e`；135 个范围内文件的源码指纹为 `0c6b6ce848a045aba0fb08ba12fe2b8b2285f386f28501f5cd2524856148ce4c`。程序 `release/tauri/Pi Desktop.exe` 为 17,751,040 字节，SHA-256 为 `f6511d169d8fb7acfa70f64ef724cb951eec3652f36ec8506ff64eb362f15ca2`。构建后用 `readRelease` 校验大小和实际文件哈希，并与 `sourceIdentity` 完整匹配，`dirty: false`。证据：`artifacts/closeout-package.log`/`.stderr.log`、`artifacts/closeout-release-integrity.json`。
- 安装目录 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4` 已核验仍为此前 0.7.1 构建，实际 SHA-256 为 `e40ca1cb68ffd94b9ed6706d29f2c652f17b80ceb4b4904034a9752b33d4facc`；桌面和 `D:\PI\Pi Desktop.lnk` 均指向它。本轮新包尚未部署，未修改快捷方式或终止生产进程。
- 生产独立启动验收尚未执行：本轮进程核查确认当前主代理 Pi 由已安装 Pi Desktop 承载。生产构建始终单实例，关闭现有桌面会终止当前对话；必须在桌面外部终端、完全退出旧实例后运行 `npm run test:release`。不能用上述 debug fixture 结果替代正式包验收。

后续在独立 PowerShell 7 中完全退出 Pi Desktop 后执行；正式验收通过才部署，失败时保留现有安装：

```powershell
Set-Location 'D:\PI-SmalJcat\desktop'
npm run test:release
if ($LASTEXITCODE -eq 0) {
    npm run deploy -- --to "$env:LOCALAPPDATA\Programs\Pi Desktop\fdea6c4"
}
```

正式验收回执 `artifacts/tauri-release-result.json` 的 `success`、`mode`、执行时间及 `executableSha256` 应对应上面的本轮包。该命令验收仓库暂存 exe，部署后的安装路径启动仍需从快捷方式检查。

## 0.7.1 消息复制与编辑（2026-11-09）

- JavaScript 113 项通过，Rust `test-fixture` 153 项通过、4 项显式集成检查默认忽略。`cargo fmt --check` 与全目标严格 Clippy 通过。
- 真实安装的 Pi 1.5.0 分叉契约单独通过。选中消息及后续回复从新分支上下文移除，原会话保留，桌面会话锁转移后可继续写入，模型请求 0。
- WebView2 62 项检查通过，渲染错误 0。新增用户与助手复制、剪贴板拒绝反馈、编辑取消、图片保留、原历史保留、独立草稿/附件保留、发送失败重试复用分支、断线后的保护流程与编辑恢复，以及 ACP 编辑为新消息。
- 剪贴板写入检查使用浏览器 mock。Pi / ACP 发送检查使用隔离夹具，模型请求 0。
- 本轮证据保存在 `artifacts/v071-js.log`、`v071-rust.log`、`v071-clippy.log`、`v071-real-fork.log`、`v071-ui.log` 和 `tauri-ui-result.json`，界面截图为 `v071-message-actions.png`。
- 正式包来自干净提交 `07eeb7546ff8417bd5b2e9223a8cede79ce38011`，132 个范围内文件的源码指纹为 `a6ff5f496b2fb42b9ff4e744875529a3c74ec0dc5548d3b912e2e4fd590a888c`。程序 17,725,952 字节，产品版本 0.7.1，SHA-256 为 `8d280bd6ae598508cc9cf0834152b9d6f8e1878b99ec7c65f0059bfa7a444ecd`。
- 正式程序完成 6 项真实 Pi / 官方 ACP 检查，模型请求 0。验收程序哈希与交付程序一致，证据为 `artifacts/v071-release-ui.log` 和 `tauri-release-result.json`。
- 17:08 HKT 已部署至 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4` 与 `D:\PI\desktop\release\tauri`，版本与哈希相同。桌面快捷方式指向已更新的安装目录。原发布分别保留在 `fdea6c4.backup-2026-11-09T09-08-06-524Z-d2a0134c` 和 `tauri.backup-2026-11-09T09-08-06-960Z-81de43a9`。

## 0.7.0 全界面自动截图审计与 UI 细节收口（2026-11-09）

- 新增真实 WebView2 全界面自动截图与 DOM 审计工具（`npm run ui:capture` / `tests/capture-all-ui.mjs`），在隔离 fixture 环境下自动遍历主聊天、会话操作菜单、底部权限菜单、自定义权限规则弹窗、推理档位与模型选择浮层、上下文信息卡、运行中授权确认弹窗、工作区审阅、子代理（空状态/新建/多任务/归档）、工作区命令、设置 11 个页签、上下文压缩参数弹窗、命令面板、快捷键帮助以及 Antigravity 视图（未连接/已连接/权限菜单/授权弹窗/模型浮层/上下文卡片）共 **36 个界面状态 × 2 种分辨率（1440×900、1024×768）= 72 张截图**，并自动审计渲染错误、文字对比度、控件重叠、横向溢出与空标签。
- 根据首轮全界面截图与 DOM 审计报告，完成 10 项界面交互与视觉修复（提交 `3d7cd23`）：
  1. 修复 ChatGPT 暗色主题下 `.pi-mark` 徽标（顶部栏、欢迎页、设置导航）文字对比度过低问题（`#0d0d0d` 深字配 `#ededed` 亮底，对比度 `>16:1`，并收紧 `.settings-nav-head > div > span` 选择器避免覆盖）。
  2. 修复 `#303030` 弹窗与浮层内 `.secondary-button`（关闭/刷新/取消等按钮）背景与容器同色导致边界不可见的问题，补齐 `var(--surface-elevated-secondary)` 边框与微亮底色，同时统一弹窗内分割线、输入框、下拉框边框色。
  3. 修复推理浮层标题与档位文字（`--composer-blue`）在暗色背景下的 WCAG AA 对比度（提亮至 `#6ea8fe`，亮色主题保持 `#2563eb`），新增滑条下方档位刻度（`关闭 / 低 / 中 / 高` 或固定关闭提示）及当前模型高亮。
  4. 修复底部上下文信息卡与上下文管理弹窗中 `<progress>` 轨道背景与 `#303030` 卡片同色导致进度槽不可见的问题。
  5. 修复「设置 -> 索引」与「设置 -> MCP」搜索框（`.extensions-filter`）未脱离 `.extensions-card` 作用域导致宽度过窄、placeholder 被截断的问题。
  6. 为顶部「会话操作」（`...`）下拉菜单补充点击外部与 `Escape` 键自动关闭逻辑。
  7. 将「回到最新」（`.jump-bottom`）改为不透明悬浮胶囊按钮，避免与底部消息正文透叠。
  8. 对齐子代理新建表单角色行底部基线（`align-items: flex-end`），将只读提示改为胶囊标签，并在表单展开期间禁用右上角重复的「新任务」按钮。
  9. 将 MCP 顶部「Pi 会话 / 桌面工具调试」切换改造为分段式 Tab 控件，并将「`— 个工具`」文案改为语义明确的「`工具待读取`」，汉化 `direct / deferred / local` 暴露方式标签。
- 验证结果：
  - JavaScript 单元测试 **112 项全部通过**（`npm test`）。
  - 全界面自动截图与 DOM 审计（`npm run ui:capture`）：**36 个界面 / 72 张截图全部通过**，渲染错误 **0**，`high` 级别问题 **0**，`medium` 级别问题 **0**（报告：`artifacts/ui-capture/20261109-141612/REPORT.md`）。
  - WebView2 端到端验收（`tests/run-tauri-ui-medium.ps1`）：**58 项检查全部通过**，渲染错误 **0**，模型请求 **0**。
- 正式程序交付（14:25 HKT）：
  - 来自干净提交 `3d7cd235169a9b06bfb4e44c0fe20c044eef9f4b`；128 个范围内文件的源码指纹 `6b02f16102667e0c6870f5c9d701b8a02304b451720fd50efcdbc06cf74409be`。
  - 程序 `17,679,872` 字节，SHA-256：`50042443d9cd80971d0e2d6e62fccf72ad53803386dbb4d58446e8a0529d8fbc`。
  - 已同步至 `D:\PI\desktop\release\tauri` 与 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4`（采用同盘平滑迁移运行中旧二进制的方式完成热替换，不中断已打开的桌面窗口；下次重开即加载新版）。备份目录分别为 `tauri.backup-2026-11-09T06-24-33-574Z-9cd57cce` 与 `fdea6c4.backup-2026-11-09T06-25-10-719Z-live`。

## 0.7.0 权限与上下文（2026-11-08）

- Pi 主会话和受管理子代理接入执行前授权门，由原生内存策略判断；四档菜单、自定义规则保存、来源/工作区提示、拒绝与单独停止均接到执行链。授权在串行写入点再次校验 owner 票据，停止后排队中的旧响应不放行；已提交写入的授权不能撤回。完全访问是显式跳过桌面确认，仍不扩大子代理工具白名单，权限不是 OS 沙箱。
- ACP 接入 `usage_update.used/size`、可选会话费用和四档请求处理；自动放行只选 `allow_once`。未报告保持未知，模型切换清空旧值，缓存恢复标上次统计；Pi 使用当前窗口估算，不使用累计 tokens。详情与边界见 [权限与上下文](docs/PERMISSIONS-CONTEXT.md)。
- JavaScript 106 项、常规 Rust 150 项通过（3 项本机服务测试默认跳过），test-fixture 权限集成目标另运行 3 项通过（其中 2 项与常规目标重合）；TypeScript/Vite、严格全目标 Clippy、格式检查通过。覆盖规则/路径/链接、宿主配置保护、真正拒绝不落盘、请求关联、写入锁后的取消复查、用量类型/模型清空/无效数据及当前统计优先级。
- 17:43 HKT 最终 debug 程序完成 60 项真实 WebView2 + fixture 验收，渲染错误 0、模型请求 0。新检查覆盖四模式真实文件写入门、回复失败原位重试、停止旧请求、子代理来源/独立停止、叠加弹窗键盘归属、权限保存焦点、ACP 44%/364k/828k、未知不伪装零以及上下文入口不串后端。已查看 `artifacts/v070-pi-permissions.png`、`v070-acp-context.png`；回执为 `tauri-ui-result.json`。
- 真实 Pi 1.5.0 的显式 gate 加载和原生策略查询验证通过，确认 `--no-extensions` 下显式 `-e` 仍加载门扩展，查询随原生模式改变，未发送模型请求。另运行隔离 Pi 上下文设置/重载/项目覆盖检查，保持全局与无关配置。记录：`v070-pi-gate-contract.log`、`v070-real-pi.log`。
- 日志：`v070-js.log`、`v070-rust.log`、`v070-permission-native.log`、`v070-clippy.log`、`v070-debug-build.log`、`v070-ui.log`。独立审阅指出的焦点和回复失败问题已修复并加回归；真实 CLI 元数据验证脚本的新查询通道接线曾漏接，已停止隔离测试进程、修正并重跑通过。本轮模型调用 0。

正式程序交付（17:50 HKT）：

- 来自干净提交 `66d29d913e1db85e24c1fca5d6b3a86a032e57aa`；128 个范围内文件的源码指纹 `7180980220800094a9428687955e97e323286a2810aca8117906c088cdab06e1`。程序 17,679,360 字节，SHA-256：`37e800442d951e8fe110cd914d97b79a98b40b2cd7fe29d76bec56aa2d978feb`。
- 17:49 HKT 正式版完成 6 项真实 Pi / 官方 ACP 检查，渲染错误 0、模型调用 0，实际 Pi 模型 8 个、命令 32 项。权限菜单真实切换并保留会话/草稿，CLI 停止后所属进程退出；已查看 `artifacts/v070-official-desktop.png`。
- 已同步 Windows 桌面实际安装目录 `%LOCALAPPDATA%\Programs\Pi Desktop\fdea6c4` 与 `D:\PI\desktop\release\tauri`；两处版本 0.7.0、程序/清单/正式验收 SHA-256 一致，快捷方式目标已核对。原 0.6.3 备份为 `fdea6c4.backup-2026-11-08T09-50-45-810Z-153b686d` 与 `tauri.backup-2026-11-08T09-50-46-261Z-26ef746d`。
- 记录：`v070-package.log`、`v070-release.log`、`v070-deploy-installed.log`、`v070-deploy-runtime.log`、`tauri-release-result.json`。交付时未发现运行中的旧 Pi 窗口，没有中断用户任务；未生成新 NSIS 或进行 Authenticode 签名。凭据、实际用户配置、会话与构建产物不提交 Git。

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
