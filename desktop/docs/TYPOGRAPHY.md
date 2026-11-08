# 排版系统（中文优先）

## 为什么不能直接照抄它的排版

它的排版基准是 `--text-base: 14px` / `line-height: 1.5`——**为英文调的**。中文是满宽字形、笔画密度高，同样 1.5 行高会显得拥挤；中文标题若用 600 字重，小字号下会糊成一团。所以字号阶梯沿用它的数值（保证观感一致），但**行高、字重、字距按语言分层**。

## 一、排版令牌（`src/typography.css` 顶部，改这里）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--font-ui` | `Segoe UI Variable Text → Segoe UI → Microsoft YaHei UI → PingFang SC → Noto Sans CJK SC` | 界面字体栈（系统优先，显式排入中文字体，避免落到衬线回退） |
| `--font-code` | `Cascadia Code → Consolas → JetBrains Mono → Noto Sans Mono CJK SC` | 代码与等宽 |
| `--type-display-size` | 36px | 空态大标题（= 它的 `text-2xl`） |
| `--type-title-size` | 16px | 面板标题 |
| `--type-subtitle-size` | 14px | 次级标题 |
| `--type-body-size` | 14px | 正文（= 它的 `text-base`） |
| `--type-label-size` | 13px | 表单标签、输入框 |
| `--type-meta-size` | 12px | 说明文字、消息署名 |
| `--type-micro-size` | 11px | 徽标、状态、快捷键（= 它的 `text-xs`） |
| `--type-code-size` | 12.5px | 代码、参数、diff |
| `--type-ui-line` | **1.5** | 界面元素与英文（对齐它） |
| `--type-cjk-line` | **1.75** | 中文正文（给笔画留呼吸） |
| `--type-code-line` | 1.65 | 代码与 diff |
| `--type-weight-regular/medium/strong` | 400 / 500 / 600 | **中文标题只用 500**；600 只留给拉丁数字与英文强调 |
| `--type-tracking-cjk` | **0** | 中文默认字距为 0（加负字距会粘字） |
| `--type-tracking-display` | -0.01em | 仅大字号显示文本 |
| `--type-tracking-caps` | 0.06em | 全大写小标签（英文） |

## 二、落地规则

- **正文/消息**：14px / 1.75；Markdown 段落间距 `0.6em`、列表缩进 1.4em、引用块左侧 2px 描边；
- **标题**：`font-weight: 500`、`letter-spacing: 0`、行高 1.4；空态大标题用 400 字重（中文大字号用 500 会显得闷）；
- **辅助文字**（说明、署名、会话副标题）：12px / 1.6 且统一次要色；
- **徽标/状态/快捷键**：11px；全大写英文小标签才用正字距；
- **数字**：用量、费用、字节数、diff 统计用 `font-variant-numeric: tabular-nums`，表格里不跳动；
- **代码**：等宽栈 + 12.5px / 1.65；行内代码在正文里不改变行高；
- **`font-synthesis: none`**：关掉合成字重/斜体——中文伪粗体会糊，宁可用真字重；
- **`font-feature-settings: kern/liga/calt`**：开启字距与连字调整；`text-rendering: optimizeLegibility`。

## 三、验证

```powershell
Set-Location desktop
npm test                        # JS：78 项（新增 5 项排版测试）
npm run build
npm run test:ui                 # 真实 WebView2：30 项全过、渲染错误 0
```

新增的排版测试把设计意图固化成断言，防止以后被随手改坏：

1. 令牌齐全（8 个字号 / 4 个行高 / 3 个字重）；
2. **中文正文行高必须 ≥ 1.7 且大于界面行高**；
3. **中文默认字距必须为 0、标题字重 ≤ 500**，负字距只允许出现在显示文本且 ≥ -0.02em；
4. 字体栈必须包含中文字体回退（`Microsoft YaHei UI`、`PingFang SC`、`Noto Sans CJK SC`）与等宽回退；
5. 所有规则必须挂在 preset 作用域下，且保留 `font-synthesis: none` 与等宽数字。

截图：`artifacts/tauri-chat-test.png` —— 中文正文行距、工具卡里的参数/输出、列表项都可以直接看。

## 四、已知限制

- **中英混排自动间距**（`text-autospace` / `text-spacing-trim`）WebView2 尚未支持，目前靠行高与标点位置兜底；
- 没有自带字体文件：完全依赖系统字体（与它一致，也避免引入第三方字体授权问题）；
- 表格与代码块的横向滚动样式沿用旧值，未纳入本轮排版令牌。
