# Antigravity CLI 后端

桌面进程通过官方 `agy acp` / ACP v1 stdio 接入。凭据和订阅由官方 CLI 管理；Pi RPC 会话与 ACP 会话互相独立。界面新增 Antigravity 主区入口，保留 Pi 的草稿、会话与后台状态。

## 桥接契约

主窗口 `pi_command` 增加 `antigravity` 操作，payload.action：

- `status`：当前连接、会话、配置、消息、工具与待处理权限。
- `connect`：`cwd`，可选 `executable`；初始化 ACP 并创建会话。
- `new` / `load`：当前工作区创建新会话，或按 `sessionId` 恢复官方会话。
- `list`：列出当前工作区的官方会话。
- `prompt`：`text`，可选图片；立即返回，输出经独立事件流推送。
- `cancel`：取消当前 ACP 任务，待处理权限回 cancelled；超时终止受管理的进程树。
- `configure`：`configId` / `value`，只接受服务器当前列出的合法值，空闲时设置。
- `permission`：桌面生成的权限 `id`，可选 `optionId`；校验属于当前连接/会话/请求，未选视为取消。
- `disconnect`：取消任务并关闭本桌面创建的 ACP 进程树。

ACP 事件经主窗口既有 Channel 传输，envelope 标记 `engine: antigravity`，与 Pi generation 事件分流；更新含单调 revision，避免响应/事件乱序覆盖。客户端不宣告文件系统或终端能力；未知服务端请求返回方法不支持，权限默认不自动批准。

## 生命周期与存储

运行中禁止切换工作区、会话或配置；可切回 Pi 查看，ACP 任务继续运行。关窗确认包含 ACP 忙碌状态。子进程附加 Windows Job，退出/取消超时/桌面崩溃均清理所属进程树。

官方 CLI 发现位置为 `%LOCALAPPDATA%/agy/bin/agy.exe`，允许在界面选择其它安装路径；启动参数为固定 `acp`，不拼 shell。读取 Windows HTTP/HTTPS 系统代理并传给该子进程，回环地址绕过代理。

桌面保存 Antigravity 消息显示缓存到独立数据子目录；恢复优先用官方 resume，避免重复重放。没有本机显示缓存时使用官方 load（如服务器支持），可能受 CLI 历史重放能力限制。原始会话始终由官方 CLI 持有。测试使用独立 ACP fixture，不读取真实凭据或模型。

## 使用

1. 先在本机官方 CLI 完成一次登录。
2. 桌面侧栏点 Antigravity，再点“连接已有登录”。安装路径不同可展开连接设置选择 agy.exe。
3. 在模型与推理面板选择官方 CLI 返回的选项，输入文字/添加附件后发送；权限弹窗根据具体命令或文件操作选择允许/拒绝。
4. “返回 Pi”保留原 Pi 草稿和会话；历史下拉、新会话和断开只操作 Antigravity。

## 当前边界

- 只使用标准 ACP 文本/图片提示、配置、工具/权限和会话能力；不提供客户端通用文件系统、终端或浏览器宿主能力，不渲染远程 HTML/artifact 小组件。
- ACP 文件链接暂显示为路径，不路由到 Pi 的工作区预览，避免不同工作区时打开错误文件。
- 官方会话历史保留在 CLI。桌面显示缓存上限 16 MiB，超过时提示保存失败而不截断当前输出。中断后可能只有已保存片段，界面会尝试官方 load 并显示未重放提示，不自动重发模型请求。
- 会话列表当前展示 CLI 返回的第一页。后台任务不支持 steering/队列；可以继续编辑下一条草稿，等待当前任务结束或停止后发送。
- 文本草稿按独立 session key 存储；未发送附件仅在当前应用生命周期内按会话保留，重启需重新添加。
- Pi 的技能/子代理/MCP/压缩设置不会自动迁移给 Antigravity。已有 CLI 配置、订阅可用模型、配额与鉴权由官方 CLI 决定。
- 默认测试使用纯本地 ACP fixture。可显式运行 `cargo test --no-default-features --test antigravity installed_official_cli -- --ignored --nocapture` 验证本机握手/配置/恢复；设置 `PI_DESKTOP_ACP_MODEL_TEST=1` 会额外运行一次真实的只读任务，消耗 CLI 对应的模型用量。

官方参考：https://antigravity.google/docs/ide/extensions/acp/ ，https://agentclientprotocol.com/protocol/v1/initialization
