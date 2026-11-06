# 验证记录

本机环境：Windows x64、Node.js 24.14.1、Pi 1.5.0、Electron 45.2.3。验证日期：2026-11-06。

- `npm run build`：TypeScript 检查、Vite 生产构建通过。
- `npm test`：10 项全部通过，覆盖 JSONL Unicode / 分片、流式权威消息、并行工具关联、历史分支、会话索引、路径穿越 / junction、附件限制、Git 仓库与子目录差异、RPC 响应关联 / 超时 / 退出。
- `npm run test:ui`：9 组真实 Electron 交互验收通过，模拟 Pi，渲染进程异常为 0。覆盖文件预览、引用、中文组词输入、流式消息、工具展开、安全 Markdown、模型 / 思考强度、扩展确认、补充指令 / 停止 / 队列恢复、重命名 / 新建 / 恢复历史 / 草稿、图片粘贴、设置、紧凑布局。
- `npm run test:pi`：真实 Pi RPC 通过，发现 44 个模型、30 个命令和 7 个已有会话；不发送模型请求，不保存会话。
- `node tests/pi-model-smoke.mjs`：真实默认模型 `openai/gpt-6.1-sol` 返回 `PI_DESKTOP_OK`，收到 4 次文本 delta；工具 / 扩展 / 项目上下文已关闭，没有保存会话。
- `npm run package`：生成 `release/win-unpacked/Pi Desktop.exe`。
- `node tests/packaged-smoke.mjs`：真实打包版连接 Pi、发现 44 模型 / 30 命令、正确工作区和文件面板、渲染错误 0。
- Vite 开发窗口：通过 `createServer` 与 Electron 启动验证，成功连接模拟 Pi。开发服务器仅监听 `127.0.0.1:5178`。
- 窗口截图已查看：`artifacts/desktop-real.png`、`desktop-home-test.png`、`desktop-chat-test.png`；另保存设置与紧凑布局截图。
- 验证进程已退出；交付时通过 `D:\PI\Pi Desktop.lnk` 启动正式窗口，并确认 `Pi Desktop` 窗口存在。

Electron 官方下载较慢，改用镜像下载；下载文件的 SHA-256 与 electron npm 包自带的 checksums.json 一致。

未覆盖所有第三方扩展、自定义 TUI、OAuth 登录、其他操作系统。当前功能范围和限制见 README.md。
