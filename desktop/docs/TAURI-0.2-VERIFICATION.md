# Rust + Tauri 迁移验证

版本：Pi Desktop 0.2.0。日期：2026-11-06。

环境：Windows x64、Rust 1.98.1 MSVC、Node.js 24.14.1、Pi 1.5.0、Tauri Rust 2.12.5 / CLI 2.12.4、系统 WebView2 156.0.4314.58。

## 已完成检查

- TypeScript 类型检查和 Vite 生产构建通过。
- `cargo check --all-targets --features test-fixture` 通过。
- `cargo clippy --all-targets --features test-fixture -- -D warnings` 通过。
- `cargo fmt` 已应用。
- 11 项 Rust 测试全部通过：5 项核心单元测试，6 项集成测试。覆盖 JSONL UTF-8 / Unicode 分隔字符、无效协议、会话分支和压缩前历史、元数据与文件限制、路径穿越与 Windows junction、RPC 乱序响应 / 超时 / 失败 / 停止、进程异常退出、Windows 子进程树清理、阻塞输入管道时的退出、Git 已暂存 / 未暂存 / 子目录 / 中文路径。
- 原有 10 项 JavaScript 回归测试通过。
- 9 组真实 Tauri + WebView2 交互验收通过，渲染进程异常 0：连接、文件预览和引用、中文输入、消息流与工具详情、安全 Markdown、模型与思考强度、扩展确认、停止和取回队列、会话重命名 / 新建 / 恢复 / 草稿、图片粘贴 / 文本附件读取、设置与诊断。后端拒绝未允许的 bash 命令。
- Tauri + Vite 开发模式启动并连接模拟 Pi，通过正常窗口关闭退出。
- Rust RPC 验证连接真实 Pi，读取到 44 个模型、30 个命令；不保存会话，不调用模型。
- Rust 真实模型验证返回 `PI_TAURI_OK`，收到 5 次文本 delta。此验证关闭工具 / 扩展 / 技能 / 项目上下文，未保存会话。
- 最终 release 程序通过 WebView2 真实启动验收：识别 Rust/Tauri 运行时与 0.2.0 版本、44 模型、30 命令、正确工作区、无 Node integration，正常关闭。
- 已查看 Tauri 窗口截图，保留原有三栏界面。截图位于 `artifacts/tauri-home-test.png`、`tauri-chat-test.png`、`tauri-settings-test.png`、`tauri-real.png`。

## 发布物

程序：`release/tauri/Pi Desktop.exe`。前端资源内嵌，无 Electron / Node.js 运行依赖；需要已有 Pi 安装和系统 WebView2。

SHA-256：

```text
02DD673F7E98622D65D8DE1BD96183DE5AB4AF977D9293D948781CCC1DEA097A
```

本机磁盘文件大小：Tauri 发布目录 10,041,443 字节（9.58 MiB），Electron 发布目录 406,844,845 字节（388.00 MiB），减少 97.53%。统计包含各自发布目录的全部文件；不包含共享 Pi、WebView2 Runtime、用户数据，也不代表内存占用或模型响应速度的变化。原始数值见 `artifacts/package-sizes.json`。

桌面和 `D:\PI` 下的 `Pi Desktop.lnk` 已更新为 Tauri 程序。旧入口复制为 `Pi Desktop (Electron).lnk`，旧程序保留于 `release/win-unpacked`。

## 验证边界

自动化通过临时配置与模拟 Pi 完成大部分交互，不写入用户现有会话。真实 RPC / 模型验证使用无持久化会话。

操作系统鼠标拖放手势、所有第三方扩展、自定义 TUI、OAuth 登录、其他 Windows 环境和 macOS / Linux 未做完整验收。原生拖放事件已接入，自动化验证其依赖的附件读取和图片粘贴。

本次没有严格测量冷启动时间、空闲内存或大规模长会话性能，因此不据此宣称这些指标改善。当前未签名，没有安装器或自动更新。
