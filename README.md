# PI-SmalJcat · Pi Desktop

基于 Pi 1.5.0 的 Windows 桌面客户端，当前版本 **0.4.1**。React / TypeScript 提供界面，Rust + Tauri 2 管理 Pi RPC、进程和本地工作区。

主要功能包括流式对话、会话保护与恢复、MCP 状态、文件引用与 Git 差异审阅、自动压缩管理，以及具有独立会话的只读子代理工作台。

## 开始开发

需要 Windows x64、Node.js 22.19+（建议 24）、Rust / MSVC、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。Rust 版本由 `desktop/rust-toolchain.toml` 固定。

```powershell
git clone git@github.com:SmalJcat/PI-SmalJcat.git
Set-Location PI-SmalJcat/desktop
npm ci
$env:PI_DESKTOP_EXECUTABLE = 'C:\path\to\pi.exe'
npm run dev
```

Pi 运行程序需要单独安装；本仓库不分发 Pi 运行包、用户凭据、会话、依赖目录或本机构建产物。生产桌面程序使用系统 WebView2，不依赖独立 Node.js 运行时。

## 目录与检查

- `desktop/src/`：React 界面、消息与工作流。
- `desktop/src-tauri/`：Rust 后端、Tauri 配置和集成测试。
- `desktop/extensions/`：运行于 Pi 内部的桌面桥接扩展。
- `desktop/tests/`：确定性 Pi 协议夹具和真实 WebView2 验收。
- `desktop/electron/`：保留的历史实现与协议回归支持。

在 `desktop/` 中运行：

```powershell
npm run build
npm test
npm run test:rust
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
npm run test:ui
```

默认测试使用模拟 Pi，不需要模型凭据。真实 Pi / 模型检查需自行配置，具体见[桌面说明](desktop/README.md)。本地历史[验收记录](desktop/VERIFICATION.md)描述原开发机器，引用的 `artifacts/` 未提交；其他开发者以自己运行的检查和 CI 为准。

## 联合开发

从最新 `main` 创建功能分支，通过 Pull Request 合并。提交应说明改动行为、验证结果和相关限制；避免多人同时大范围修改 `App.tsx`、`core.rs` 和 RPC 桥接接口。详细约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

GitHub Actions 在 push / Pull Request 时执行 Windows 构建、JS / Rust 测试、格式与 Clippy 检查，不使用模型密钥。仓库管理员可进一步启用 `main` 分支保护并要求该检查通过。

Pi 上游：[earendil-works/pi](https://github.com/earendil-works/pi)。本仓库许可证见 [LICENSE](LICENSE)。
