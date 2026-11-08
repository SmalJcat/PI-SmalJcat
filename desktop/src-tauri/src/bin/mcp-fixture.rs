// MCP 夹具服务器（仅测试用）：在 stdin/stdout 上实现最小 JSON-RPC，用来端到端验证桌面端 MCP 客户端。
// 不依赖任何外部运行时，也不访问网络。
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let method = message["method"].as_str().unwrap_or_default().to_owned();
        let id = message.get("id").cloned();
        let Some(id) = id else {
            // notification：夹具只需忽略
            continue;
        };
        let result = match method.as_str() {
            "initialize" => json!({
                "protocolVersion": message["params"]["protocolVersion"].clone(),
                "capabilities": { "tools": { "listChanged": true } },
                "serverInfo": { "name": "mcp-fixture", "version": "1.0.0" },
            }),
            "tools/list" => json!({ "tools": [
                { "name": "echo", "description": "回显输入文本", "inputSchema": {
                    "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } },
                { "name": "add", "description": "整数相加", "inputSchema": {
                    "type": "object", "properties": { "a": { "type": "integer" }, "b": { "type": "integer" } }, "required": ["a", "b"] } },
                { "name": "fail", "description": "总是失败", "inputSchema": { "type": "object", "properties": {} } },
            ] }),
            "tools/call" => {
                let name = message["params"]["name"].as_str().unwrap_or_default();
                let arguments = &message["params"]["arguments"];
                match name {
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
