# MCP resources/prompts 接口契约

本轮在独立分支 `feature/mcp-resources-prompts` 实现，当前仍为 0.7.1 开发增量，尚未打包部署。

## 请求与响应

所有操作通过现有 `pi_command`，`name` 始终为 mcp.json 服务器名。

- `mcp-connect {name}` → `{server}`：只完成握手，server 增加 `capabilities`，不强制请求 tools/list。
- `mcp-resources {name,cursor?}` → `{server,resources,nextCursor?}`。
- `mcp-resource-templates {name,cursor?}` → `{server,resourceTemplates,nextCursor?}`。
- `mcp-resource-read {name,uri}` → `{server,uri,result:{contents,...}}`。
- `mcp-prompts {name,cursor?}` → `{server,prompts,nextCursor?}`。
- `mcp-prompt-get {name,prompt,arguments?}` → `{server,prompt,result:{messages,...}}`；arguments 只允许字符串值。

列表每次读取一页，不缓存资源/提示词，不自动遍历游标；保留服务端不透明 nextCursor。新内容请求遵循服务器 timeout，错误直接返回，不自动重放。未声明对应能力时拒绝请求。列表页和内容结果超过 256 KiB 明确报错，不截断 URI、游标、blob 或消息结构。

## 界面

桌面调试区按服务器声明的能力选择工具、资源/模板、提示词。资源可按具体 URI 读取；模板展示原模板并要求填写具体 URI。提示词展示参数说明及必填标记，校验字符串参数后获取消息。文本作为文本显示，二进制仅展示 MIME 与大小说明；不执行资源中的 HTML/脚本，不自动发送提示词给模型。

本轮提供真实服务器资源读取的前置能力，MCP Apps WebView 的真实第三方资源渲染与能力绑定另行实现。

## 验证

- Windows CI 增加确定性 Chromium 侧栏/MCP 回归、fixture Rust 测试与 loopback NO_PROXY。
- stdio 与 HTTP 协议测试覆盖无 tools 服务器、分页、模板、文本/blob、prompt 参数、错误与超限。
- 浏览器交互回归验证实际面板操作、分页、参数校验、失败反馈、能力切换及旧响应隔离。
- 本机 TypeScript/Vite、JS 120 项、Rust 167/169 项、fmt/Clippy、原生 WebView2 67 项通过；详见 [验收记录](../VERIFICATION.md)。远端 Actions 与真实远程服务尚未运行。

```powershell
npm run build
npm test
npm run test:sidebar
npm run test:mcp:browser
$env:NO_PROXY = '127.0.0.1,localhost,::1'
npm run test:rust
npm run test:rust:fixture
npm run test:ui
```

浏览器专项在 CI 使用 `npx playwright install chromium` 安装的 Chromium，本机默认沿用可用 Edge/Chrome；设置 `CI=true` 可核验与 CI 相同的浏览器路径。原生验收使用独立临时数据与配置，不连接真实模型。
