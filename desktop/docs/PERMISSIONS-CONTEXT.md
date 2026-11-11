# 输入栏权限与上下文（0.7.0）

权限入口提供请求批准、帮我批准、完全访问、自定义；模型旁的圆环悬停显示上下文，点击可固定信息卡。显示策略与数值来自各自后端，不把 Pi 数据用于 Antigravity，也不把累计会话 tokens 当作当前上下文。

## Pi 工具授权

Pi 的 `tool_call` 扩展钩子在工具执行前向原生宿主请求判断。原生内存策略是权威来源，SDK 不根据可编辑 JSON 决定是否放行。主会话和受管理的子代理均显式加载此扩展，连接时校验命令注册路径；加载失败则停止连接，不发送模型请求。

- 请求批准：允许工作区内的内置只读工具，其余调用逐次确认。
- 帮我批准：额外自动允许工作区常规文件编辑；命令、联网/MCP、未知工具和外部路径仍确认。
- 完全访问：跳过桌面工具确认；仍受该进程账户和 Pi 工具可用性的限制，子代理角色白名单不会扩大。
- 自定义：可配置工具名称/末尾 `*` 的允许与禁止规则，以及工作区编辑/外部读取；禁止优先，其余请求确认。非完全访问时，宿主配置与 Pi 设置目录、`.git/.pi/.codex` 编辑不自动放行。

路径在宿主校验，处理父目录、盘符和链接；未知路径语法不会被视为工作区内访问。命令和工具实现内部的行为不能仅靠文件路径推断；显式自动允许命令/自定义工具也会允许它自己的后续行为。这里是工具授权层，不是 OS 沙箱，不能约束恶意已安装扩展、其他进程或已获准命令内部的任意操作。

原生队列按来源关联 RPC、工作区和 owner 票据。停止/新任务使旧票据失效，写入授权响应时在串行写锁内再次校验；已经提交写入的授权不能撤回。子代理请求还绑定原始 RPC 实例，避免旧进程回复作用于新任务。请求拒绝、关闭、超时、失联均不放行；回复失败会保留或重新读取待批状态，允许原位重试。

自定义规则保存到桌面数据目录的 `agents/permissions/permissions.json`。权限档位不保存，重新启动默认请求批准。GUI 保存并启用规则后即时生效，不改 Pi 全局信任或 MCP 配置。手工修改文件需重新启动后在自定义菜单保存/启用。

## Antigravity 授权

请求批准逐次处理官方 CLI 发来的权限请求；帮我批准自动允许请求中可确认位于工作区的常规读写；自定义按工具类别/名称规则处理这些请求。自动放行只选择 `allow_once`，不会替用户选择范围更广的 `allow_always`；未知或不完整信息继续询问，禁止规则无匹配拒绝选项时返回 cancelled。

这三项是客户端对 CLI 授权请求的处理策略，不替换 CLI 自身的全局规则，不能阻止 CLI 已经自行允许且未发起请求的操作。完全访问使用官方 `--dangerously-skip-permissions`，切换该档需重启并恢复原会话；其他策略切换不重启 CLI。规则保存到 `antigravity/permission-rules.json`，档位重新启动后恢复请求批准。

## 上下文数值

- Pi：优先读取 `get_session_stats.contextUsage`，SDK `ctx.getContextUsage()` 通知用于推送与后备。它包含最近回复用量及尾部消息估算，卡片标明“含估算”；SDK 没有报告 used 时保留未知。周期刷新读取轻量状态/统计，不重新枚举模型或历史。
- Antigravity：接收官方 ACP `usage_update` 的 `used` 和 `size`；费用只有服务端提供时才显示，且标为会话费用。未报告时显示等待，不从消息长度、模型名称或累计账单推算百分比。
- 模型切换清除旧 ACP 用量；历史缓存中的用量标为上次统计。新会话、缺失、非法/过大数值不会伪装为零。压缩中显示状态，压缩结束等待新的 Pi 统计；不会用压缩历史的 `estimatedTokensAfter` 冒充当前 live usage。
- 圆环按窗口占用绘制，卡片显示已用/剩余百分比、已用/窗口 tokens。Pi 点击“压缩设置与历史”连接现有真实压缩功能；Antigravity 左侧上下文入口显示自身信息，不切到 Pi 数值。

## 契约与证据

Pi 1.5.0 随附 `docs/extensions.md` 的 `tool_call`、`ctx.getContextUsage()`，以及 `docs/rpc-extension-ui.md`、`docs/rpc-commands.md`。官方文档说明 RPC 中 `ctx.hasUI=true`，`contextUsage` 为当前窗口估算，累计 `tokens/cost` 则覆盖整个会话与压缩等调用。

[Antigravity ACP](https://antigravity.google/docs/ide/extensions/acp/)、[官方 changelog](https://antigravity.google/docs/changelog)（1.4.0 引入 usage_update）、[ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema)。

回归入口：`npm test`、`npm run test:rust`、带 test-fixture 的 `tests/permissions.rs`、`npm run test:ui`。真实 Pi 门与策略查询可显式运行 ignored `installed_pi_main_and_child_load_real_gate`，不调用模型；最终结果见 VERIFICATION.md。
