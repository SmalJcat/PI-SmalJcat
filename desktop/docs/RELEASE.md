# 打包与签名（P0 收尾）

## 0.5.0：构建来源与本地部署（2026-11-08）

`npm run package` 通过 `scripts/package-native.mjs` 执行 release 构建。构建前后核对 Git 提交与源码内容指纹；检测到输入改变或构建失败则不暂存旧 exe。`artifacts/package-source.json` 将构建来源绑定到程序哈希，暂存脚本复核这份回执。暂存也使用整目录切换与备份，避免只更新 exe 而留下旧清单。

发布清单增加 `source.commit / dirty / sha256 / files / scope`。指纹包含 desktop 下 Git 可见的文件（含未跟踪源码），排除被忽略的产物，以及 docs、JS tests、README、VERIFICATION；只记录相对路径摘要，不写绝对路径或环境变量。它是诊断元数据，**不受 pi-release-v1 签名保护**，清单注明 `authenticated: false`。

此指纹不是可复现构建证明：忽略配置、依赖安装内容、环境变量和工具链二进制不纳入摘要；前后比较也不能发现构建期间修改后又还原的输入。打包期间应暂停编辑。更强的来源保证需要隔离、不可变的构建输入。

```powershell
npm run package
npm run test:release  # 独立用户数据目录；真实 Pi 状态读取，不调用模型
npm run deploy -- --to 'D:\PI\desktop\release\tauri'
# 回退时使用 deploy 输出的 backup 路径；回退也保留当前版本：
npm run deploy -- --from '<backup目录>' --to 'D:\PI\desktop\release\tauri'
```

部署前退出应用，目标父目录须已存在。工具只复制 `Pi Desktop.exe`、`release.json` 和可选 `icon.ico`；在目标同卷临时目录校验大小与 SHA-256，随后将旧目录重命名为 `tauri.backup-<时间>-<随机后缀>`，切换新目录。切换失败会尝试恢复旧目录；备份不自动删除。并发部署以独占 lock 目录拒绝；进程被强杀后如遗留锁，应先检查目标、临时目录和备份，再人工恢复。

部署校验是本地文件完整性检查，不是签名认证；如需来源认证，先按下述流程验签。目录切换不保证断电原子性。目标包含非发布文件时直接拒绝，避免移动用户数据。程序和清单不会复制到 Git 中。

以下内容保留 0.4.1 发布阶段记录，具体版本和验收以当前清单及 [开发记录](DEVELOPMENT.md) 为准。

到这里，发布链路闭环了：**产出可安装的包** + **给更新清单签名** + **应用侧真的验签**。

## 一、两个产物，各管一件事

| 产物 | 位置 | 用途 |
|---|---|---|
| 便携可执行文件 + 清单 | `release/tauri/Pi Desktop.exe` + `release.json` | 应用内更新读取的对象（`npm run package` 产出） |
| **NSIS 安装器** | `src-tauri/target/release/bundle/nsis/Pi Desktop_0.4.1_x64-setup.exe`（4.70 MB） | 分发给用户安装（`npm run bundle` 产出） |

## 二、清单签名设计

**规范载荷**（两端必须逐字节一致）：

```
pi-release-v1
version=<版本>
runtime=tauri
executable=<文件名>
bytes=<字节数>
sha256=<64 位小写十六进制>
```

- 只覆盖**身份字段**：`stagedAt` / `notes` / `url` 属于展示信息，改动它们不会让签名失效（有测试断言）；
- 公钥以 **32 字节原始 Ed25519 公钥**存入信任库，与扩展签名（`trusted-keys.json`）保持同一约定，Rust 侧 `VerifyingKey::from_bytes` 直接吃原始字节；
- **私钥绝不入库**：`desktop/release/keys.json` 已加入 `.gitignore`。

## 三、应用侧的信任策略

`<data_dir>/release-trusted-keys.json` 非空时，检查更新会**强制要求有效签名**：未签名、密钥不在库、被篡改，都会以明确原因拒绝（`更新清单未通过来源认证`）。信任库缺失时退回原有的"仅完整性校验"行为，不阻塞启动。

## 四、跨语言契约测试（这套设计的真正保证）

`tests/release.test.mjs` 用**固定种子派生的 Ed25519 密钥**确定性生成夹具：

- `src-tauri/tests/fixtures/release-signed.json`
- `src-tauri/tests/fixtures/release-trusted-keys.json`

Rust 侧 `cross_language_signed_manifest_verifies` 读取夹具并验证签名通过，同时断言：

| 断言 | 目的 |
|---|---|
| Node 生成的签名通过 Rust 校验 | **两端载荷拼接完全一致** |
| 改动 `bytes` / `executable` 后校验失败 | 身份字段确实在签名覆盖范围内 |
| 空信任库 / 未签名清单失败 | 不签名的清单不会被当成合法 |
| 补上 `notes` / `stagedAt` 后仍然通过 | 展示字段确实不影响签名 |

如果哪天有人改了任何一端的载荷格式，这条测试会立刻红——这比文档管用。

## 五、命令

```powershell
cd desktop
npm run package          # 构建并暂存便携产物 + 生成 release.json
npm run release:keygen   # 生成签名密钥与信任库（已存在则不覆盖）
npm run release:sign     # 先核对暂存产物摘要，再签名清单
npm run release:verify   # 核对摘要 + 用信任库验签
npm run bundle           # 产出 NSIS 安装器
```

`release:sign` 会**先算暂存产物的真实 sha256**，与清单不符时拒绝签名——避免签出一份对不上文件的清单。

## 六、验证证据

```powershell
npm test            # JS：96 项（新增 4 项发布测试）
npm run test:rust   # Rust：lib 76 项（新增 2 项：跨语言签名 / 信任库容错）+ 集成测试
cargo clippy --all-targets --features test-fixture -- -D warnings   # clean
npm run bundle      # 产出 Pi Desktop_0.4.1_x64-setup.exe（4.70 MB）
```

实际跑签名流程的输出：

```
已生成签名密钥：release/keys.json（密钥 ID release-6d86f70f）
产物摘要一致：f6ee5d26e5fca552…
签名校验通过：release-6d86f70f
```

## 七、已知缺口（诚实清单）

1. **没有 Authenticode 代码签名**：安装器与可执行文件都没有 Windows 证书签名，SmartScreen 可能提示未知发布者。需要一张代码签名证书并接 `signtool`——这是 P0 剩下的最后一项；
2. **本次生成的密钥是测试密钥**（在本地 `release/keys.json`，已 gitignore）。正式发布应在安全环境重新 `keygen` 并妥善保存私钥；
3. **安装器没有实际安装、安装后的应用没有启动验证**：安装会写 Program Files/注册表并影响用户的机器，我没有执行（只完成了构建）；
4. **只做 NSIS**，没有 MSI（WiX）目标；
5. **远端更新链路未端到端验证**：需要 `PI_DESKTOP_UPDATE_URL` 指向真实来源；签名校验路径由单元测试与夹具覆盖。

## 八、两条操作教训

1. **`tauri` CLI 需要 cargo 在 PATH 上**：直接跑 `node_modules/.bin/tauri build` 会以 `program not found` 立刻失败——本仓库的 `scripts/native.mjs` 正是为此存在的包装（它把 `~/.cargo/bin` 塞进 PATH），所以要用 `node scripts/native.mjs build`；
2. **后台任务的退出码会骗人**：我把命令包在 `... *>> log; "exit=$LASTEXITCODE" | Out-File ...` 里，最后一条语句成功就让整个作业返回 0，真正的失败藏在日志里（`tauri_build_exit=1`）。**判断成败要读日志，不能只看退出码。**
