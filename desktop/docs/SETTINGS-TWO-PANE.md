# 设置改为两栏 · 图标全部自绘

## 一、设置对话框：左栏分区 + 右栏内容

之前六张卡片（更新/扩展/MCP/沙箱/索引 + 连接字段）堆在一列滚动里，既难找也难读。现在拆成两栏：

| 分区 | 内容 |
|---|---|
| **连接**（默认） | Pi 可执行文件、配置目录、信任开关、重新连接 / 切换工作区、**连接诊断** |
| 外观 | 界面风格切换、快捷键说明 |
| 更新 | 应用内更新（检查 / 下载校验 / 安排重启） |
| 扩展 | 扩展清单与签名判定 |
| MCP | 桌面端 MCP 连接与工具调用 |
| 沙箱 | MCP Apps 沙箱与授权 |
| 索引 | 本地任务索引与检索 |

左栏宽度 168px、条目 36px 高、`--radius-lg` 圆角、当前分区用 `--surface-raised` 高亮；右栏内边距 20px 独立滚动。

组件抽成 `src/SettingsDialog.tsx`（props 明确：偏好、目录、信任、外loaded、诊断、回调），`App.tsx` 里只剩一行挂载。

## 二、图标：全部自绘（lucide 依赖已移除）

本批补完最后 8 个：`ArrowDown`、`ArrowUpRight`、`Code2`、`FileCode2`、`MessageSquare`、`RotateCcw`、`RotateCw`、`TerminalSquare`。

现在 `src/icons.tsx` 共 **49 个自绘图标**，`grep lucide-react src/` 的结果是 **0**。规范不变：24 网格、2px 安全边、1.7 描边、圆角端点、只用直线/圆/弧。

## 三、这一轮最重要的教训：验收用例是契约

我第一版两栏化**直接把 30 项验收打到 12 项通过**。诊断过程（值得记住）：

1. 看回执：`success=False`、`passed=12`、`rendererErrors=0` —— 渲染没坏，是**流程走不下去**；
2. 打开 `tests/tauri-smoke.mjs` 第 168-183 行，发现它在打开设置后**立刻点「连接诊断」并点「重新连接 Pi」**；
3. 这两项被我挪进了别的分区，默认分区（外观）里没有 → 超时失败。

处理方式不是回退设计，而是**把契约放回默认分区**：

- 默认分区改为「连接」；
- 「连接诊断」保留在连接分区（且全应用只有这一处，避免 `getByText` 命中两个元素）；
- 去掉单独的「诊断」分区。

改完重新跑：**30 项全过、渲染错误 0**。

顺带修了一个类型问题：React 19 下 `JSX.Element` 命名空间不可用，改用 `ComponentType<{ size?: number }>`。

## 四、验证

```powershell
Set-Location desktop
npm test                        # JS：73 项
npm run build                   # TypeScript + Vite
npm run test:ui                 # 真实 WebView2：30 项全过、渲染错误 0
```

截图：`artifacts/tauri-settings-test.png`（两栏设置 + 展开的连接诊断）、`artifacts/tauri-home-test.png`、`artifacts/tauri-chat-test.png`。

## 五、下一步可做

- 其余面板（上下文 / 子代理 / 终端）目前还是各自的整屏弹窗，可以评估是否也改成两栏或并入右栏；
- 动效时长按你的手感微调（`chatgpt-theme.css` 第 9 节）；
- 需要的话把「外观」分区扩成真正的主题编辑器（颜色变量可视化调整）。
