# 执行型多角色子代理 P3.2（0.4.1 增量）

路线图 P3 的第二块：把只读探子扩成一条**能力阶梯**，并给可写角色加**worktree 隔离**。

## 角色阶梯

| 角色 | 工具白名单 | 可写 | worktree |
|---|---|---|---|
| `scout`（只读探子，默认） | read,grep,find,ls | 否 | 否 |
| `verifier`（验证者） | read,grep,find,ls,bash,powershell | 否 | 否 |
| `editor`（编辑者） | read,grep,find,ls,edit,write | **是** | **必须** |
| `runner`（执行者） | read,grep,find,ls,edit,write,bash,powershell | **是** | **必须** |

工具名取自 Pi 官方文档（内置 read / bash / powershell / edit / write；默认启用 read,bash,edit,write）。只读角色的四个工具沿用本应用一直在用的组合，行为不变。

## 两条安全不变量

1. **可写角色必须跑在独立 worktree 里**。`agent_roles::ensure_supported` 在创建任务时先判断工作区是不是 git 仓库；不是就直接拒绝并说明原因，而不是就地改文件。
2. **有效工作目录由角色决定**。`effective_cwd` 对可写角色只接受 worktree 路径，拿不到就报错——不存在"降级到主工作区"的路径。

worktree 由 `git worktree add -b pi-desktop/<短id> <路径> HEAD` 创建在客户端数据目录的 `worktrees/<任务 id>` 下；任务记录里保留 `role` / `worktree` / `branch`，界面与 `git` 都能看到。**不自动合并、不删分支**：合并是需要人决定的操作。

## 系统提示与参数

子代理的系统提示 = 固定探子提示 + 角色提示 + 任务自带提示；`--tools` 用角色白名单（只读角色仍是 `read,grep,find,ls`），并继续用 `--exclude-tools mcp__*` 挡掉 MCP 工具。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/agent_roles.rs` | 新增：角色目录、白名单校验、worktree 要求、有效工作目录，6 项单元测试 |
| `src-tauri/src/worktree.rs` | 新增：仓库判断、创建/列出/移除工作树、分支命名，3 项单元测试（真实 git 仓库） |
| `src-tauri/src/agents.rs` | `NewTask.role`；`Task.role/worktree/branch`；创建任务时隔离；`--tools` 与提示按角色生成 |
| `src-tauri/src/core.rs` | 把 `role` 从请求透传给任务创建 |
| `src-tauri/src/desktop.rs` | 新增 `agent-roles`（角色目录） |
| `src-tauri/tests/agents.rs` | 新增：非 git 工作区拒绝可写角色、未知角色报错 |

## 验证

```powershell
Set-Location desktop
npm run test:rust   # Rust：lib 64 项（新增 9 项）+ 集成测试（agents 6 项，新增 1 项）
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run test:ui     # 真实 WebView2 验收：覆盖子代理并发/取消/重试/继续，确认既有流程未被破坏
```

## 已知限制（下一步）

- **界面还没有角色选择器**：`agent-roles` 已经就绪，`AgentsPanel` 的创建表单仍是固定只读探子。这是下一轮的第一件事。
- **没有 worktree 清理入口**：任务结束后工作树保留（便于审阅与合并），目前需要手动 `git worktree remove`；计划加一个"工作树"面板。
- 角色是内置的，尚不支持从 `agents/*.md` 定义自定义角色（`definition()` 仍只读 `default.md`）。
- 父代理的 `desktop_scout` 工具仍只派发只读任务；可写角色目前只能手工创建。
