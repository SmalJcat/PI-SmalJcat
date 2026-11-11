# 应用内更新 P0.3（0.4.1 增量）

《Pi Desktop → ChatGPT 级桌面端路线图》的 P0.3：把「发布工程」最小闭环做进 Pi Desktop —— 检查 → 下载 → SHA-256 校验 → 暂存 → 下次启动替换。

## 使用行为

- 打开「设置与连接（Ctrl+,）」，面板底部新增**应用更新**卡片：状态徽标、说明、进度条与三个动作。
- **检查更新**：读取更新源上的清单并与当前版本比较。发现更高版本进入「有新版本」；相同或更低版本进入「已是最新」，不会误报。
- **下载并校验**：下载过程中按已写入字节刷新百分比；下载完成后流式计算 SHA-256，与清单声明比对。不一致时**丢弃下载内容**并给出期望/实际值，不留下半成品。
- **安排下次启动应用**：写入待应用标记。下次启动时先备份当前程序（`Pi Desktop.bak-<版本>`），再替换为新程序；失败会保留回滚副本。
- 未配置更新源时不会静默失败：卡片显示提示，并可用「使用本地清单检查」粘贴 `release.json` 内容走同一条校验链路（离线可用）。

## 配置

- `PI_DESKTOP_UPDATE_URL`：更新源地址（清单 JSON，格式同 `release/tauri/release.json`；清单内 `url` 字段可指向安装包）。未设置时只提供本地清单检查。
- 暂存与状态目录：`%APPDATA%\local.pi.desktop\updates\`（`<版本>/<文件>` 与 `pending.json`）。

## 清单格式

复用现有发布元数据并允许两个可选字段：

```json
{
  "version": "0.4.2",
  "runtime": "tauri",
  "executable": "Pi Desktop.exe",
  "bytes": 12592128,
  "sha256": "<64 位十六进制>",
  "stagedAt": "2026-11-07T07:50:11.905Z",
  "url": "https://<更新源>/Pi%20Desktop.zip",
  "notes": "可选的更新说明"
}
```

校验规则：版本号必须可解析；`sha256` 必须是 64 位十六进制；`bytes` 必须大于 0；`executable` 只接受单一文件名（拒绝 `..`、分隔符与目录），否则清单直接判为非法。

## 安全边界

- **只替换当前程序**：`pending.json` 里的目标路径必须与当前运行的可执行文件一致，否则忽略并拒绝应用。这避免了数据目录被写入后引发任意文件覆盖。
- **暂存路径不越界**：写入与读取都用规范化前缀校验，暂存文件必须位于更新目录内。
- **先校验后应用**：下载完成与启动应用两个环节都做哈希校验；任一失败都不替换程序。
- **启动不阻塞**：应用待更新失败只记录日志，不影响启动。
- **下载走系统 curl.exe**（Windows 10 1803+ 自带），启动失败时回退 PowerShell `Invoke-WebRequest`；不引入新的第三方依赖。

## 已知限制（本阶段不做）

- 没有内置更新服务器与签名验证：清单本身依赖传输层可信；代码签名（P0.1）与商店分发仍是后续工作。
- 替换需要目标目录可写；安装在 `Program Files` 时需要提权，本阶段不申请提升。
- 不自动重启应用：应用后由用户关闭并重新打开（与「下次启动应用」的取舍一致）。
- 更新源只在启动时从环境变量读取，尚未进入偏好文件与界面设置。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/update.rs` | 新增：清单校验、版本比较、状态机、下载（可注入）、流式 SHA-256、暂存与启动应用，含 10 项单元测试 |
| `src-tauri/src/desktop.rs` | `DesktopState` 持有 `UpdateManager`；新增 `update-status` / `update-source` / `update-check` / `update-download` / `update-install`；启动时应用待更新 |
| `src-tauri/src/lib.rs` | 注册 `update` 模块 |
| `src/update.mjs` | 纯展示逻辑：阶段文案、状态色、进度、字节格式化、轮询节奏 |
| `src/UpdatePanel.tsx` | 设置面板内的更新卡片 |
| `src/bridge.ts` / `src/types.ts` | 四个新命令与 `UpdateStatus` 类型 |
| `src/styles.css` | 更新卡片样式（复用现有配色变量，含 reduced-motion 与状态色） |
| `tests/update.test.mjs` | 7 项前端逻辑测试 |

未改动 `App.tsx` 的既有行为，只在设置面板内挂载卡片，并新增一行导入。

实现约定：`UpdateManager` 的失败路径统一走 `fail()`，先释放状态锁再读取快照 —— 早期版本在持锁时调用 `status()` 会自死锁，现已由下载失败 / 哈希不匹配两项测试守住。

## 验证

```powershell
Set-Location desktop
npm test                                              # JS：32 项（新增 7 项）
npm run build                                         # TypeScript + Vite
npm run test:rust                                     # Rust：全部测试
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
```

离线夹具覆盖：清单非法输入、版本比较（含预发布与位数补齐）、下载成功、哈希不匹配丢弃、下载失败上报、应用前后文件替换与回滚副本、拒绝外来目标、损坏标记忽略。

## 本机同步

源码仓库为 `D:\PI-SmalJcat`；`D:\PI\desktop` 是运行副本。合入前需先按 `docs/COMPOSER-0.4.1.md` 的同步流程备份（`artifacts/sync-backups/`）再覆盖，避免运行副本与源码分叉。
