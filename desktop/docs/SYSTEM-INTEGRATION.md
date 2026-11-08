# 系统集成：开机自启 / 关闭到托盘 / 完成通知

三项都从 ChatGPT 设置里挑出来的、**有真实逻辑**的系统级功能；每一项都在 Rust 侧落地（不只是前端开关）。

## 一、开机自启（自己实现，不引插件）

用当前用户的 Run 注册表项登记本程序：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `Pi Desktop`，命令行给路径加引号。

**关键设计：注册表路径作为参数传入**，测试使用独立的测试键 `HKCU\Software\PiDesktop\TestRun`，所以 `cargo test` 会真的写/读/删一次注册表，但**绝不触碰用户真实的开机启动项**。

对应它设置里的 "Launch at login"。应用启动时若发现偏好为开，会重新对齐一次登记（外部清理后能自愈）。

## 二、关闭到托盘

- 打开 Tauri 的 `tray-icon` 特性，托盘菜单两项：**显示主窗口 / 退出 Pi Desktop**；左键点图标也显示窗口；
- 托盘**只在偏好开启时于启动时创建**（默认关闭）；
- 关闭请求的处理顺序：`closing`（正在退出）→ **关闭到托盘（隐藏窗口）** → 运行中任务确认对话框 → 退出；
- 从托盘菜单退出会先打上 "真的退出" 标记，否则关闭逻辑会把窗口又藏起来；
- 状态放在独立的 `SystemFlags`（`close_to_tray` / `quitting` 两个原子布尔）里，**没有改动既有 `DesktopState` 的构造**，降低回归面。

**默认关闭是硬约束**：验收用例断言应用能干净退出，默认开启托盘会导致进程不退出、整轮失败。这与上一轮"新增偏好的默认值必须等于原有行为"是同一条教训。

## 三、任务完成通知

- 后端：`tauri-plugin-notification`（2.8.0），`capabilities/main.json` 增加 `notification:default`；
- 命令 `system-notify`：**是否发送由 Rust 读取偏好决定**，前端不重复判断；
- 触发点：任务从运行变为结束时，**仅当窗口不在前台**才发送（`document.hasFocus()`），避免看着屏幕还被弹窗打扰；
- 设置里提供 "发送测试通知" 按钮，失败会明确提示。

## 四、设置界面

新增左栏 **系统** 分区（3 项开关）：开机自启 / 关闭时最小化到托盘 / 任务完成通知，外加测试通知按钮。三项都存在 Pi 自己的偏好文件里（`profile/preferences.json`），因此**应用重启后仍然有效**。

## 五、补上的端到端断言（这一轮的另一半任务）

之前验收只打开设置的默认分区，外观分区的控件没有运行时断言。现在补上了：

```js
await nav.getByRole('button', { name: '外观', exact: true }).click();
assert.equal(await page.locator('.pref-row').count(), 9);
await 点击「大」;  assert.equal(await rootVar('--type-scale'), '1.14');
await 点击「窄」;  assert.equal(await rootVar('--chat-width'), '640px');
await 点击「圆润」; assert.equal(await rootVar('--radius-scale'), '1.4');
await 点击「关闭」; assert.equal(document.documentElement.dataset.motion, 'off');
await 点击「宽松」; assert.equal(await rootVar('--reading-line'), '1.9');
// 逐项复位后再验证一次
```

也就是**9 项控件的每一项都验证"点了真的改到根元素变量"**，而不是只看控件存在。系统分区同样断言有 3 项。验收项从 30 涨到 **31**。

## 六、验证

```powershell
Set-Location desktop
npm test                                    # JS：84 项
npm run build
npm run test:rust                           # Rust：lib 74 项（新增 3 项注册表测试）+ 集成测试
node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run test:ui                             # 真实 WebView2：31 项全过、渲染错误 0
```

## 七、验证缺口（诚实说明）

1. **托盘没有端到端断言**：验收跑在默认偏好（关闭托盘）下，所以只证明了"不开启时不破坏退出"；开启托盘后的隐藏/显示行为只有单元级保证（状态机）与代码审查；
2. **通知没有端到端断言**：系统 toast 在 CI 里不可判定（可能被系统静音、专注助手拦截），所以只验证了命令路径与"未开启时不发送"；其中"无焦点才通知"这一分支没有断言；
3. **系统三项开关在验收里只读不点**：避免真的写注册表 Run 项、也不在测试运行期间创建托盘图标。这三项的写入逻辑由 Rust 单元测试（测试键）覆盖。

## 八、这一轮的自伤记录

1. **JS-in-JS 转义翻车两次**：我试图用 `run_code` 生成临时的 `.mjs` 补丁脚本，脚本里又嵌 JavaScript 正则与引号，两次都因引号/反引号被提前截断而解析失败。**结论：改源码用结构化编辑（edit 工具 + 精确锚点），不要生成嵌套脚手本来改源码。**
2. **状态类型放错**：托盘退出标记我写在 `SystemFlags` 上，`system.rs` 却去 `DesktopState` 上取；编译器直接指出 `mark_quitting` 不存在，一次修正。
