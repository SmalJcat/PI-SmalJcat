// MCP 夹具服务器（仅测试用）：在 stdin/stdout 上实现最小 JSON-RPC，用来端到端验证桌面端 MCP 客户端。
// 不依赖任何外部运行时，也不访问网络。
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();
    let content_only = std::env::args().any(|arg| arg == "--content-only");
    let apps = std::env::args().any(|arg| arg == "--apps");
    if std::env::args().any(|arg| arg == "--diagnostic-secret") {
        eprintln!("HOST_DIAGNOSTIC_SECRET fixture-only");
    }
    let mut supports_apps = false;
    let capabilities = if content_only {
        json!({"resources": {}, "prompts": {}})
    } else {
        json!({"tools": {"listChanged": true}, "resources": {}, "prompts": {}})
    };
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let method = message["method"].as_str().unwrap_or_default().to_owned();
        if method == "initialize" {
            supports_apps = message["params"]["capabilities"]["extensions"]
                ["io.modelcontextprotocol/ui"]["mimeTypes"]
                .as_array()
                .is_some_and(|types| {
                    types
                        .iter()
                        .any(|value| value == "text/html;profile=mcp-app")
                });
        }
        let id = message.get("id").cloned();
        let Some(id) = id else {
            // notification：夹具只需忽略
            continue;
        };
        if content_only && method.starts_with("tools/") {
            writeln!(writer, "{}", json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32601,"message":"tools unavailable"}})).ok();
            writer.flush().ok();
            continue;
        }
        let result = match method.as_str() {
            "initialize" => json!({
                "protocolVersion": message["params"]["protocolVersion"].clone(),
                "capabilities": capabilities,
                "serverInfo": { "name": "mcp-fixture", "version": "1.0.0" },
            }),
            "tools/list" if apps && supports_apps => json!({"tools":[
                {"name":"app_view","description":"显示服务器 App","inputSchema":{"type":"object"},
                    "_meta":{"ui":{"resourceUri":"ui://fixture/app"}}},
                {"name":"app_refresh","description":"刷新 App 数据","inputSchema":{"type":"object"},
                    "_meta":{"ui":{"visibility":["app"]}}},
                {"name":"app_failure","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]}}},
                {"name":"model_only","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["model"]}}},
                {"name":"echo","inputSchema":{"type":"object"}},
                {"name":"bad_mime","inputSchema":{"type":"object"},"_meta":{"ui":{"resourceUri":"ui://fixture/bad-mime"}}},
                {"name":"missing_app","inputSchema":{"type":"object"},"_meta":{"ui":{"resourceUri":"ui://fixture/missing"}}}
                ,{"name":"large_schema","inputSchema":{"type":"object","properties":{"large":{"type":"string","description":"x".repeat(9000)}}},
                    "_meta":{"ui":{"resourceUri":"ui://fixture/app"}}}
            ]}),
            "tools/list" => json!({ "tools": [
                { "name": "echo", "description": "回显输入文本", "inputSchema": {
                    "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } },
                { "name": "add", "description": "整数相加", "inputSchema": {
                    "type": "object", "properties": { "a": { "type": "integer" }, "b": { "type": "integer" } }, "required": ["a", "b"] } },
                { "name": "fail", "description": "总是失败", "inputSchema": { "type": "object", "properties": {} } },
            ] }),
            "resources/list" => {
                if message["params"].get("cursor").is_some() {
                    json!({"resources":[{"uri":"fixture://binary","name":"binary","mimeType":"application/octet-stream"}]})
                } else {
                    json!({"resources":[{"uri":"fixture://hello","name":"hello","mimeType":"text/plain"}],"nextCursor":"下一页+/="})
                }
            }
            "resources/templates/list" => {
                if message["params"].get("cursor").is_some() {
                    json!({"resourceTemplates":[]})
                } else {
                    json!({"resourceTemplates":[{"uriTemplate":"fixture://{name}","name":"named"}],"nextCursor":"templates-2"})
                }
            }
            "resources/read" => match message["params"]["uri"].as_str().unwrap_or_default() {
                "ui://fixture/app" if apps => json!({"contents":[{
                    "uri":"ui://fixture/app","mimeType":"text/html;profile=mcp-app",
                    "text":include_str!("../../../tests/fixtures/mcp-app.html"),
                }]}),
                "ui://fixture/bad-mime" if apps => json!({"contents":[{
                    "uri":"ui://fixture/bad-mime","mimeType":"text/plain","text":"invalid",
                }]}),
                "fixture://hello" => {
                    json!({"contents":[{"uri":"fixture://hello","mimeType":"text/plain","text":"你好🙂 MCP resource"}]})
                }
                "fixture://binary" => {
                    json!({"contents":[{"uri":"fixture://binary","mimeType":"application/octet-stream","blob":"AAEC"}]})
                }
                "fixture://oversized" => {
                    json!({"contents":[{"uri":"fixture://oversized","text":"x".repeat(256 * 1024)}]})
                }
                "fixture://malformed" => json!({"contents":"invalid"}),
                "fixture://failure" if apps => std::process::exit(9),
                _ => {
                    writeln!(writer, "{}", json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32002,"message":"Resource not found"}})).ok();
                    writer.flush().ok();
                    continue;
                }
            },
            "prompts/list" => {
                if message["params"].get("cursor").is_some() {
                    json!({"prompts":[]})
                } else {
                    json!({"prompts":[{"name":"greet","description":"Greeting","arguments":[{"name":"name","required":true}]}],"nextCursor":"prompts-2"})
                }
            }
            "prompts/get" => {
                if message["params"]["name"] != "greet"
                    || !message["params"]["arguments"]["name"].is_string()
                {
                    writeln!(writer, "{}", json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32602,"message":"Invalid prompt or missing name"}})).ok();
                    writer.flush().ok();
                    continue;
                }
                json!({"description":"Greeting", "messages":[{"role":"user","content":{"type":"text","text":format!("Hello {}",message["params"]["arguments"]["name"].as_str().unwrap())}}]})
            }
            "tools/call" => {
                let name = message["params"]["name"].as_str().unwrap_or_default();
                let arguments = &message["params"]["arguments"];
                match name {
                    "app_failure" if apps => std::process::exit(9),
                    "app_view" | "app_refresh" if apps => json!({
                        "content":[{"type":"text","text":"App server result"}],
                        "structuredContent":{"count":arguments["count"].as_i64().unwrap_or(1)},
                        "_meta":{"source":"real-stdio-fixture"},
                    }),
                    "echo" => {
                        json!({ "content": [{ "type": "text", "text": arguments["text"].as_str().unwrap_or_default() }] })
                    }
                    "add" => {
                        let a = arguments["a"].as_i64().unwrap_or_default();
                        let b = arguments["b"].as_i64().unwrap_or_default();
                        json!({ "content": [{ "type": "text", "text": format!("{}", a + b) }], "structuredContent": { "sum": a + b } })
                    }
                    "fail" => {
                        json!({ "content": [{ "type": "text", "text": "夹具故意失败" }], "isError": true })
                    }
                    other => {
                        let response = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": format!("未知工具 {other}") } });
                        writeln!(writer, "{response}").ok();
                        writer.flush().ok();
                        continue;
                    }
                }
            }
            other => {
                let response = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("未知方法 {other}") } });
                writeln!(writer, "{response}").ok();
                writer.flush().ok();
                continue;
            }
        };
        let response = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        writeln!(writer, "{response}").ok();
        writer.flush().ok();
    }
}
