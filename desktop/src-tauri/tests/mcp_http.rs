use pi_desktop::mcp_client::{McpManager, McpSession, ServerConfig};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Server {
    child: Child,
    root: tempfile::TempDir,
    url: String,
}
impl Server {
    fn new(mode: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new("node");
        command
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixture-mcp-http.mjs"))
            .arg(root.path().join("requests.jsonl"))
            .arg(mode)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().unwrap();
        let mut url = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut url)
            .unwrap();
        assert!(
            url.starts_with("http://127.0.0.1:"),
            "fixture did not start"
        );
        Self {
            child,
            root,
            url: url.trim().to_owned(),
        }
    }
    fn config(&self) -> ServerConfig {
        ServerConfig {
            name: "http-fixture".into(),
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some(self.url.clone()),
            headers: BTreeMap::from([("Authorization".into(), "Bearer test-only".into())]),
            enabled: true,
            timeout: Some(1),
            exposure: None,
        }
    }
    fn records(&self) -> Vec<Value> {
        fs::read_to_string(self.root.path().join("requests.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
    async fn wait(&self, predicate: impl Fn(&[Value]) -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if predicate(&self.records()) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("fixture event timeout");
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test]
async fn http_reuses_session_initializes_and_accepts_multiline_sse_without_eof() {
    let server = Server::new("no-get");
    let session = McpSession::connect(server.config()).await.unwrap();
    assert_eq!(session.server_info()["name"], "http-fixture");
    let tools = session.list_tools(false).await.unwrap();
    assert_eq!(tools[0]["name"], "echo-0");
    let result = session.call_tool("sse", json!({})).await.unwrap();
    assert_eq!(result["content"][0]["text"], "你好🙂 SSE");
    session.list_tools(false).await.unwrap();
    assert_eq!(
        server
            .records()
            .iter()
            .filter(|r| r["message"]["method"] == "tools/list")
            .count(),
        2,
        "POST notification invalidates cache"
    );
    session.shutdown().await;
    server
        .wait(|records| records.iter().any(|r| r["method"] == "DELETE"))
        .await;
    let records = server.records();
    let posts: Vec<_> = records.iter().filter(|r| r["method"] == "POST").collect();
    assert_eq!(posts[0]["message"]["method"], "initialize");
    assert!(posts[0]["headers"].get("mcp-session-id").is_none());
    assert_eq!(posts[1]["message"]["method"], "notifications/initialized");
    for record in records
        .iter()
        .filter(|r| r.get("headers").is_some() && r["message"]["method"] != "initialize")
    {
        assert_eq!(record["headers"]["mcp-session-id"], "fixture-session");
        assert_eq!(record["headers"]["mcp-protocol-version"], "2025-06-18");
        assert_eq!(record["headers"]["authorization"], "Bearer test-only");
    }
    assert_eq!(session.summary()["connected"], false);
}

#[tokio::test]
async fn get_notifications_invalidate_cache_and_reconnect_with_last_event_id() {
    let server = Server::new("normal");
    let session = McpSession::connect(server.config()).await.unwrap();
    server
        .wait(|r| r.iter().any(|r| r["event"] == "stream-open"))
        .await;
    session.list_tools(false).await.unwrap();
    session.list_tools(false).await.unwrap();
    assert!(
        server
            .records()
            .iter()
            .filter(|r| r["message"]["method"] == "tools/list")
            .count()
            <= 2,
        "The initial GET may invalidate a list fetched before its headers arrived"
    );
    session.call_tool("notify", json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if session.list_tools(false).await.unwrap()[0]["name"] == "echo-1" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    session.call_tool("close-stream", json!({})).await.unwrap();
    server
        .wait(|r| r.iter().any(|r| r["event"] == "stream-close"))
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Refill the cache in the gap, then miss a change without event replay.
    assert_eq!(
        session.list_tools(false).await.unwrap()[0]["name"],
        "echo-1"
    );
    session.call_tool("silent-change", json!({})).await.unwrap();
    server
        .wait(|r| {
            r.iter()
                .any(|r| r["method"] == "GET" && r["headers"]["last-event-id"] == "change-1")
        })
        .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if session.list_tools(false).await.unwrap()[0]["name"] == "echo-2" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    session.shutdown().await;
    server
        .wait(|r| r.iter().filter(|r| r["event"] == "stream-close").count() >= 2)
        .await;
}

#[tokio::test]
async fn stateless_servers_and_optional_get_405_are_supported() {
    for mode in ["stateless", "no-get"] {
        let server = Server::new(mode);
        let session = McpSession::connect(server.config()).await.unwrap();
        assert_eq!(
            session.call_tool("echo", json!({})).await.unwrap()["content"][0]["text"],
            "ok"
        );
        server
            .wait(|r| r.iter().any(|r| r["method"] == "GET"))
            .await;
        session.shutdown().await;
        if mode == "stateless" {
            assert!(server
                .records()
                .iter()
                .all(|r| r["headers"].get("mcp-session-id").is_none()));
        }
    }
}

#[tokio::test]
async fn expiry_is_not_retried_and_rejects_cached_tools() {
    let server = Server::new("normal");
    let session = McpSession::connect(server.config()).await.unwrap();
    session.list_tools(false).await.unwrap();
    let error = session
        .call_tool("expire", json!({}))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("过期"), "{error}");
    assert!(session.call_tool("echo", json!({})).await.is_err());
    assert!(session.list_tools(false).await.is_err());
    assert_eq!(session.summary()["connected"], false);
    assert_eq!(
        server
            .records()
            .iter()
            .filter(|r| r["message"]["method"] == "initialize")
            .count(),
        1
    );
    assert_eq!(
        server
            .records()
            .iter()
            .filter(|r| r["message"]["params"]["name"] == "expire")
            .count(),
        1
    );
    session.shutdown().await;
}

#[tokio::test]
async fn timeout_drop_and_disconnect_close_http_processes() {
    let server = Server::new("normal");
    let session = McpSession::connect(server.config()).await.unwrap();
    server
        .wait(|r| r.iter().any(|r| r["event"] == "stream-open"))
        .await;
    let error = session
        .call_tool("hang", json!({}))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("超时"), "{error}");
    server
        .wait(|r| r.iter().any(|r| r["event"] == "hang-close"))
        .await;
    let pending = session.clone();
    let call = tokio::spawn(async move {
        pending
            .request(
                "tools/call",
                json!({"name":"hang"}),
                Duration::from_secs(30),
            )
            .await
    });
    server
        .wait(|r| {
            r.iter()
                .filter(|r| r["message"]["params"]["name"] == "hang")
                .count()
                == 2
        })
        .await;
    session.shutdown().await;
    assert!(tokio::time::timeout(Duration::from_secs(2), call)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    let session = McpSession::connect(server.config()).await.unwrap();
    server
        .wait(|r| r.iter().filter(|r| r["event"] == "stream-open").count() == 2)
        .await;
    drop(session);
    server
        .wait(|r| r.iter().filter(|r| r["event"] == "stream-close").count() == 2)
        .await;
}

#[tokio::test]
async fn literal_urls_and_escaped_credentials_are_sent_once() {
    let server = Server::new("no-get");
    let mut config = server.config();
    config.url = Some(format!("{}?scope={{a,b}}&range=[1-2]", server.url));
    config
        .headers
        .insert("X-Test".into(), "quoted \"value\" \\ path".into());
    let session = McpSession::connect(config).await.unwrap();
    session
        .call_tool("echo", json!({"text":"引号\"和反斜杠\\\n换行"}))
        .await
        .unwrap();
    let records = server.records();
    let calls: Vec<_> = records
        .iter()
        .filter(|r| r["message"]["method"] == "tools/call")
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["url"], "/mcp?scope={a,b}&range=[1-2]");
    assert_eq!(calls[0]["headers"]["x-test"], "quoted \"value\" \\ path");
    assert_eq!(
        calls[0]["message"]["params"]["arguments"]["text"],
        "引号\"和反斜杠\\\n换行"
    );
    session.shutdown().await;
}

#[tokio::test]
async fn manager_serializes_connect_disconnect_and_explicit_reconnect() {
    let server = Server::new("slow");
    fs::write(
        server.root.path().join("mcp.json"),
        json!({"mcpServers":{"fixture":{"url":server.url}}}).to_string(),
    )
    .unwrap();
    let manager = std::sync::Arc::new(McpManager::new(server.root.path().to_owned()));
    let (first, second) = tokio::join!(manager.connect("fixture"), manager.connect("fixture"));
    first.unwrap();
    second.unwrap();
    assert_eq!(
        server
            .records()
            .iter()
            .filter(|r| r["message"]["method"] == "initialize")
            .count(),
        1
    );
    assert!(manager.call("fixture", "expire", json!({})).await.is_err());
    assert_eq!(manager.list().await["connectedCount"], 0);
    manager.connect("fixture").await.unwrap();
    assert_eq!(manager.list().await["connectedCount"], 1);
    manager.disconnect("*").await;
    let pending = manager.clone();
    let connecting = tokio::spawn(async move { pending.connect("fixture").await });
    server
        .wait(|r| {
            r.iter()
                .filter(|r| r["message"]["method"] == "initialize")
                .count()
                == 3
        })
        .await;
    manager.disconnect("*").await;
    let _ = connecting.await.unwrap();
    assert_eq!(manager.list().await["connectedCount"], 0);
    assert_eq!(
        server
            .records()
            .iter()
            .filter(|r| r["method"] == "DELETE")
            .count(),
        3
    );
}

#[tokio::test]
async fn http_rejects_invalid_ids_status_bodies_headers_and_session_ids() {
    let server = Server::new("no-get");
    let session = McpSession::connect(server.config()).await.unwrap();
    for (tool, expected) in [
        ("wrong-id", "ID"),
        ("denied", "403"),
        ("bad-json", "JSON"),
        ("oversized", "限制"),
    ] {
        let error = session
            .call_tool(tool, json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(expected), "{tool}: {error}");
        assert!(!error.contains("secret"));
    }
    session.shutdown().await;
    let mut config = server.config();
    config
        .headers
        .insert("Mcp-Session-Id".into(), "override".into());
    assert!(McpSession::connect(config).await.is_err());
    let server = Server::new("bad-session");
    assert!(McpSession::connect(server.config()).await.is_err());
}
