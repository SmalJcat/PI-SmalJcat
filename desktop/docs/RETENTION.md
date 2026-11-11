# 保留策略：过期归档清理（以及不该清理的东西）

单机用几个月后磁盘会涨。但"自动删用户数据"必须有分寸，所以这轮的实现重点是**边界**而不是功能量。

## 一、能清理什么，不能清理什么

| 对象 | 处理 | 理由 |
|---|---|---|
| **已归档**的任务记录 | 超过保留期后**列出候选**，确认才删 | 用户可能还想翻旧任务 |
| 运行中 / 已完成未归档的任务 | **永不**触碰 | 那是当前工作 |
| 会话原文（`.jsonl`） | **永不删除** | 索引可重建，对话不能——这是本轮最重要的一条 |
| 更新缓存 | 超过 7 天**自动清理** | 纯缓存，下次检查更新会重新下载 |
| 隔离工作树 | **永不自动删除** | 里面有代码 |

## 二、安全设计

1. **先预览再执行**：保留期到了也只提示「超过保留期的归档记录：N 条 · M MB」，需要点「清理这些记录」→ 再点「确认删除 N 条」；
2. **服务端重新校验**：执行时不是照单删除前端传来的 id，而是**按当前过期条件重新算一遍候选**再取交集——预览到确认之间用户如果恢复了归档，那条就不会被删；
3. **固定档位**：0（永久）/ 90 / 180 / 365 天，后端 `is_valid_retention` 再校验一次，非法值直接报错而不是悄悄取默认；
4. **读不动就跳过**：扫描候选时只读记录文件里的 `archivedAt` 字段，文件名/结构不符、JSON 损坏的一律跳过，不猜；
5. **自动清理只动可再生的**：启动时清理更新缓存，且**只删超过门槛的单个文件**——不是整个目录（否则刚下载的包会被旁边的旧文件连坐），并剪掉清空后的空目录。

## 三、实现

| 文件 | 变更 |
|---|---|
| `src-tauri/src/retention.rs` | 新增：档位校验、过期判定、候选扫描、清理执行、更新缓存自动清理，含 **6 项测试** |
| `src-tauri/src/core.rs` | `Preferences.archived_retention_days` + `set_retention`（校验档位） |
| `src-tauri/src/agents.rs` | `forget(id)`：从内存与索引移除（记录文件由保留策略删除） |
| `src-tauri/src/desktop.rs` | `retention-status` / `retention-set` / `retention-apply`；启动时后台清理更新缓存 |
| `src/SettingsDialog.tsx` | 「存储」分区新增「归档保留期」行与两段式确认 |

## 四、测试

| 测试 | 覆盖 |
|---|---|
| `retention_values_are_validated` | 只接受 0/90/180/365 |
| `expiry_only_affects_archived_and_past_cutoff` | 永久保留不过期、未归档不过期、期内不过期、超期过期、**正好等于截止点不算过期** |
| `candidates_skip_other_files_and_bad_json` | 非记录文件、损坏 JSON 一律跳过；永久保留时零候选 |
| `removing_candidates_deletes_files_and_reports_bytes` | 删除并统计字节；重复执行不报错也不重复计数 |
| `update_cache_cleanup_only_removes_expired_files` | **只删过期那一个，新下载的包保留**（用真实 mtime 构造） |
| `update_cache_expiry_counts_old_files` | 门槛统计与 overview 字段 |

## 五、验证

```powershell
Set-Location desktop
npm test            # JS：96 项
npm run test:rust   # Rust：lib 99 项（保留策略 6 项）+ 集成测试
cargo clippy --all-targets --features test-fixture -- -D warnings   # clean
cargo fmt --check   # clean
npm run test:ui     # 真实 WebView2：37 项全过、渲染错误 0
```

新增验收项：**保留策略：档位落库、过期候选只清理可再生的东西** —— 默认是「永久保留」；切到 90 天后读回 `retentionStatus().retentionDays === 90`；并断言全新环境下 `records === 0`、`updateCacheFiles === 0`（没有残留候选，也就不会误删）。

## 六、已知限制

1. **不自动删除任务记录**（刻意）：保留期只用于提示与手动确认，这是为单机个人使用选的安全默认；
2. **没有按任务例外/免清理标记**，也没有"只保留最近 N 条"这类上限策略；
3. **档位固定**（0/90/180/365 天），不支持任意天数；
4. **会话与工作树不在保留范围内**：会话永不删（设计如此），工作树仍只能逐个移除；
5. 清理是**同步删除文件**：候选很多时会有短暂卡顿（几千条量级无感）。
