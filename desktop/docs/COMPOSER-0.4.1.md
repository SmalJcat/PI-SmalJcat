# 0.4.1 输入候选菜单改进

在 `origin/main` 的 `2d205cfc68d164cc362da3f21844831a788a2e3f` 基础上继续开发，分支为 `fix/composer-keyboard-completions`。本次聚焦输入框，不改 Rust IPC、Pi 配置或任务执行权限。

## 使用行为

- 输入 `/` 显示命令、技能和模板候选，精确名称与前缀优先；上下键循环选择，Tab / Enter 补全。补全只编辑输入框，之后再发送；仅输入完整命令时 Enter 仍直接执行。
- 文件与命令候选都尊重文本光标和选区。补全光标所在的 token，并保留其后的参数 / 文字；带空格文件名自动加引号。
- Shift+Enter 始终换行，Shift+Tab 保持原焦点导航；中文组词的 Enter 不选择候选也不发送。
- Esc 优先关闭候选菜单。搜索等待、无结果和搜索失败时也适用，避免意外中止正在运行的任务。菜单关闭后再次按 Esc 才停止任务。
- 输入变化或工作区 / 会话改变后，旧查询结果不再可选，旧请求完成或报错不会覆盖当前菜单。查询等待时按 Enter / Tab 不会发送残缺引用。
- 菜单提供空结果、错误与结果截断提示，以及 listbox / option / 活跃候选的辅助功能属性。

## 实现范围

`src/ComposerCompletions.tsx` 管理菜单状态、异步检索和按键；`src/completions.mjs` 提供光标范围、排序、补全替换和按键规则。`App.tsx` 只负责引用入队和消息发送。后端接口与用户数据格式未变。

`tests/completions.test.mjs` 验证纯函数规则；`tests/composer-ui.mjs` 经现有 `tauri-smoke.mjs` 在真实 WebView2 中验证输入行为。慢查询在测试中只拦截文件搜索返回，其他 Pi 流式、停止和恢复仍经过真实 Rust 桥接与协议模拟进程。

## 检查

- TypeScript / Vite 生产构建通过；主 JS 分块约 539 kB，仍有既有的 500 kB 提示。
- 19 项 JavaScript 测试通过（新增 5 项输入规则测试）。
- 27 项 Rust 回归测试、Clippy `-D warnings` 和 fmt 检查通过。
- 29 项桌面验收通过（包含关闭后的 Pi 进程检查），渲染错误为 0；模型请求为 0。输入菜单新增四组交互覆盖，其余覆盖保留 0.4 的压缩、子代理、异常恢复和文件审阅流程。
- 发布版连接真实 Pi，读取 44 个模型、31 个命令和 4 个已连接的 MCP 服务器；真实有效压缩配置核验通过。此项不调用模型。

完整本机结果：`artifacts/tauri-ui-result.json`、`artifacts/tauri-release-result.json`；日志：`composer-final-ui*.log`、`composer-release-ui*.log`、`composer-rust-tests*.log`。这些产物不提交到仓库。实际发布程序版本与 SHA-256 以 `release/tauri/release.json` 为准。

## 本机同步

源码的 Git 工作区是 `D:\PI-SmalJcat`。`D:\PI\desktop` 是保留依赖、Pi 安装与桌面快捷方式的本机运行副本。同步前对所有覆盖文件保存 SHA-256 与备份，目录为 `D:\PI\desktop\artifacts\sync-backups\`；不删除用户配置、会话或已有产物。远端的 Windows Git 路径规范化修复也同步到运行副本。

本次不推送远端或合并 main；更改保留在功能分支，供本地审阅。旧发布程序保留为 `release/tauri-before-composer/`。
