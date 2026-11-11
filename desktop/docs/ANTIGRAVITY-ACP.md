# Antigravity CLI 后端

桌面进程通过官方 `agy acp` / ACP v1 stdio 接入。凭据和订阅由官方 CLI 管理；Pi RPC 会话与 ACP 会话互相独立。界面新增 Antigravity 主区入口，保留 Pi 的草稿、会话与后台状态。

## 桥接契约

主窗口 `pi_command` 增加 `antigravity` 操作，payload.action：

- `status`：当前连接、会话、配置、消息、工具与待处理权限。
- `connect`：`cwd`，可选 `executable`；初始化 ACP，同工作区优先恢复当前会话，无当前会话时新建。
- `connect-new`：相同连接参数，但明确跳过当前会话并新建；先保存原会话缓存，不删除原历史或草稿。
- `new` / `load`：当前工作区创建新会话，或按 `sessionId` 恢复官方会话。
- `list`：列出当前工作区的官方会话。
- `prompt`：`text`，可选图片；立即返回，输出经独立事件流推送。
- `cancel`：取消当前 ACP 任务，待处理权限回 cancelled；超时终止受管理的进程树。
- `configure`：`configId` / `value`，只接受服务器当前列出的合法值，空闲时设置。
- `set-permission-mode`：`mode` 为 `ask`、`smart`、`full-access` 或 `custom`，可附自定义 `rules`。策略只影响 CLI 发来的授权请求；完全访问使用官方启动参数。涉及完全访问的切换重连原会话，其余原地生效；收紧失败也保持所选非完全访问策略。
- `permission`：桌面生成的权限 `id`，可选 `optionId`；校验属于当前连接/会话/请求，未选视为取消。
- `disconnect`：取消任务并关闭本桌面创建的 ACP 进程树。

0.7.0 另接入 `usage_update` 的上下文 `used/size`，与可选会话费用独立；模型改变清空旧值，恢复的显示缓存标记上次统计，缺失值保持未知。权限与信息卡的详细契约见 [权限与上下文](PERMISSIONS-CONTEXT.md)。

ACP 事件经主窗口既有 Channel 传输，envelope 标记 `engine: antigravity`，与 Pi generation 事件分流；更新含单调 revision，避免响应/事件乱序覆盖。客户端不宣告文件系统或终端能力；未知服务端请求返回方法不支持，权限默认不自动批准。

## 生命周期与存储

运行中禁止切换工作区、会话或配置；可切回 Pi 查看，ACP 任务继续运行。关窗确认包含 ACP 忙碌状态。子进程附加 Windows Job，退出/取消超时/桌面崩溃均清理所属进程树。

官方 CLI 发现位置为 `%LOCALAPPDATA%/agy/bin/agy.exe`，允许在界面选择其它安装路径；启动命令为 `acp`，用户显式选择完全访问时附加官方 `--dangerously-skip-permissions`，不拼 shell。读取 Windows HTTP/HTTPS 系统代理并传给该子进程，回环地址绕过代理。权限选择不写入官方 CLI 的全局设置，不持久化到下一次桌面启动。

官方 ACP 目前只提供模型与推理配置，权限不是 `session/set_config_option` 的虚构选项。默认“按需确认”遵循 CLI 现有规则并展示其权限请求；“完全访问”通过官方参数跳过工具确认，不提供额外的 OS 沙箱。切换会关闭旧进程并恢复当前会话及可用的原模型/推理配置，期间禁止发送；失败显示错误，不自动重新发送任务。

桌面保存 Antigravity 消息显示缓存到独立数据子目录；恢复优先用官方 resume，避免重复重放。没有本机显示缓存时使用官方 load（如服务器支持），可能受 CLI 历史重放能力限制。原始会话始终由官方 CLI 持有。测试使用独立 ACP fixture，不读取真实凭据或模型。

恢复配置时，CLI 明确拒绝某个选项会显示简短提示，保留服务端当前确认的配置并继续恢复其他选项；不会因单个模型配置被拒绝而中断会话。配置请求超时或传输中断时结果未确认，关闭该连接以避免迟到响应改变当前设置；保留原历史，用户可以重试恢复或直接新建。

## 使用

1. 先在本机官方 CLI 完成一次登录。
2. 桌面侧栏点 Antigravity，再点“连接已有登录”。安装路径不同可展开连接设置选择 agy.exe。
3. 输入栏直接显示当前模型与推理档位，点击可选择官方 CLI 返回的选项；左侧选择权限，输入文字/添加附件后发送，按需确认模式下根据工具弹窗选择允许/拒绝。
4. “返回 Pi”保留原 Pi 草稿和会话；历史下拉、新会话和断开只操作 Antigravity。
5. 同工作区断开后，“恢复会话”继续原会话；旁边的“新会话”连接并创建空白会话，可绕过失效历史。

## 当前边界

- 只使用标准 ACP 文本/图片提示、配置、工具/权限和会话能力；不提供客户端通用文件系统、终端或浏览器宿主能力，不渲染远程 HTML/artifact 小组件。
- ACP 文件链接暂显示为路径，不路由到 Pi 的工作区预览，避免不同工作区时打开错误文件。
- 官方会话历史保留在 CLI。桌面显示缓存上限 16 MiB，超过时提示保存失败而不截断当前输出。中断后可能只有已保存片段，界面会尝试官方 load 并显示未重放提示，不自动重发模型请求。
- 会话列表当前展示 CLI 返回的第一页。后台任务不支持 steering/队列；可以继续编辑下一条草稿，等待当前任务结束或停止后发送。
- 文本草稿按独立 session key 存储；未发送附件仅在当前应用生命周期内按会话保留，重启需重新添加。
- Pi 的技能/子代理/MCP/压缩设置不会自动迁移给 Antigravity。已有 CLI 配置、订阅可用模型、配额与鉴权由官方 CLI 决定。
- 默认测试使用纯本地 ACP fixture。可显式运行 `cargo test --no-default-features --test antigravity installed_official_cli -- --ignored --nocapture` 验证本机握手/配置/恢复；设置 `PI_DESKTOP_ACP_MODEL_TEST=1` 会额外运行一次真实的只读任务，消耗 CLI 对应的模型用量。

官方参考：https://antigravity.google/docs/ide/extensions/acp/ ，https://agentclientprotocol.com/protocol/v1/initialization
