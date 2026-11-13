# MCP Apps 服务器资源宿主

本轮接入稳定版 `2026-01-26` MCP Apps 协议。服务器通过工具的 `_meta.ui.resourceUri` 关联 `ui://` HTML 资源，宿主读取 `text/html;profile=mcp-app`，在独立 WebView 内的沙箱 iframe 中展示，并通过 JSON-RPC postMessage 代理调用。[协议](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

## 主窗口接口

- `mcp-app-prepare {name,tool}` 返回 `{id,server,tool,uri,title,sha256,tools,domains}`。预备会话绑定实际 MCP 连接及资源内容，`tools` 为该服务器允许 App 调用的工具清单。
- `mcp-app-open {id,grantedTools,arguments,result}` 返回 `{id,label}`。工具授权默认空，用户逐项选择；初始输入和结果来自主窗口中刚完成的工具调用。
- `mcp-app-close {id}` 关闭预备或已打开的 App，会话授权随之释放。
- `widget-audit` 同时返回旧演示与真实 App 的调用审计。

## 子窗口接口

新增受窗口标签约束的 `widget_command {operation,payload}`，只允许 `identity`、`invoke`、`app-bootstrap`、`app-rpc`、`app-close`。最后一项仅关闭调用方自己的 App 窗口。身份从实际窗口反查，主窗口通用命令仍执行原有 main-only 校验。

`app-bootstrap` 返回展示来源与本窗口专属资源 URL。`app-rpc {message}` 接收标准 JSON-RPC 文本，返回 `{response,notifications}`。支持 `ui/initialize`、`ui/notifications/initialized`、`ping`、授权后的同连接 `tools/call`、日志和固定窗口显示模式。未实现的方法返回协议错误。

App 完成初始化通知后，宿主依序发送 `ui/notifications/tool-input` 与 `ui/notifications/tool-result`。调用同时受用户工具授权和服务器 `_meta.ui.visibility` 约束。断开连接后旧窗口的调用失败，重新连接需重新打开 App。

## 资源与生命周期

资源以独立自定义协议提供，按请求窗口与会话 ID 校验。CSP 按资源声明的来源构建，缺省禁止外部网络及嵌套框架；iframe 仅启用脚本。来源与申请的网络域展示在授权界面。预备会话、打开窗口、消息和 HTML 大小均有边界。

HTML 支持 UTF-8 text 与 base64 blob，上限 2 MiB。来源只接受合法的 HTTP(S) origin，网络连接还可声明 WS(S)，拒绝凭据、路径、控制字符及 CSP 指令注入，并规范化国际域名。每个 App 最多 16 项在途调用，预备会话五分钟过期，总会话数上限 24。工具目录保留完整 schema，App 调用时重新核对服务端可见性。

Windows 启动时移除前端未使用的 Tauri JS path 插件，避免 WebView2 把其初始化脚本注入非特权子框架时产生异常。Rust 路径解析使用已注册的 PathResolver，文件、进程与主窗口命令继续通过原有原生接口验证。原生回归覆盖旧 widget IPC 与路径诊断。

独立 App 窗口在 MCP 面板关闭后可继续使用，从自身关闭按钮或原生窗口关闭均释放会话与授权。未提交的排队调用在传输写入或启动 HTTP 请求之前再次校验授权是否仍有效，已提交的调用可能完成，迟到响应不再转发到已关闭页面。宿主在关闭时尽力执行资源 teardown。旧内置演示保留回归覆盖，并修正其原生 IPC 接线。

stdio 的请求期限同时覆盖写入与响应。写入超时关闭可能只写了一部分的连接，断开先结束子进程以中断阻塞写入，后续显式用户操作可建立新连接。App 会话始终绑定原连接。

工具传输失败向 App 返回安全错误，底层 stderr 与异常链仅保留在主窗口可读的宿主审计中，避免把宿主诊断信息交给服务器 HTML。

## 当前能力边界

入口位于桌面 MCP 调试区，调用带“App 界面”的工具后打开资源授权面板。App 当前可用初始化、ping、日志、固定窗口模式及授权后的 tools/call。资源读取代理、聊天消息/上下文更新、外部链接和相机等浏览器权限尚未公开。服务端 HTML 在用户选择打开后加载，按声明的 CSP 来源请求网络。

## 验收

- stdio 与 HTTP 夹具返回真实工具元数据和 HTML 资源，验证协商、资源类型/内容/CSP、授权、可见性、断线、窗口关闭及初始化顺序。
- 浏览器验证 postMessage 来源检查、默认拒绝、真实工具结果及旧演示兼容。
- 真实 WebView2 通过服务器资源打开独立窗口，在 iframe 内完成初始化、接收工具结果、调用已授权工具并清理窗口。
