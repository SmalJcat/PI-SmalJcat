# 子代理角色选择器与工作树清理（P3.2 收尾）

上一轮把角色与 worktree 隔离做进了后端，这一轮把界面接上——三件套（终端 / 子代理 / 索引）到这里才算真正可用。

## 界面行为

**派发侧**：探子工作台的创建表单新增**角色**下拉，选项来自 `agent-roles` 命令（与 Rust 侧内置目录同源，不会各写一份）。

- 只读角色（`scout` / `verifier`）：说明文字给出该角色的工具白名单，并注明"不可修改文件"；
- 可写角色（`editor` / `runner`）：下拉项标注"（可写 · 独立 worktree）"，说明文字同时提示改动不会触碰当前工作区、合并由你决定；
- 角色随任务一起提交（`role` 字段），任务记录里保留 `role` / `worktree` / `branch`。

**任务详情**：标题行显示角色；可写任务多出一行**隔离工作树**——分支名 + 工作树路径 + **移除工作树**按钮（任务运行中或正在取消时禁用）。

**侧栏**：当前仓库工作树多于一个时提示总数，并说明隔离工作树可在任务详情里单独移除、分支会保留。**没有做批量删除**：那是危险操作，交给 `git worktree` 手动处理。

## 安全边界

- **拒绝移除主工作树**：`worktree::remove` 会先比对仓库根目录，命中就报错——否则"清理工作树"会变成删掉用户的工作区。这条有专门的测试守着。
- 移除只删工作树目录，**分支保留**，随时可以 `git diff` 审阅或手动合并。
- 运行中的任务不允许移除自己的工作树（按钮禁用），避免删掉正在写入的目录。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/worktree.rs` | `remove` 增加主工作树保护 + 对应测试 |
| `src-tauri/src/desktop.rs` | 新增 `worktree-list` / `worktree-remove`（非 git 仓库时返回明确原因，而不是报错） |
| `src/AgentsPanel.tsx` | 角色下拉、角色说明、详情里的工作树行与移除按钮、侧栏工作树计数 |
| `src/bridge.ts` / `src/types.ts` | `agentRoles` / `worktreeList` / `worktreeRemove` |

## 验证

```powershell
Set-Location desktop
npm test            # JS：65 项
npm run build
npm run test:rust   # Rust：lib 71 项 + 集成测试（worktree 3 项含主工作树保护）
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run test:ui     # 真实 WebView2 验收：子代理并发/排队/取消/重试/继续全部覆盖
```

## 已知限制

- 没有"一键清理所有孤儿工作树"：需要人工判断哪些还在用；`worktree-list` 已能列出全部，界面只做计数提示。
- 角色仍是内置四项，尚不支持从 `agents/*.md` 自定义角色。
- 父代理的 `desktop_scout` 工具仍只派发只读任务；可写角色目前由人工创建。
