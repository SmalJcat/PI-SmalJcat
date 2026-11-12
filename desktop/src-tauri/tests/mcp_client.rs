//! MCP 客户端端到端测试：用 src/bin/mcp-fixture.rs 作为真实服务器（stdio JSON-RPC）。
use pi_desktop::mcp_client::{load_servers, McpManager, McpSession, ServerConfig};
use serde_json::json;
use std::{collections::BTreeMap, fs};

fn fixture_command() -> String {
    env!("CARGO_BIN_EXE_mcp-fixture").to_owned()
}

fn fixture_config(args: Vec<String>) -> ServerConfig {
    ServerConfig {
        name: "fixture".into(),
        command: Some(fixture_command()),
        args,
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
        enabled: true,
        timeout: Some(30),
        exposure: None,
    }
}

fn write_config(dir: &std::path::Path, entries: serde_json::Value) {
    fs::write(
        dir.join("mcp.json"),
        serde_json::to_vec(&json!({ "mcpServers": entries })).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn session_handshakes_lists_and_calls_tools() {
    let session = McpSession::connect(fixture_config(vec![])).await.unwrap();
    assert_eq!(session.name, "fixture");
    assert_eq!(session.server_info()["name"], "mcp-fixture");
    assert_eq!(session.server_info()["version"], "1.0.0");
    assert_eq!(session.protocol(), "2025-06-18");

    let tools = session.list_tools(true).await.unwrap();
    assert_eq!(tools.len(), 3);
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["echo", "add", "fail"]);
    let echo = &tools[0];
    assert_eq!(echo["required"][0], "text");
    assert!(echo["inputSchema"].as_str().unwrap().contains("string"));

    // 缓存：不刷新时返回同一批工具
    assert_eq!(session.list_tools(false).await.unwrap().len(), 3);

    let result = session
        .call_tool("echo", json!({ "text": "你好 MCP" }))
        .await
        .unwrap();
    assert_eq!(result["content"][0]["text"], "你好 MCP");
    assert_eq!(result["isError"], json!(null));

    let sum = session
        .call_tool("add", json!({ "a": 2, "b": 40 }))
        .await
        .unwrap();
    assert_eq!(sum["content"][0]["text"], "42");
    assert_eq!(sum["structuredContent"]["sum"], 42);

    // 服务器返回 isError 时不抛错，交给调用方判断
    let failure = session.call_tool("fail", json!({})).await.unwrap();
    assert_eq!(failure["isError"], true);
    assert_eq!(failure["content"][0]["text"], "夹具故意失败");

    // 未知工具是协议错误
    let error = session.call_tool("nope", json!({})).await.unwrap_err();
    assert!(error.to_string().contains("未知工具"), "{error}");

    session.shutdown().await;
}

#[tokio::test]
async fn manager_connects_calls_and_disconnects_by_name() {
    let dir = tempfile::tempdir().unwrap();
    write_config(
        dir.path(),
        json!({ "fixture": { "command": fixture_command(), "timeout": 30 } }),
    );

    let manager = McpManager::new(dir.path().to_path_buf());
    let listing = manager.list().await;
    assert_eq!(listing["connectedCount"], 0);
    assert_eq!(listing["servers"][0]["connected"], false);
    assert_eq!(listing["servers"][0]["transport"], "stdio");

    let connected = manager.connect("fixture").await.unwrap();
    assert_eq!(connected["server"]["serverInfo"]["name"], "mcp-fixture");
    assert_eq!(connected["server"]["toolCount"], 0);
    assert!(connected["server"]["capabilities"]["tools"].is_object());
    let tools = manager.tools("fixture", false).await.unwrap();
    assert_eq!(tools["tools"].as_array().unwrap().len(), 3);

    // 第二次连接复用同一会话，不会重复拉起进程
    let again = manager.connect("fixture").await.unwrap();
    assert_eq!(again["server"]["toolCount"], 3);

    let listing = manager.list().await;
    assert_eq!(listing["connectedCount"], 1);
    assert_eq!(listing["servers"][0]["connected"], true);
    assert_eq!(listing["servers"][0]["toolCount"], 3);

    let called = manager
        .call("fixture", "echo", json!({ "text": "hi" }))
        .await
        .unwrap();
    assert_eq!(called["result"]["content"][0]["text"], "hi");
    assert_eq!(called["server"], "fixture");

    // 参数必须是 JSON 对象
    assert!(manager
        .call("fixture", "echo", json!("nope"))
        .await
        .is_err());

    let closed = manager.disconnect("fixture").await;
    assert_eq!(closed["disconnected"][0], "fixture");
    let listing = manager.list().await;
    assert_eq!(listing["connectedCount"], 0);

    // 断开后再调用会自动重连
    let called = manager
        .call("fixture", "echo", json!({ "text": "again" }))
        .await
        .unwrap();
    assert_eq!(called["result"]["content"][0]["text"], "again");
    manager.shutdown().await;
    assert_eq!(manager.list().await["connectedCount"], 0);
}

#[tokio::test]
async fn failing_launch_and_unknown_server_report_actionable_errors() {
    let dir = tempfile::tempdir().unwrap();
    write_config(
        dir.path(),
        json!({
            "missing": { "command": "definitely-not-a-real-binary-1234" },
            "unknown-env": { "url": "http://127.0.0.1:9/mcp", "headers": { "Authorization": "Bearer ${PI_MCP_NOT_SET_AT_ALL}" } }
        }),
    );

    let manager = McpManager::new(dir.path().to_path_buf());
    let error = manager.connect("missing").await.unwrap_err();
    assert!(error.to_string().contains("无法启动"), "{error}");

    let error = manager.connect("nope").await.unwrap_err();
    assert!(error.to_string().contains("没有名为 nope"), "{error}");

    // 缺失的环境变量要在列表里明确提示，而不是静默发一个坏请求头
    let listing = load_servers(dir.path());
    let warnings: Vec<&str> = listing["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert!(
        warnings.iter().any(|w| w.contains("PI_MCP_NOT_SET_AT_ALL")),
        "{warnings:?}"
    );
    let server = listing["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|server| server["name"] == "unknown-env")
        .unwrap();
    assert_eq!(server["missingEnv"][0], "PI_MCP_NOT_SET_AT_ALL");
}

#[tokio::test]
async fn content_only_server_supports_paging_resources_templates_and_prompts() {
    let dir = tempfile::tempdir().unwrap();
    write_config(
        dir.path(),
        json!({"content": {"command":fixture_command(),"args":["--content-only"]}}),
    );
    let manager = McpManager::new(dir.path().to_path_buf());
    let connected = manager.connect("content").await.unwrap();
    assert!(connected["server"]["capabilities"].get("tools").is_none());
    assert!(manager.tools("content", false).await.is_err());
    let page = manager
        .content_list("content", "resources", None)
        .await
        .unwrap();
    assert_eq!(page["resources"][0]["uri"], "fixture://hello");
    assert_eq!(page["nextCursor"], "下一页+/=");
    let last = manager
        .content_list("content", "resources", page["nextCursor"].as_str())
        .await
        .unwrap();
    assert_eq!(last["resources"][0]["uri"], "fixture://binary");
    assert!(last.get("nextCursor").is_none());
    for (kind, key) in [("templates", "resourceTemplates"), ("prompts", "prompts")] {
        let page = manager.content_list("content", kind, None).await.unwrap();
        assert_eq!(page[key].as_array().unwrap().len(), 1);
        let last = manager
            .content_list("content", kind, page["nextCursor"].as_str())
            .await
            .unwrap();
        assert!(last[key].as_array().unwrap().is_empty());
        assert!(last.get("nextCursor").is_none());
    }
    let read = manager
        .read_resource("content", "fixture://hello")
        .await
        .unwrap();
    assert_eq!(read["result"]["contents"][0]["text"], "你好🙂 MCP resource");
    let blob = manager
        .read_resource("content", "fixture://binary")
        .await
        .unwrap();
    assert_eq!(blob["result"]["contents"][0]["blob"], "AAEC");
    let prompt = manager
        .get_prompt("content", "greet", json!({"name":"世界"}))
        .await
        .unwrap();
    assert_eq!(
        prompt["result"]["messages"][0]["content"]["text"],
        "Hello 世界"
    );
    for uri in [
        "",
        "fixture://missing",
        "fixture://oversized",
        "fixture://malformed",
    ] {
        assert!(
            manager.read_resource("content", uri).await.is_err(),
            "{uri}"
        );
    }
    for arguments in [json!([]), json!({"name":1}), json!({})] {
        assert!(manager
            .get_prompt("content", "greet", arguments)
            .await
            .is_err());
    }
    assert!(manager
        .get_prompt("content", "missing", json!({"name":"hi"}))
        .await
        .is_err());
    manager.shutdown().await;
}

/// 可选的本机实测：读取真实 mcp.json 并连接其中的服务器（默认 rea）。
/// 默认忽略，避免 CI 依赖本机环境；手动执行：
///   cargo test --no-default-features --test mcp_client -- --ignored --nocapture
#[tokio::test]
#[ignore = "需要本机 mcp.json 中的真实 MCP 服务器"]
async fn live_server_from_local_mcp_json() {
    let agent_dir = std::env::var("PI_AGENT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
                .join(".pi")
                .join("agent")
        });
    let name = std::env::var("PI_DESKTOP_LIVE_SERVER").unwrap_or_else(|_| "rea".to_owned());
    let listing = load_servers(&agent_dir);
    println!("mcp.json: {}", listing["path"]);
    println!(
        "servers: {}",
        listing["servers"].as_array().map(|v| v.len()).unwrap_or(0)
    );
    let manager = McpManager::new(agent_dir);
    let started = std::time::Instant::now();
    let connected = manager.connect(&name).await.expect("connect");
    let listing = manager.tools(&name, false).await.expect("list tools");
    let tools = listing["tools"].as_array().unwrap();
    println!(
        "{} 连接成功：serverInfo={} 工具 {} 个，握手+列举耗时 {:?}",
        name,
        connected["server"]["serverInfo"],
        tools.len(),
        started.elapsed()
    );
    assert!(!tools.is_empty());
    // 真实调用其中一个无副作用工具（如 rea 的 binary_session），确认调用链路可用。
    if tools.iter().any(|tool| tool["name"] == "binary_session") {
        let result = manager
            .call(&name, "binary_session", json!({}))
            .await
            .unwrap();
        let text = result["result"].to_string();
        println!("binary_session 返回 {} 字节", text.len());
        assert!(text.len() > 50);
    }
    manager.shutdown().await;
}
