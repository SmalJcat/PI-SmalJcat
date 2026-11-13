# MCP Apps 服务器资源宿主

本轮接入稳定版 `2026-01-26` MCP Apps 协议。服务器通过工具的 `_meta.ui.resourceUri` 关联 `ui://` HTML 资源，宿主读取 `text/html;profile=mcp-app`，在独立 WebView 内的沙箱 iframe 中展示，并通过 JSON-RPC postMessage 代理调用。[协议](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

## 主窗口接口

- `mcp-app-prepare {name,tool}` 返回 `{id,server,tool,uri,title,sha256,tools,domains}`。预备会话绑定实际 MCP 连接及资源内容，`tools` 为该服务器允许 App 调用的工具清单。
- `mcp-app-open {id,grantedTools,allowResources?,allowMessages?,arguments,result}` 返回 `{id,label}`。工具授权默认空，资源读取和对话消息默认关闭，用户选择后打开窗口；初始输入和结果来自主窗口中刚完成的工具调用。
- `mcp-app-close {id}` 关闭预备或已打开的 App，会话授权随之释放。
- `widget-audit` 同时返回旧演示与真实 App 的调用审计。

## 资源代理增量契约

`mcp-app-open` 接受可选布尔字段 `allowResources`，省略时为 `false`，返回结构为 `{id,label}`。授权面板提供“允许 App 读取此服务器的资源”复选框，默认关闭。此授权覆盖原 MCP 连接提供的资源 URI，关闭窗口后释放。

授权后，`ui/initialize` 的响应声明 `hostCapabilities.serverResources = {}`，App 可发送标准 `resources/read {uri}` 请求。响应原样返回 MCP `ReadResourceResult`，包含完整的 text/blob、URI、MIME 与服务端元数据。单次 JSON 结果上限为 256 KiB，超过时返回错误。

请求要求已完成初始化、资源授权有效且原连接存活，URI 必须为长度不超过 4096 字节的非空绝对 URI。请求与工具调用共享 16 项在途上限及 ID 去重。传输提交前与结果返回前核对窗口许可，服务器断开重连后旧窗口失效，底层诊断链写入主窗口宿主审计。资源目录变更通知、订阅和模型上下文更新另行扩展。

## 对话消息增量契约

`mcp-app-open` 接受可选布尔字段 `allowMessages`，默认 `false`，返回结构为 `{id,label}`。授权面板显示“允许 App 向此 Pi 对话发送消息”，并说明发送会触发 Pi 回复、可能产生模型费用。开启时由原生宿主捕获当前 Pi 连接代次、会话 ID 与消息编辑代次，绑定到本次 App 窗口。

获准的窗口可提交 `ui/message {role:"user",content:[{type:"text",text:string}]}`，兼容稳定版示例中的单个 text 对象。文本块按顺序连接，空文本与其他内容类型返回错误。初始化响应声明 `hostCapabilities.message = {text:{}}`，成功响应为 `{}`。消息带上宿主生成的服务器与工具来源标记，经原有 Pi prompt 路径进入对话并产生回复。

文本块数组及 message.text 能力声明与当前官方 SDK 类型一致。[SDK 类型](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/spec.types.ts)

请求要求 App 完成初始化、原 MCP 连接与 Pi 绑定有效，且 Pi 空闲。与 App 工具/资源请求共享在途上限和 ID 去重。会话切换、Pi 重连或通过桌面编辑历史消息后，需重新打开并授权 App。提交到 Pi 串行写入队列前核对窗口许可，已提交消息可继续执行。失败详情留在主窗口宿主审计。主输入框草稿独立于 App 发送。

Core 新增绑定对象的创建与发送方法，在现有操作锁内核对会话代次、编辑代次及会话 ID，复用普通 prompt 的会话保护和工具权限。正式包 App 专项使用隔离 Pi 配置及本机 OpenAI 兼容服务完成回复，回执记录本机提供方请求数和选用的提供方。未观测的外部请求数以 null 表示。

## 模型上下文增量契约

`codex/mcp-app-model-context` 为 `mcp-app-open` 增加可选布尔字段 `allowModelContext`，默认 false，返回结构为 `{id,label}`。授权面板显示“允许 App 为此 Pi 对话提供模型上下文”，说明内容用于后续模型请求、可能增加用量。该授权独立于消息发送授权，绑定打开时的 Pi 连接、会话和编辑代次。

获准后声明 `hostCapabilities.updateModelContext = {text:{},structuredContent:{}}`，接受 `ui/update-model-context {content?:TextContent[],structuredContent?:object}`，成功返回 `{}`。同一 App 的有效更新依次覆盖，空对象清除该 App 的上下文。请求沿用 64 KiB 消息上限及在途/ID 限制，更新本身只校验会话和保存内存状态。

后续普通用户发送和 App 消息都会在 Pi 的 context 事件中读取此会话全部有效 App 的最新快照，以带来源标记的临时消息加入模型输入。上下文不会作为额外消息写入会话历史。窗口关闭、原 MCP 连接断开、Pi 切换/重连或桌面历史编辑后，后续快照排除旧上下文。已选入在途模型请求的快照可继续使用。

复用已有带令牌的扩展通道，Pi 发出 `extension_ui_request {method:"input",title:"PI_DESKTOP_APP_CONTEXT",placeholder:JSON.stringify({token,sessionId})}`，原生宿主返回 `{contexts:[{id,source,content?,structuredContent?,timestamp}]}`。通道按活动 Pi 连接代次、令牌、会话和 App 授权核验，内部查询在宿主处理。

## 子窗口接口


新增受窗口标签约束的 `widget_command {operation,payload}`，只允许 `identity`、`invoke`、`app-bootstrap`、`app-rpc`、`app-close`。最后一项仅关闭调用方自己的 App 窗口。身份从实际窗口反查，主窗口通用命令仍执行原有 main-only 校验。

`app-bootstrap` 返回展示来源与本窗口专属资源 URL。`app-rpc {message}` 接收标准 JSON-RPC 文本，返回 `{response,notifications}`。支持 `ui/initialize`、`ui/notifications/initialized`、`ping`、授权后的 `tools/call`、`resources/read`、`ui/message`、日志和固定窗口显示模式。未实现的方法返回协议错误。

App 完成初始化通知后，宿主依序发送 `ui/notifications/tool-input` 与 `ui/notifications/tool-result`。调用同时受用户工具授权和服务器 `_meta.ui.visibility` 约束。断开连接后旧窗口的调用失败，重新连接需重新打开 App。

## 资源与生命周期

资源以独立自定义协议提供，按请求窗口与会话 ID 校验。CSP 按资源声明的来源构建，缺省禁止外部网络及嵌套框架；iframe 仅启用脚本。来源与申请的网络域展示在授权界面。预备会话、打开窗口、消息和 HTML 大小均有边界。

HTML 支持 UTF-8 text 与 base64 blob，上限 2 MiB。来源只接受合法的 HTTP(S) origin，网络连接还可声明 WS(S)，拒绝凭据、路径、控制字符及 CSP 指令注入，并规范化国际域名。每个 App 最多 16 项在途调用，预备会话五分钟过期，总会话数上限 24。工具目录保留完整 schema，App 调用时重新核对服务端可见性。

Windows 启动时移除前端未使用的 Tauri JS path 插件，避免 WebView2 把其初始化脚本注入非特权子框架时产生异常。Rust 路径解析使用已注册的 PathResolver，文件、进程与主窗口命令继续通过原有原生接口验证。原生回归覆盖旧 widget IPC 与路径诊断。

独立 App 窗口在 MCP 面板关闭后可继续使用，从自身关闭按钮或原生窗口关闭均释放会话与授权。未提交的排队调用在传输写入或启动 HTTP 请求之前再次校验授权是否仍有效，已提交的调用可能完成，迟到响应不再转发到已关闭页面。宿主在关闭时尽力执行资源 teardown。旧内置演示保留回归覆盖，并修正其原生 IPC 接线。

stdio 的请求期限同时覆盖写入与响应。写入超时关闭可能只写了一部分的连接，断开先结束子进程以中断阻塞写入，后续显式用户操作可建立新连接。App 会话始终绑定原连接。

工具传输失败向 App 返回安全错误，底层 stderr 与异常链仅保留在主窗口可读的宿主审计中，避免把宿主诊断信息交给服务器 HTML。

## 当前能力边界

入口位于桌面 MCP 调试区，调用带“App 界面”的工具后打开授权面板。App 可在授权后调用 tools/call、resources/read 和向绑定的 Pi 对话发送文本 ui/message。资源授权覆盖该连接提供的任意 URI，单次 JSON 上限 256 KiB。模型上下文更新、外部链接和相机等浏览器权限尚未公开。服务端 HTML 在用户选择打开后加载，按声明的 CSP 来源请求网络。

## 验收

- stdio 与 HTTP 夹具返回真实工具元数据和 HTML 资源，验证协商、资源类型/内容/CSP、授权、可见性、断线、窗口关闭及初始化顺序。
- 浏览器验证 postMessage 来源检查、默认拒绝、真实工具结果及旧演示兼容。
- 资源代理验证授权能力声明、原样 text/blob、stdio 写入排队时撤销许可、共享并发上限/ID、关闭后的迟到结果丢弃、重连后旧窗口失效，以及诊断隐私和超限拒绝。
- 真实 WebView2 通过服务器资源打开独立窗口，在 iframe 内完成初始化、接收工具结果、调用已授权工具并清理窗口。
- `npm run test:release -- -AppsOnly` 对暂存的正式程序运行同一 App 全链路检查，使用真实 Pi、临时配置和本地 MCP 服务。正式程序保持单实例，验收前需退出已有 Pi Desktop。
