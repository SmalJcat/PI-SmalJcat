# Pi Desktop

参考 Codex 桌面端的工作区 / 会话 / 对话布局，为 Pi 1.5.0 构建的 Windows 桌面客户端。Electron + React + TypeScript，通过 JSONL RPC 启动现有 `pi.exe`。这是独立客户端初版，不是 OpenAI 或 Pi 官方客户端。

## 启动

双击桌面上的 **Pi Desktop** 快捷方式，或 `D:\PI\Pi Desktop.lnk`；也可直接打开：

```text
D:\PI\desktop\release\win-unpacked\Pi Desktop.exe
```

`win-unpacked` 是完整应用目录，请保留其中的 DLL、resources 等文件。运行打包版无需 Node.js，但需要本机 Pi 安装。程序会从上级目录查找 `pi.exe`；找不到时，在左下角「设置与连接」选择它并重新连接。

已在本机 Windows 上验证 Pi 1.5.0 和 Electron 45.2.3。应用沿用 `~/.pi/agent`（或 `PI_CODING_AGENT_DIR`）中的 Pi 模型、凭据、MCP、扩展、技能及会话配置。客户端不另存 API 密钥。

## 可用功能

- 新建、搜索、恢复、重命名会话；当前工作区与全部会话筛选。
- 选择工作文件夹，保留最近使用的工作区。
- Markdown 回复、流式文本、折叠思考内容、可展开的工具参数与输出。
- 模型选择和模型支持的思考强度；输入 `/` 搜索 Pi 扩展命令、技能与模板。
- 运行中发送补充指令或排队后续任务；停止时先清队列，再中止运行，将取回的文本放回输入框。
- 文件选择、拖放文本或图片、粘贴截图；每次最多 8 个附件，总大小 20 MB，单个文本最多 256 KB。图片模型会收到实际图片内容。
- 工作区文件树、只读文本预览、文件路径引用；Git 已暂存 / 未暂存差异与未跟踪文件预览。
- 扩展 `confirm`、`select`、`input`、`editor` 弹窗与通知、状态、文本小组件。
- 会话 HTML 导出、手动压缩上下文、按会话保存的文本草稿。
- 主窗口最小化、最大化、关闭；启动失败诊断与重新连接。

快捷键：`Enter` 发送，`Shift+Enter` 换行，`Esc` 停止运行，`Ctrl+N` 新会话，`Ctrl+O` 选择工作区，`Ctrl+,` 打开设置。中文输入法组词阶段的 Enter 不发送消息。

## 数据和执行行为

Pi 的会话仍写入其原有目录，默认是 `~/.pi/agent/sessions`。自定义 `sessionDir` 和 `PI_CODING_AGENT_SESSION_DIR` 会被索引器读取。侧栏索引展示最近 300 个会话；原始历史由 Pi 按当前分支恢复，界面初始显示最近 100 条可见消息，可加载更早消息。

桌面偏好存放在 Electron 的 userData 目录，Windows 默认 `%APPDATA%\pi-desktop\preferences.json`；文本草稿保存在该目录下的浏览器本地存储。附件不作为草稿跨会话保存。

工作区默认遵循 Pi 已保存的项目信任设置。RPC 无内置终端信任提示；如需本次加载项目配置，在设置中勾选相应选项再重新连接，它只给这次子进程添加 `--approve`。客户端不修改全局信任设置。

客户端没有新增执行沙箱或逐条工具审批，工具权限与当前 Pi 一致。界面采用隔离 preload、关闭 Node integration、限制 IPC 命令、禁用 HTML / 远程图片自动加载以及外部导航。文件预览检查真实路径，防止通过 `..` 或目录链接离开工作区；这只约束客户端预览，不约束 Pi 工具本身。

请避免在 CLI 与桌面客户端同时写入同一个会话；可以在各自独立的会话中工作。关闭有任务运行的窗口时，程序会询问是否停止，正常关闭先结束 stdin，超时后清理自己启动的 Pi 子进程树。

## 开发和验证

需要 Node.js 22.19+：

```powershell
Set-Location D:\PI\desktop
npm ci
npm run build
npm start
```

开发模式：`npm run dev`。打包：`npm run package`（输出 `release/win-unpacked`，复用本地安装的 Electron 分发文件）。若 Electron 运行时尚未安装，可运行 `node node_modules/electron/install.js`。网络限制时可以设置可信下载镜像；安装器校验包内 checksum。

验证命令：

```powershell
npm test
npm run test:ui
npm run test:pi
node tests/pi-model-smoke.mjs
node tests/packaged-smoke.mjs
```

- `npm test`：JSONL 分片/Unicode、消息重建、工具关联、历史分支、会话元数据、目录边界、附件限制、Git 子目录与差异、RPC 生命周期。
- `test:ui`：独立临时配置下的 Electron + Playwright 交互验证，使用确定性本地模拟 Pi，不调用模型。
- `test:pi`：连接真实 Pi，读取状态 / 模型 / 命令 / 会话等接口，不调用模型或保存会话。
- `pi-model-smoke.mjs`：显式调用一次真实模型，关闭工具 / 扩展 / 技能 / 项目上下文，不保存会话；会产生一次模型调用用量。
- `packaged-smoke.mjs`：打开真实打包程序并核验 Pi 连接、模型与文件面板；不发送模型请求。

`artifacts` 保存验证截图与本地诊断，不包含在打包程序中。

源码入口：`electron/main.mjs`（窗口与 IPC）、`electron/rpc.mjs`（Pi 子进程）、`electron/workspace.mjs`（本地数据）、`src/App.tsx`（界面）、`src/transcript.mjs`（消息状态）。

## 初版限制

当前一次运行一个会话；正在运行时需先停止再切换。文件面板为只读，不提供完整编辑器、交互式终端、Git 提交或合并操作。文件树需手动刷新，任务结束后会自动刷新顶层。

登录 / OAuth、`/tree` 等终端专属功能仍需 Pi CLI；自定义 TUI 组件无法通过 RPC 复用。图形界面不是所有 Pi 扩展的完整替代。

当前提供本机未签名的 Windows 目录版，没有安装器、自动更新或跨平台打包。Pi 本体和用户凭据不包含在应用包内。客户端与现有 `D:\PI` 安装分开，不修改原来的 Pi 文件。
