# 扩展清单与签名校验 P1.1（0.4.1 增量）

路线图《Pi Desktop → ChatGPT 级桌面端》的 P1.1：给扩展建立**可核查的来源与权限**，对齐 ChatGPT 桌面端的 `plugins` + `plugin-signatures` 形态。

设计前提：**桌面端不加载扩展**（加载由 Pi 本体负责），它只回答三个问题——这个扩展是谁签的、要什么权限、能不能信。结论只有「已签名并受信任」才被视为可信，其余一律 fail closed。

## 清单格式

`extensions/<目录>/manifest.json`：

```json
{
  "id": "com.example.demo",
  "name": "示例扩展",
  "version": "1.2.3",
  "description": "可选，仅展示",
  "entry": "index.mjs",
  "permissions": ["tools", "network"],
  "pi": ">=1.5.0",
  "homepage": "https://example.com"
}
```

校验规则（任一不满足即判为「清单无效」，不进入签名校验）：

- `id`：小写字母/数字/点/中划线/下划线，分段不足一空，总长 ≤ 96。
- `version`：以数字开头，只含数字、`.`、`-`、`+`。
- `entry`：只允许同级目录下的 `*.mjs / *.js / *.cjs`（拒绝子目录与路径成分）。
- `permissions`：必须全部属于下面的已知集合，**出现未知权限直接判非法**，不静默忽略。
- `manifest.json` 超过 64 KiB 直接拒绝。

## 权限词汇表

| 权限 | 含义 | 风险 |
|---|---|---|
| `read` | 读取会话 | 低 |
| `tools` | 调用工具 | 低 |
| `fs:workspace` | 工作区文件读写 | 中 |
| `network` | 网络访问 | 中 |
| `fs:any` | 任意路径文件读写 | 高 |
| `exec` | 执行外部命令 | 高 |
| `secrets` | 读取凭据 | 高 |

## 签名载荷（跨语言逐字节一致）

完整性覆盖「清单关键字段 + 入口文件内容」，格式固定 8 行、LF 结尾：

```text
pi-extension-v1
id=<id>
name=<name>
version=<version>
entry=<entry>
permissions=<按字节序排序并去重，逗号分隔>
pi=<pi 版本要求>
sha256=<entry 文件字节的 SHA-256 小写十六进制>
```

因此**改权限、改入口内容、改 id/版本都会让签名失效**；`description` 与 `homepage` 只用于展示，不参与签名（将来要签它们需要把载荷版本升到 v2）。

Rust 侧 `src-tauri/src/extensions.rs` 与前端 `src/extensions.mjs` 各自实现一次，并由 `node_generated_signature_verifies` 测试用**Node 生成的签名**在 Rust 里验证，防止两侧规则分叉。

## 签名与信任库

- `signature.json`：`{ "algorithm": "ed25519", "keyId": "release-2026", "signature": "<base64>" }`。
- `trusted-keys.json`（位于 extensions 根目录）：`{ "<keyId>": "<32 字节公钥 base64>" }`。缺失或损坏按「空信任库」处理，不影响列表展示。

判定结论：

| 结论 | 含义 | 界面 |
|---|---|---|
| `verified` | 签名有效且密钥在信任库 | 已签名并受信任（绿） |
| `untrusted-key` | 签名有效但密钥未知 | 签名有效但密钥不受信任（黄） |
| `invalid` | 有签名但校验失败（内容被改） | 签名无效（红） |
| `unsigned` | 没有 `signature.json` | 未签名（黄） |
| `broken` | 清单非法 | 清单无效（红），并给出原因 |

## 工具链

```powershell
# 1) 生成密钥（私钥文件不要提交）
node scripts/sign-extension.mjs keygen --out keys/release-2026.json --key-id release-2026
# 2) 把公钥加入信任库
node scripts/sign-extension.mjs trust  --root <extensions 根目录> --key keys/release-2026.json
# 3) 签名扩展
node scripts/sign-extension.mjs sign   --dir <扩展目录> --key keys/release-2026.json
# 4) 本地校验（与桌面端同一套规则）
node scripts/sign-extension.mjs verify --dir <扩展目录> --root <extensions 根目录>
```

`verify` 的输出为 `verified` / `untrusted-key` / `invalid` / `unsigned`，可直接用在 CI 里。

## 界面行为

「设置与连接」中新增**扩展与签名**卡片：

- 顶部徽标显示 `已受信任 / 总数`，并汇总「需要确认」「声明高风险权限」的数量。
- 每个扩展一行：结论徽标、名称、版本、`id`、签名算法与 keyId、按风险排序的权限标签、失败原因。
- 高风险权限的卡片带左侧红条；可按 id / 名称 / 状态筛选；「重新扫描」重新读取目录。
- 右上角显示扫描目录与已信任的密钥名，便于确认信任库是否生效。

## 安全边界

- **只读**：只读取 `manifest.json` / `signature.json` / 入口文件 / 信任库，从不执行扩展代码，也不修改任何扩展。
- **fail closed**：未知权限、非法 id/entry、超大清单、不支持的算法、损坏的签名文件都进入非可信状态并给出原因。
- **越界防护**：`entry` 只接受单一路径成分；清单与信任库损坏都不影响其它扩展的判定。
- **确定性**：权限排序、扩展列表排序（受信任优先，其次按 id）都是稳定的，便于复核与 diff。

## 已知限制（本阶段不做）

- **尚未强制**：本阶段只做核查与展示，Pi 仍会加载目录中的全部扩展。要真正阻断需要「未受信任扩展禁用/隔离」开关（下一步）。
- 只校验**入口文件**的摘要；扩展若在运行时读取同目录其它文件，这些文件不在签名范围内。
- 没有密钥分发、轮换与吊销：信任库是本地文件，由使用者自己维护。
- 未接入市场/下载：扩展仍需手动放入目录。

## 实现范围

| 文件 | 变更 |
|---|---|
| `src-tauri/src/extensions.rs` | 新增：清单校验、权限模型、载荷、Ed25519 校验、信任库、目录扫描，含 8 项单元测试 |
| `src-tauri/src/desktop.rs` | 新增 `extensions-list`（默认扫描当前 Pi 配置目录下的 `extensions`） |
| `src-tauri/src/lib.rs` | 注册 `extensions` 模块 |
| `src-tauri/Cargo.toml` | 新增 `ed25519-dalek 2`（`default-features = false`） |
| `scripts/sign-extension.mjs` | 新增：`keygen / sign / trust / verify`，复用 `src/extensions.mjs` 的载荷规则 |
| `src/extensions.mjs` | 新增：载荷构造、权限元数据、结论映射、排序与汇总 |
| `src/ExtensionsPanel.tsx` | 新增：设置面板内的扩展卡片 |
| `src/bridge.ts` / `src/types.ts` | 新命令与 `ExtensionScan` 类型 |
| `src/styles.css` | 扩展卡片样式（权限按风险着色，含高风险左侧条） |
| `tests/extensions.test.mjs` | 8 项前端逻辑测试 |

## 验证

```powershell
Set-Location desktop
npm test            # JS：40 项（新增 8 项）
npm run build       # TypeScript + Vite
npm run test:rust   # Rust：lib 32 项（新增 8 项）+ 集成测试
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

关键用例：清单各类非法输入、权限去重与排序、载荷逐字节固定、四种签名状态、入口被改后签名失效、权限被改后签名失效、跨语言夹具（Node 签名 → Rust 验证）、信任库损坏不阻塞列表、目录排序稳定。
