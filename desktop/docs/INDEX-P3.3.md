# 本地任务索引 P3.3（0.4.1 增量）

路线图 P3 的第三块：把任务检索从"每次读全部记录"换成 SQLite 查询，并提供重建与检索界面。

## 定位：索引是缓存，不是事实来源

任务记录文件仍然是权威数据。索引可以**随时重建**，也可以**直接丢弃**。因此这里的策略是"可损坏、可丢弃、可重建"：

- 索引文件损坏（不是数据库）时，把它改名成 `index.corrupt-<时间戳>` 挪走，然后重建一个空索引，**绝不阻塞启动**；
- 结构版本变化时清空任务表并重建，不尝试就地迁移；
- 重建在**单个事务**里完成：要么整体生效，要么保持原样，不会留下半截索引。

## 索引内容

只放检索需要的字段与小段文本：`id / status / role / cwd / title / model / created_at / updated_at / archived_at`，外加一段 `searchable`（id + 标题 + 工作区 + 模型 + 角色 + 状态 + 输出，统一小写，上限 4 KiB）。**任务正文不落索引**，避免重复存储。

## 检索行为

- 筛选先于分页：关键词（对 `searchable` 做子串匹配）、状态（all / active / completed / attention 或具体状态名）、角色、工作区、归档（current / archived / all）；
- 排序稳定：`created_at` 降序 + `id` 升序；每页上限 100，默认 20；返回 `total` / `page` / `totalPages`；
- 非法筛选值（例如把注入串当状态名、未知归档值）**直接报错**，不做静默忽略。

## 界面行为

设置里新增 **本地任务索引** 卡片：索引概况（条数、归档数、库大小、结构版本、上次重建时间）、**重建索引**（完成后显示已索引/跳过条数与耗时）、关键词检索 + 按角色筛选 + 上下翻页。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/index_store.rs` | 新增：建表与版本、投影、写入/替换、事务重建（分批回调进度）、检索与分页、损坏隔离，含 7 项测试 |
| `src-tauri/Cargo.toml` | 新增 `rusqlite`（`bundled`，静态编译 SQLite，无需外部依赖） |
| `src-tauri/src/desktop.rs` | `Services` 增加 `index`；新增 `index-stats` / `index-search` / `index-rebuild` |
| `src/IndexPanel.tsx` | 新增：索引概况 + 检索 + 重建卡片 |
| `src/bridge.ts` / `src/types.ts` | 新命令与类型 |
| `src/styles.css` | 卡片样式 |

## 验证

```powershell
Set-Location desktop
npm test            # JS：65 项
npm run build
npm run test:rust   # Rust：lib 71 项（新增 7 项）+ 集成测试
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run test:ui     # 真实 WebView2 验收（确认主界面未被破坏）
```

索引测试覆盖：建表与概况、同 id 替换、缺 id 跳过、筛选先于分页且排序稳定、输出参与检索、归档筛选、事务重建与进度回调、可搜索文本截断、**垃圾文件隔离后重建**、重开后数据仍在。

## 已知限制

- **索引不自动增量更新**：任务完成后不会自动写入索引，需要点"重建索引"（或将来加钩子）。检索界面因此是一个"快照视图"，卡片上标注了上次重建时间。
- 重建用 `agents.list()` 的内存记录作为输入，因此索引范围等于当前加载到的任务记录；更早的历史需要记录读取层先加载。
- 没有 FTS5 全文检索：目前是 `LIKE` 子串匹配，对 CJK 是逐字匹配，没有分词与排序权重。
- 索引库没有加密：与其它本地数据一样依赖操作系统账户隔离。
