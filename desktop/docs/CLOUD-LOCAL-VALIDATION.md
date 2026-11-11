# 0.4.1 云端整合与本地验收

## 来源与保留范围
- 基准：2d205cfc68d164cc362da3f21844831a788a2e3f。
- 输入：pi-local-snapshot-20261107.zip，SHA256 为 7476fb4977a8ca0a51a85eb758c33b932382a7f584d1462ea7064878c860b0b7。
- 先核验全部 19 个文件的字节数与 SHA256，再在独立 checkout 应用 12 个已跟踪改动和 7 个新增文件。
- 保留 0.4.1 输入补全、Git 修复及 medium-integrity PowerShell 启动器。原始快照中的 16 个文件保持逐字节一致，另外 3 个文件只整合本次测试修复。
- 仅选择性移植 11f34a0 的真实租约辅助程序与两处冲突测试，不合并 feature/scout-history 的其他功能。
- 旧云端 connection-preflight 工作区在本执行环境中不存在，因此本包不包含、也未验证该批未提交修改。没有改动其他 checkout，没有提交或推送。

## 本次修复
旧测试在没有第二个持有者的情况下期待“会话保护”弹窗，可能一直等待。本次用独立 Rust 进程持有真实协作租约，在点击前确认 sessionAccess 返回占用，再验证复制恢复与原文件不变。覆盖重命名会话和崩溃后的会话，finally 中释放租约。

新增 test:session-lease 检查真实锁竞争、释放后重获、原会话不变与启动失败；build:test 自动先构建测试专用助手。新增两个纯 Node 回归，覆盖助手就绪、EOF 释放、重复清理和启动错误。助手仅在 test-fixture feature 下构建。

## 本轮云端实测
- npm ci --ignore-scripts：通过，使用工作区 npm 缓存；未改依赖锁定或镜像地址。
- npm test：21/21 通过，包含原有 19 项。
- npm run build：TypeScript 检查及 Vite 构建通过；539.16 kB 主 JS 分块仍有体积提示。
- node --check：tauri-smoke.mjs、session-lease-check.mjs 通过。
- git diff --check：通过。
- npm run test:rust、npm run test:session-lease：被环境阻塞，spawn cargo ENOENT；不是测试通过。
- Rust fmt / Clippy、原生构建、Windows WebView2 UI：未运行，本环境没有 Rust/Windows。未调用真实模型。

仓库历史 VERIFICATION.md 记录的是之前验收，不能作为本包已通过 Windows 验收的证明。

## Windows 验收
将包中的 source 解压到新目录，不覆盖正在使用的本地工作区。在 source/desktop 中依次运行：

1. npm ci
2. npm test
3. npm run build
4. npm run test:rust
5. npm run test:session-lease
6. node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
7. node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
8. npm run test:ui

最后一步保留用户的中权限 PowerShell 启动流程，使用模拟 Pi，不调用真实模型。确认 artifacts/tauri-ui-result.json 的 success 为 true，并审阅本轮截图及会话保护两条检查记录。只有通过这些步骤后才算 Windows 验收完成。本包不含依赖、target、安装器或发布 exe。
