# 编辑重发与 Fast 修复契约

- 编辑树导航保持 `summarize:false`。当活动分支最后一个非设置条目为 `desktop-message-edit` 时，只取消发送前的 `threshold` 压缩；新消息进入分支后恢复正常阈值检查。`manual` / `overflow` 不拦截。编辑标记已持久化，因此准备后断线重连/失败重试仍生效。
- `command('set_fast_mode', {enabled:boolean, expectedSessionId:string, modelKey:string})` 通过现有 desktop-context 扩展命令设置状态；后台校验会话、模型、空闲状态、来源和会话锁。响应 `{supported,enabled,modelKey,reason?}`；快照 `state.fastMode` 使用同一扩展返回状态。
- Fast 只对已实现 `service_tier` 的 OpenAI Responses / Codex Responses / Chat Completions 传输开放。开启请求 `priority`；显式关闭请求 `default`；未设置保持原始载荷。兼容网关与账号是否接受/兑现档位由服务端决定，界面提示可能增加费用。
- 设置按活动分支、每个 provider/model 持久化为 `desktop-fast-mode` 自定义条目，不修改全局模型配置。编辑导航携带当前分支的 fast 设置到编辑标记，保留用户当前选择；恢复读取活动分支，不读取放弃分支的选择。
- 当前 Antigravity CLI 未提供已验证的 fast 配置接口，显示不可用原因；不将推理档位或模型 ID 中的 fast 当作 fast 模式。
- 验证用真实 Pi + 临时配置 + 本机模拟提供方捕获请求，不读取用户凭据、不消耗真实模型用量。扩展单测、Rust桥接及真实WebView2开关回归已通过。

## 验证与边界

`npm run test:edit-fast:contract` 使用安装的 Pi（默认 `D:/PI/pi.exe`，可通过 `PI_DESKTOP_EXECUTABLE` 指定）。临时 Chat Completions 服务器捕获 7 次本机请求，验证编辑重发不再调用摘要模型、priority/default 载荷、编辑/重连恢复、手动压缩及真正溢出后的摘要和重试。没有外部模型请求。

JavaScript 124项、Rust167/169项、格式/Clippy、真实WebView2 68项通过；详见 [验收记录](../VERIFICATION.md)。`session_before_compact` 在 Pi 发出 compaction_start 后执行，因此取消预检仍可能短暂显示压缩状态并记录 aborted；没有摘要调用。后续工具轮次达到阈值仍会正常压缩。

Fast 能力判断依据传输能否承载该参数，不代表模型或账号有优先服务资格。后端错误沿正常请求错误展示，不静默重试成标准档位。未实测远端 priority 的可用性、实际加速或计费。Antigravity 未提供已验证的对应配置接口，暂不可启用。
