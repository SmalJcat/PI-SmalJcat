# ChatGPT 风格界面 preset（按实测令牌标定）

目标：把 Pi Desktop 的视觉与布局做到与 ChatGPT 桌面端一致，作为你继续调整的起点。

## 方法论

它的界面是纯前端（Tailwind v4 + 语义令牌），所以**布局与视觉可以高度还原**；不可搬的是它的代码与资源（闭源，且它的渲染层开机就依赖它自己的主进程）。

做法：**只读解析它打包的 CSS，把「门牌号」量出来，再用我们自己的选择器实现**。没有复制它的样式表，也没有使用它的任何素材。共提取 2111 个令牌，其中与视觉相关约 90 个、与几何相关约 40 个。

## 一、颜色与尺寸（实测 → 我们的取值）

| 它的令牌 | 实测（暗色） | 我们用在哪 |
|---|---|---|
| `--color-surface` (gray-200) | `#212121` | 对话区底色 `--bg` |
| `--color-surface-secondary` (gray-100) | `#181818` | 侧栏 / 右侧面板 |
| `--color-surface-elevated` (gray-300) | `#303030` | 输入台 / 卡片 / hover |
| `--color-surface-elevated-secondary` (gray-400) | `#414141` | 二级抬升 |
| `--text-primary` (gray-900) | `#ededed` | 正文 |
| `--text-secondary` (gray-700) | `#afafaf` | 次要文字 |
| `--border` (gray-300) | `#303030` | 描边 |
| `--radius-xs…4xl` | `4/6/8/10/12/16/20/24` | 圆角梯度（按钮 10、弹窗 12、气泡 16、输入台 24） |
| `--text-base` + 行高 | `14px` / `1.5` | 正文 |
| `--text-2xl` | `36px` | 空态大标题 |
| `--font-sans-default` | `-apple-system, BlinkMacSystemFont, "Segoe UI"` | 字体栈（Windows 上就是系统字体，**字体这块能完全对齐**） |
| `--shadow-card` | `0 4px 16px 0 #0000000d` | 卡片阴影 |

## 二、组件几何（这一轮新量到的）

| 它的令牌 | 实测值 | 我们用在哪 |
|---|---|---|
| `--height-titlebar` = spacing×11 | **44px** | 顶部标题栏（原先我估 38px） |
| `--height-toolbar` | **46px** | 会话头 / 右侧面板头（原先估 52px） |
| `--height-toolbar-pane` / `-sm` | 40px / 36px | 面板工具条 |
| `--height-token-nav-row` | **30px** | 导航行高 |
| `--height-token-row` | **36px** | 会话行 / 列表行高 |
| `--padding-row-y` / `-x` | **6px** / 8px | 列表行内边距（原先估 10/12px） |
| `--padding-toolbar` = spacing×2 | 8px | 工具条横向内边距 |
| `--padding-panel` = padding-panel-base/2 | **10px** | 面板内边距 |
| `--thread-body-inline-padding` | **10px** | 对话列左右留白（原先估 16px） |
| `--thread-content-max-width` | **768px（48rem）**，上限 `chat-max-width` 800px | 对话列宽 |
| `--thread-content-top-inset` = spacing×8 | **32px** | 会话区顶部留白 |
| `--thread-composer-bottom-inset` = spacing×4 | 16px | 输入台底部留白 |
| `--button-icon-size` | **32px** | 图标按钮尺寸（原先 30px） |
| `--icon-leading-size` | 16px | 图标尺寸 |
| `--spacing-token-button-composer` / `-sm` | 28px / 20px | 输入台内按钮 |
| `--radius-token-composer-single-line` = spacing×5.5 | 22px | 单行输入台圆角（多行走 radius-4xl=24px） |
| `--elevation-stroke-subtle` | `0 0 0 .5px …/.06` | 毛发线（我们非 HiDPI 下用 1px，见已知偏离） |

## 三、观感结果

- 对话列 768px + 两侧 10px，顶部留白 32px；
- 标题栏 44px、会话头/面板头 46px；
- 列表行 36px 高、内边距 6×8px（比之前紧凑一档）；
- 图标按钮 32px；
- 弹窗圆角 12px、内边距 20px；按钮圆角 10px、菜单 16px；
- 卡片阴影换成 `shadow-card`；正文行高 1.5（Markdown 1.6）；
- 空态：36px 大标题 + 次要色说明 + 描边式建议卡片（去掉落地页式抬升）。

## 四、三个 preset

设置 → **界面风格**：`chatgpt`（默认）/ `cyberpunk`（原青紫玻璃，逐像素保留）/ `classic`（基础配色）。切换即时生效并记住。

`cyberpunk.css` 与 `chatgpt-theme.css` 各自挂在 `:root[data-ui="…"]` 作用域下（`scripts/scope-cyberpunk.mjs` 机械转换、可重复执行），互不干扰。

## 五、验证

```powershell
Set-Location desktop
npm test                        # JS：73 项
node scripts/scope-cyberpunk.mjs --check
npm run build
npm run test:ui                 # 真实 WebView2：30 项全过、渲染错误 0
```

截图证据：`artifacts/tauri-home-test.png`（空态）、`artifacts/tauri-chat-test.png`（对话 + 工具卡 + 输入台）。

## 六、距离「100% 还原」的诚实清单

1. **图标体系**：它用自绘图标集，我们沿用 lucide —— 形状必然不同，它的图标资源也不该搬；
2. **动效**：流式光标、消息入场、过渡曲线未逐项对齐（它的令牌里没有这些时长）；
3. **它独有的功能块**：模型选择器、Projects、语音、附件托盘 —— 我们没有对应功能，硬做会是空壳；
4. **半像素毛发线**：它用 `0.5px`，我们在非 HiDPI 下用 `1px` 保证清晰（有意偏离）；
5. **仍有估计成分**：少数未以令牌暴露的间距（例如工具卡内边距、面板内部层级间距）仍是按视觉估的，要进一步逼近只能并排截图逐屏比对。

如果你要我做第 5 项：启动它的应用（只读观察、不改动），把两边窗口并排截图，逐屏量出剩余差值 —— 这是唯一还能明显提升还原度的途径。
