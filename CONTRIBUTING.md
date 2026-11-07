# 联合开发约定

## 分支与提交

1. 开工前 `git switch main`，再执行 `git pull --ff-only`。
2. 创建独立分支，如 `feature/context-panel`、`fix/agent-recovery`、`docs/setup`。
3. 一次 PR 聚焦一项行为变化；用提交信息说明具体改动。
4. 提交 PR 前同步最新 main、解决冲突并运行受影响检查；由其他开发者审阅后合并。

已有远端改动应先合并或 rebase；不要覆盖别人的提交，不要对共享 main 强制推送。建议管理员开启分支保护、要求 PR 审阅和 Windows checks 通过；这些仓库权限设置需要管理员在 GitHub 中配置。

## 分工边界

- 界面模块优先拆成独立组件和样式文件，减少 `desktop/src/App.tsx` 的冲突。
- Rust 功能优先拆成独立模块；修改 `core.rs`、`desktop.rs`、`bridge.ts` 或 `types.ts` 的接口前，先在对应 issue / PR 中写清请求和响应结构。
- 变更 RPC、任务状态、取消或持久化时，同步修改协议夹具与必要的集成测试。
- 用户级 Pi 配置不作为仓库配置提交；本地 Pi 路径通过 `PI_DESKTOP_EXECUTABLE` 或桌面设置指定。

## 验证

在 `desktop/` 下运行 `npm ci` 后执行 README 中的 build、JS / Rust、fmt 和 Clippy 检查。涉及界面、桥接、进程或任务生命周期时，还需运行 `npm run test:ui`，并检查生成截图。

默认 CI 不连接真实模型。真实模型验收会消耗用量，按需在隔离会话中运行；PR 中明确区分模拟测试与真实服务验证。保存日志到被忽略的 `artifacts/`，PR 描述提供必要的脱敏摘要。

## 发布与敏感数据

版本更新时同步 `desktop/package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 与 `tauri.conf.json`。使用 `npm run package` 生成本地发布程序和版本 / SHA-256 清单。

不提交 `.env`、API 密钥、认证文件、真实会话、客户端数据、`node_modules`、Rust target、发布程序或测试产物。新增配置示例只能使用占位值。当前历史 Electron 源码仅用于兼容与回归；新功能以 Rust / Tauri 实现为准。

## 云端与 Windows 交接

统一运行 `npm run check:cloud` 或 Windows 独立副本中的 `npm run check:windows`，保留源码摘要及结果。具体环境、隔离要求和精确提交传递方法见 [开发与验收流程](desktop/docs/DEVELOPMENT-VALIDATION.md)。
