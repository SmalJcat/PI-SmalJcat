use pi_desktop::{
    mcp_app_host::{resource_document, McpAppHost, UI_MIME},
    mcp_client::McpManager,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};

#[tokio::test]
async fn stalled_stdio_writes_are_bounded_and_close_the_partial_transport() {
    use pi_desktop::mcp_client::{McpSession, ServerConfig};
    use std::{collections::BTreeMap, time::Duration};
    let script = r#"
process.stdin.once('data', bytes => {
  const request=JSON.parse(bytes.toString().trim());
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{
    protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'stalled',version:'1'}
  }})+'\n');
  process.stdin.pause();
});
setInterval(()=>{},1000);
"#;
    let config = ServerConfig {
        name: "stalled".into(),
        command: Some("node".into()),
        args: vec!["-e".into(), script.into()],
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
        enabled: true,
        timeout: Some(1),
        exposure: None,
    };
    let session = McpSession::connect(config.clone()).await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        session.request(
            "tools/call",
            json!({"name":"echo","arguments":{"text":"x".repeat(1024*1024)}}),
            Duration::from_millis(100),
        ),
    )
    .await;
    let automatically_closed = session.summary()["connected"] == false;
    session.shutdown().await;
    assert!(
        result.is_ok(),
        "stdin writes must honor the request deadline"
    );
    assert!(result.unwrap().is_err());
    assert!(
        automatically_closed,
        "a timed-out partial frame must close the transport"
    );
    let session = McpSession::connect(config).await.unwrap();
    let writer = session.clone();
    let pending = tokio::spawn(async move {
        writer
            .request(
                "tools/call",
                json!({"name":"echo","arguments":{"text":"x".repeat(1024*1024)}}),
                Duration::from_secs(15),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let stopped = tokio::time::timeout(Duration::from_secs(6), session.shutdown()).await;
    if stopped.is_err() {
        pending.abort();
        let _ = pending.await;
        session.shutdown().await;
    } else {
        assert!(pending.await.unwrap().is_err());
    }
    assert!(
        stopped.is_ok(),
        "disconnect must interrupt a blocked stdin writer"
    );
}

fn manager(root: &std::path::Path, server: Value) -> McpManager {
    fs::write(
        root.join("mcp.json"),
        json!({"mcpServers":{"fixture":server}}).to_string(),
    )
    .unwrap();
    McpManager::new(root.into())
}
fn stdio_manager(root: &std::path::Path) -> McpManager {
    manager(
        root,
        json!({"command":env!("CARGO_BIN_EXE_mcp-fixture"),"args":["--apps"]}),
    )
}
async fn message(host: &McpAppHost, label: &str, id: Value, method: &str, params: Value) -> Value {
    host.message(
        label,
        &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
    )
    .await
}
async fn initialize(host: &McpAppHost, label: &str) -> Value {
    let reply = message(host,label,json!(1),"ui/initialize",
        json!({"protocolVersion":"2026-01-26","appInfo":{"name":"test","version":"1"},"appCapabilities":{}})).await;
    assert!(reply["response"]["error"].is_null(), "{reply}");
    assert_eq!(reply["response"]["result"]["protocolVersion"], "2026-01-26");
    host.message(
        label,
        &json!({"jsonrpc":"2.0","method":"ui/notifications/initialized"}).to_string(),
    )
    .await
}

#[test]
fn app_resources_validate_html_identity_mime_base64_and_csp() {
    let resource = json!({"contents":[{"uri":"ui://app/test","mimeType":UI_MIME,"text":"<html>你好</html>",
        "_meta":{"ui":{"csp":{"connectDomains":["https://api.example.test"],"resourceDomains":["https://*.example.test"]}}}}]});
    let (html, csp, domains) = resource_document(&resource, "ui://app/test").unwrap();
    assert!(html.contains("你好"));
    assert!(csp.contains("frame-src 'none'"));
    assert!(csp.contains("https://*.example.test"));
    assert_eq!(domains["connectDomains"][0], "https://api.example.test");
    let blob = json!({"contents":[{"uri":"ui://app/test","mimeType":UI_MIME,"blob":"PGh0bWw+PC9odG1sPg=="}]});
    assert_eq!(
        resource_document(&blob, "ui://app/test").unwrap().0,
        "<html></html>"
    );
    for invalid in [
        json!({"contents":[{"uri":"ui://app/test","mimeType":"text/html","text":"x"}]}),
        json!({"contents":[{"uri":"ui://other","mimeType":UI_MIME,"text":"x"}]}),
        json!({"contents":[{"uri":"ui://app/test","mimeType":UI_MIME,"blob":"!!"}]}),
        json!({"contents":[{"uri":"ui://app/test","mimeType":UI_MIME,"text":"x","blob":"AA=="}]}),
        json!({"contents":[{"uri":"ui://app/test","mimeType":UI_MIME,"text":"x".repeat(2*1024*1024+1)}]}),
    ] {
        assert!(resource_document(&invalid, "ui://app/test").is_err());
    }
    for domain in [
        "https://ok.test; connect-src *",
        "https://user:secret@host.test",
        "file:///private",
        "https://host.test/path",
        "https://host.test/?x=1",
        "https://*.bad.*.test",
        "https://ok.test\u{7}",
        "https://ok.test\t",
    ] {
        let mut bad = resource.clone();
        bad["contents"][0]["_meta"]["ui"]["csp"]["connectDomains"] = json!([domain]);
        assert!(
            resource_document(&bad, "ui://app/test").is_err(),
            "{domain}"
        );
    }
    let mut unicode = resource.clone();
    unicode["contents"][0]["_meta"]["ui"]["csp"]["connectDomains"] =
        json!(["https://例え.テスト", "https://wildcard.example.test"]);
    let (_, csp, domains) = resource_document(&unicode, "ui://app/test").unwrap();
    assert!(csp.is_ascii());
    assert_eq!(
        domains["connectDomains"][1],
        "https://wildcard.example.test"
    );
}

#[tokio::test]
async fn stdio_apps_negotiate_bind_resources_authorize_and_reject_old_connections() {
    let root = tempfile::tempdir().unwrap();
    let mcp = stdio_manager(root.path());
    let host = McpAppHost::default();
    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let id = prepared["id"].as_str().unwrap();
    assert_eq!(prepared["uri"], "ui://fixture/app");
    assert!(!prepared["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "model_only"));
    assert_eq!(prepared["sha256"].as_str().unwrap().len(), 64);
    assert!(host.bootstrap("main").is_err());
    let initial = mcp
        .call("fixture", "app_view", json!({"count":7}))
        .await
        .unwrap();
    let label = host
        .activate(id, &[], json!({"count":7}), initial["result"].clone())
        .unwrap();
    assert!(host.document("main", id).is_err());
    assert!(host.document(&label, "other").is_err());
    assert!(host
        .document(&label, id)
        .unwrap()
        .0
        .contains("ui/initialize"));
    let ready = initialize(&host, &label).await;
    assert_eq!(
        ready["notifications"][0]["method"],
        "ui/notifications/tool-input"
    );
    assert_eq!(
        ready["notifications"][1]["params"]["structuredContent"]["count"],
        7
    );
    let denied = message(
        &host,
        &label,
        json!(2),
        "tools/call",
        json!({"name":"app_refresh"}),
    )
    .await;
    assert!(denied["response"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("授权"));
    host.close(id);
    assert!(host.bootstrap(&label).is_err());

    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let id = prepared["id"].as_str().unwrap();
    assert!(host
        .activate(id, &["model_only".into()], json!({}), json!({}))
        .is_err());
    let label = host
        .activate(id, &["app_refresh".into()], json!({}), json!({}))
        .unwrap();
    let before_ready = message(
        &host,
        &label,
        json!(3),
        "tools/call",
        json!({"name":"app_refresh"}),
    )
    .await;
    assert!(before_ready["response"]["error"].is_object());
    initialize(&host, &label).await;
    let result = message(
        &host,
        &label,
        json!("call-1"),
        "tools/call",
        json!({"name":"app_refresh","arguments":{"count":42}}),
    )
    .await;
    assert_eq!(result["response"]["id"], "call-1");
    assert_eq!(
        result["response"]["result"]["structuredContent"]["count"],
        42
    );
    assert_eq!(
        result["response"]["result"]["_meta"]["source"],
        "real-stdio-fixture"
    );
    let rejected = message(&host, &label, json!(4), "host/read-file", json!({})).await;
    assert_eq!(rejected["response"]["error"]["code"], -32601);
    mcp.disconnect("fixture").await;
    mcp.connect("fixture").await.unwrap();
    let expired = message(
        &host,
        &label,
        json!(5),
        "tools/call",
        json!({"name":"app_refresh"}),
    )
    .await;
    assert!(expired["response"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("断开"));
    host.close_window(&label);
    assert!(host.bootstrap(&label).is_err());
    assert!(host.audit().iter().any(|entry| entry["ok"] == false));
    let large = host.prepare(&mcp, "fixture", "large_schema").await.unwrap();
    let large_label = host
        .activate(large["id"].as_str().unwrap(), &[], json!({}), json!({}))
        .unwrap();
    let reply = message(&host,&large_label,json!(21),"ui/initialize",
        json!({"protocolVersion":"2026-01-26","appInfo":{"name":"test","version":"1"},"appCapabilities":{}})).await;
    assert_eq!(
        reply["response"]["result"]["hostContext"]["toolInfo"]["tool"]["inputSchema"]["properties"]
            ["large"]["description"]
            .as_str()
            .unwrap()
            .len(),
        9000
    );
    let invalid = host
        .message(&large_label, r#"{"jsonrpc":"2.0","id":{},"method":"ping"}"#)
        .await;
    assert_eq!(invalid["response"]["error"]["code"], -32600);
    assert_eq!(
        host.message(&large_label, "[]").await["response"]["error"]["code"],
        -32600
    );
    assert_eq!(
        host.message(&large_label, "bad").await["response"]["error"]["code"],
        -32700
    );
    assert!(host.prepare(&mcp, "fixture", "bad_mime").await.is_err());
    assert!(host.prepare(&mcp, "fixture", "missing_app").await.is_err());
    mcp.disconnect("*").await;
}

struct HttpFixture(Child);
impl HttpFixture {
    fn start(log: &std::path::Path) -> (Self, String) {
        let mut command = Command::new("node");
        command
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixture-mcp-http.mjs"))
            .arg(log)
            .arg("apps")
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
        assert!(url.starts_with("http://127.0.0.1:"));
        (Self(child), url.trim().to_owned())
    }
}
impl Drop for HttpFixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn http_apps_use_negotiated_connection_and_preserve_rpc_results() {
    let root = tempfile::tempdir().unwrap();
    let log = root.path().join("http.jsonl");
    let (_fixture, url) = HttpFixture::start(&log);
    let mcp = manager(root.path(), json!({"url":url}));
    let host = McpAppHost::default();
    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let label = host
        .activate(
            prepared["id"].as_str().unwrap(),
            &["app_refresh".into()],
            json!({}),
            json!({}),
        )
        .unwrap();
    initialize(&host, &label).await;
    let result = message(
        &host,
        &label,
        json!(10),
        "tools/call",
        json!({"name":"app_refresh","arguments":{"count":42}}),
    )
    .await;
    assert_eq!(
        result["response"]["result"]["structuredContent"]["count"],
        42
    );
    mcp.disconnect("*").await;
    let records = fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let init = records
        .iter()
        .find(|record| record["message"]["method"] == "initialize")
        .unwrap();
    assert_eq!(
        init["message"]["params"]["capabilities"]["extensions"]["io.modelcontextprotocol/ui"]
            ["mimeTypes"][0],
        UI_MIME
    );
    assert!(records
        .iter()
        .any(|record| record["message"]["method"] == "resources/read"
            && record["headers"]["mcp-session-id"] == "fixture-session"));
}

#[tokio::test]
async fn app_transport_errors_keep_host_diagnostics_in_host_audit() {
    let root = tempfile::tempdir().unwrap();
    let mcp = manager(
        root.path(),
        json!({
            "command":env!("CARGO_BIN_EXE_mcp-fixture"),
            "args":["--apps","--diagnostic-secret"],
        }),
    );
    let host = McpAppHost::default();
    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let label = host
        .activate(
            prepared["id"].as_str().unwrap(),
            &["app_failure".into()],
            json!({}),
            json!({}),
        )
        .unwrap();
    initialize(&host, &label).await;
    let response = message(
        &host,
        &label,
        json!(13),
        "tools/call",
        json!({"name":"app_failure","arguments":{}}),
    )
    .await;
    mcp.disconnect("*").await;
    assert!(response["response"]["error"].is_object());
    assert!(
        !response["response"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("HOST_DIAGNOSTIC_SECRET"),
        "host-only stderr must not be returned to server HTML"
    );
    assert!(host.audit().iter().any(|entry| entry["detail"]
        .as_str()
        .is_some_and(|detail| detail.contains("HOST_DIAGNOSTIC_SECRET"))));
}
