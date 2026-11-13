#[cfg(feature = "test-fixture")]
use pi_desktop::mcp_app_host::PiAccess;
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

#[cfg(feature = "test-fixture")]
static CORE_FIXTURE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

#[tokio::test]
async fn app_resource_reads_require_consent_and_preserve_content_on_the_original_connection() {
    let root = tempfile::tempdir().unwrap();
    let mcp = stdio_manager(root.path());
    let host = McpAppHost::default();
    for allowed in [false, true] {
        let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
        let id = prepared["id"].as_str().unwrap();
        let label = host
            .activate(id, &[], allowed, None, json!({}), json!({}))
            .unwrap();
        let before = message(
            &host,
            &label,
            json!(0),
            "resources/read",
            json!({"uri":"fixture://hello"}),
        )
        .await;
        assert!(before["response"]["error"].is_object());
        let ready = initialize(&host, &label).await;
        assert_eq!(
            ready["initializeResult"]["hostCapabilities"]["serverResources"].is_object(),
            allowed
        );
        if !allowed {
            // This URI exits the fixture if forwarded. A subsequent tool call
            // proves the denied resource request never reached the server.
            let denied = message(
                &host,
                &label,
                json!(2),
                "resources/read",
                json!({"uri":"fixture://failure"}),
            )
            .await;
            assert_eq!(denied["response"]["error"]["code"], -32000);
            assert!(denied["response"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("授权"));
            mcp.call("fixture", "app_refresh", json!({})).await.unwrap();
            host.close(id);
            continue;
        }
        for uri in [
            json!(""),
            json!("relative/path"),
            json!("fixture://hello\n"),
            json!("x".repeat(4097)),
            json!(42),
        ] {
            let invalid = message(
                &host,
                &label,
                json!(3),
                "resources/read",
                json!({"uri":uri}),
            )
            .await;
            assert!(invalid["response"]["error"].is_object(), "{invalid}");
        }
        for uri in ["fixture://hello", "fixture://binary"] {
            let expected = mcp.read_resource("fixture", uri).await.unwrap();
            let response = message(
                &host,
                &label,
                json!("resource-1"),
                "resources/read",
                json!({"uri":uri}),
            )
            .await;
            assert_eq!(response["response"]["id"], "resource-1");
            assert_eq!(response["response"]["result"], expected["result"]);
        }
        for uri in [
            "fixture://oversized",
            "fixture://malformed",
            "fixture://missing",
        ] {
            let response = message(
                &host,
                &label,
                json!(4),
                "resources/read",
                json!({"uri":uri}),
            )
            .await;
            assert!(response["response"]["error"].is_object(), "{response}");
            assert!(response["response"]["result"].is_null());
        }
        mcp.disconnect("fixture").await;
        mcp.connect("fixture").await.unwrap();
        let expired = message(
            &host,
            &label,
            json!(5),
            "resources/read",
            json!({"uri":"fixture://hello"}),
        )
        .await;
        assert!(expired["response"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("断开"));
        host.close(id);
        let closed = message(
            &host,
            &label,
            json!(6),
            "resources/read",
            json!({"uri":"fixture://hello"}),
        )
        .await;
        assert!(closed["response"]["error"].is_object());
    }
    assert!(host.audit().iter().any(|entry| entry["detail"]
        .as_str()
        .is_some_and(|text| text.contains("256 KiB"))));
    mcp.disconnect("*").await;
}
async fn initialize(host: &McpAppHost, label: &str) -> Value {
    let reply = message(host,label,json!(1),"ui/initialize",
        json!({"protocolVersion":"2026-01-26","appInfo":{"name":"test","version":"1"},"appCapabilities":{}})).await;
    assert!(reply["response"]["error"].is_null(), "{reply}");
    assert_eq!(reply["response"]["result"]["protocolVersion"], "2026-01-26");
    let mut ready = host
        .message(
            label,
            &json!({"jsonrpc":"2.0","method":"ui/notifications/initialized"}).to_string(),
        )
        .await;
    ready["initializeResult"] = reply["response"]["result"].clone();
    ready
}

#[cfg(feature = "test-fixture")]
#[tokio::test]
async fn app_chat_messages_bind_to_pi_and_reject_stale_busy_or_revoked_sends() {
    use pi_desktop::core::{ConnectOptions, Core};
    use std::{sync::atomic::AtomicBool, time::Duration};

    let _environment = CORE_FIXTURE.lock().await;
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    fs::create_dir(&work).unwrap();
    std::env::set_var("PI_DESKTOP_TEST", "1");
    std::env::set_var("PI_DESKTOP_EXECUTABLE", "node");
    std::env::set_var(
        "PI_DESKTOP_RPC_SCRIPT",
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixture-pi.mjs"),
    );
    std::env::set_var("PI_CODING_AGENT_DIR", root.path().join("agent"));
    std::env::set_var("PI_CODING_AGENT_SESSION_DIR", root.path().join("sessions"));
    let core = Core::new(&root.path().join("profile")).unwrap();
    core.connect(ConnectOptions {
        cwd: Some(work.to_string_lossy().into_owned()),
        ..Default::default()
    })
    .await
    .unwrap();
    let mcp = stdio_manager(root.path());
    let host = McpAppHost::default();
    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let id = prepared["id"].as_str().unwrap();
    let label = host
        .activate(id, &[], false, None, json!({}), json!({}))
        .unwrap();
    let ready = initialize(&host, &label).await;
    assert!(ready["initializeResult"]["hostCapabilities"]["message"].is_null());
    let denied = message(
        &host,
        &label,
        json!(2),
        "ui/message",
        json!({"role":"user","content":[{"type":"text","text":"denied"}]}),
    )
    .await;
    assert_eq!(denied["response"]["error"]["code"], -32000);
    assert!(core.snapshot().await.unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    host.close(id);

    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let id = prepared["id"].as_str().unwrap();
    let binding = core.bind_app_chat().await.unwrap();
    let label = host
        .activate(
            id,
            &[],
            false,
            Some(PiAccess {
                binding: binding.clone(),
                messages: true,
                model_context: false,
            }),
            json!({}),
            json!({}),
        )
        .unwrap();
    let payload = json!({"role":"user","content":[{"type":"text","text":"APP_CHAT_ONE"},{"type":"text","text":"second"}]});
    let early = message(&host, &label, json!(3), "ui/message", payload.clone()).await;
    assert!(early["response"]["error"].is_object());
    let ready = initialize(&host, &label).await;
    assert_eq!(
        ready["initializeResult"]["hostCapabilities"]["message"],
        json!({"text":{}})
    );
    for invalid in [
        json!({"role":"assistant","content":[{"type":"text","text":"wrong role"}]}),
        json!({"role":"user","content":[{"type":"image","data":"AAEC","mimeType":"image/png"}]}),
        json!({"role":"user","content":[{"type":"text","text":42}]}),
        json!({"role":"user","content":[]}),
        json!({"role":"user","content":{"type":"text","text":"  "}}),
    ] {
        let response = message(&host, &label, json!(4), "ui/message", invalid).await;
        assert!(response["response"]["error"].is_object());
    }
    assert!(core.snapshot().await.unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    let sent = message(&host, &label, json!(5), "ui/message", payload).await;
    assert_eq!(sent["response"]["result"], json!({}));
    async fn idle(core: &Core) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = core.snapshot().await.unwrap();
                if snapshot["state"]["isStreaming"] == false {
                    return snapshot;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap()
    }
    let snapshot = idle(&core).await;
    let user = snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["role"] == "user")
        .unwrap();
    assert!(user["content"]
        .as_str()
        .unwrap()
        .contains("APP_CHAT_ONE\nsecond"));
    assert!(user["content"]
        .as_str()
        .unwrap()
        .contains("MCP App \"fixture\" · \"app_view\""));
    let first_entry = user["_entryId"].as_str().unwrap().to_owned();
    let session_id = snapshot["state"]["sessionId"].as_str().unwrap().to_owned();
    let revoked = AtomicBool::new(false);
    assert!(binding.send("REVOKED".into(), &revoked).await.is_err());
    assert_eq!(
        core.snapshot().await.unwrap()["messages"],
        snapshot["messages"]
    );

    let sent = message(
        &host,
        &label,
        json!(6),
        "ui/message",
        json!({"role":"user","content":{"type":"text","text":"等待 APP_CHAT_BUSY"}}),
    )
    .await;
    assert_eq!(sent["response"]["result"], json!({}));
    let busy = message(
        &host,
        &label,
        json!(7),
        "ui/message",
        json!({"role":"user","content":{"type":"text","text":"MUST_NOT_QUEUE"}}),
    )
    .await;
    assert!(busy["response"]["error"].is_object());
    assert_eq!(
        core.snapshot().await.unwrap()["state"]["pendingMessageCount"],
        0
    );
    core.command("abort", json!({})).await.unwrap();
    idle(&core).await;
    core.prepare_message_edit(&session_id, &first_entry)
        .await
        .unwrap();
    let edited = message(
        &host,
        &label,
        json!(8),
        "ui/message",
        json!({"role":"user","content":{"type":"text","text":"MUST_NOT_SEND_EDIT"}}),
    )
    .await;
    assert!(edited["response"]["error"].is_object());
    assert!(!core.snapshot().await.unwrap()["messages"]
        .to_string()
        .contains("MUST_NOT_SEND"));
    host.close(id);

    let before = core.snapshot().await.unwrap();
    let binding = core.bind_app_chat().await.unwrap();
    core.connect(ConnectOptions {
        cwd: Some(work.to_string_lossy().into_owned()),
        session_path: Some(before["state"]["sessionFile"].as_str().unwrap().to_owned()),
        ..Default::default()
    })
    .await
    .unwrap();
    assert!(binding
        .send("MUST_NOT_RECONNECT".into(), &AtomicBool::new(true))
        .await
        .is_err());
    assert_eq!(
        core.snapshot().await.unwrap()["messages"],
        before["messages"]
    );
    core.command("prompt", json!({"message":"APP_SAME_PROCESS_SESSION"}))
        .await
        .unwrap();
    let snapshot = idle(&core).await;
    let entry = snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["role"] == "user")
        .unwrap()["_entryId"]
        .clone();
    let binding = core.bind_app_chat().await.unwrap();
    core.current()
        .await
        .unwrap()
        .rpc
        .call("fork", json!({"entryId":entry}))
        .await
        .unwrap();
    let forked = core.snapshot().await.unwrap();
    assert_eq!(forked["generation"], snapshot["generation"]);
    assert_ne!(forked["state"]["sessionId"], snapshot["state"]["sessionId"]);
    let error = binding
        .send("MUST_NOT_SWITCH".into(), &AtomicBool::new(true))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("会话已切换"));
    assert_eq!(
        core.snapshot().await.unwrap()["messages"],
        forked["messages"]
    );
    core.shutdown().await;
    mcp.disconnect("*").await;
    assert!(host.audit().iter().any(|entry| entry["detail"]
        .as_str()
        .is_some_and(|text| text.contains("对话已变更"))));
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
        .activate(
            id,
            &[],
            false,
            None,
            json!({"count":7}),
            initial["result"].clone(),
        )
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
        .activate(
            id,
            &["model_only".into()],
            false,
            None,
            json!({}),
            json!({})
        )
        .is_err());
    let label = host
        .activate(
            id,
            &["app_refresh".into()],
            false,
            None,
            json!({}),
            json!({}),
        )
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
        .activate(
            large["id"].as_str().unwrap(),
            &[],
            false,
            None,
            json!({}),
            json!({}),
        )
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

#[cfg(feature = "test-fixture")]
#[tokio::test]
async fn app_model_contexts_are_latest_scoped_and_removed_without_changing_history() {
    use pi_desktop::core::{ConnectOptions, Core};
    use std::time::Duration;
    let _environment = CORE_FIXTURE.lock().await;
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    fs::create_dir(&work).unwrap();
    std::env::set_var("PI_DESKTOP_TEST", "1");
    std::env::set_var("PI_DESKTOP_EXECUTABLE", "node");
    std::env::set_var(
        "PI_DESKTOP_RPC_SCRIPT",
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixture-pi.mjs"),
    );
    std::env::set_var("PI_CODING_AGENT_DIR", root.path().join("agent"));
    std::env::set_var("PI_CODING_AGENT_SESSION_DIR", root.path().join("sessions"));
    let core = Core::new(&root.path().join("profile")).unwrap();
    core.connect(ConnectOptions {
        cwd: Some(work.to_string_lossy().into_owned()),
        ..Default::default()
    })
    .await
    .unwrap();
    let mcp = stdio_manager(root.path());
    let host = McpAppHost::default();
    async fn contexts(core: &Core) -> Value {
        core.current()
            .await
            .unwrap()
            .rpc
            .call("get_desktop_app_context", json!({}))
            .await
            .unwrap()["contexts"]
            .clone()
    }
    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let first_id = prepared["id"].as_str().unwrap();
    let denied_label = host
        .activate(first_id, &[], false, None, json!({}), json!({}))
        .unwrap();
    initialize(&host, &denied_label).await;
    let denied = message(
        &host,
        &denied_label,
        json!(2),
        "ui/update-model-context",
        json!({"structuredContent":{"denied":true}}),
    )
    .await;
    assert_eq!(denied["response"]["error"]["code"], -32000);
    assert_eq!(contexts(&core).await, json!([]));
    host.close(first_id);

    let first = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let first_id = first["id"].as_str().unwrap();
    let binding = core.bind_app_chat().await.unwrap();
    let first_label = host
        .activate(
            first_id,
            &[],
            false,
            Some(PiAccess {
                binding: binding.clone(),
                messages: false,
                model_context: true,
            }),
            json!({}),
            json!({}),
        )
        .unwrap();
    let ready = initialize(&host, &first_label).await;
    assert_eq!(
        ready["initializeResult"]["hostCapabilities"]["updateModelContext"],
        json!({"text":{},"structuredContent":{}})
    );
    assert!(ready["initializeResult"]["hostCapabilities"]["message"].is_null());
    for (index, payload) in [
        json!({"content":[{"type":"text","text":"old"}]}),
        json!({"content":[{"type":"text","text":"latest"}],"structuredContent":{"selected":2}}),
    ]
    .into_iter()
    .enumerate()
    {
        let reply = message(
            &host,
            &first_label,
            json!(index + 3),
            "ui/update-model-context",
            payload,
        )
        .await;
        assert_eq!(reply["response"]["result"], json!({}));
    }
    let values = contexts(&core).await;
    assert_eq!(values.as_array().unwrap().len(), 1);
    assert_eq!(values[0]["content"][0]["text"], "latest");
    assert_eq!(values[0]["structuredContent"]["selected"], 2);
    assert_eq!(values[0]["id"], first_id);
    assert!(core.snapshot().await.unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    let invalid = message(
        &host,
        &first_label,
        json!(5),
        "ui/update-model-context",
        json!({"structuredContent":[]}),
    )
    .await;
    assert!(invalid["response"]["error"].is_object());
    assert_eq!(contexts(&core).await, values);

    let second = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let second_id = second["id"].as_str().unwrap();
    let second_label = host
        .activate(
            second_id,
            &[],
            false,
            Some(PiAccess {
                binding: binding.clone(),
                messages: false,
                model_context: true,
            }),
            json!({}),
            json!({}),
        )
        .unwrap();
    initialize(&host, &second_label).await;
    message(
        &host,
        &second_label,
        json!(6),
        "ui/update-model-context",
        json!({"structuredContent":{"other":true}}),
    )
    .await;
    assert_eq!(contexts(&core).await.as_array().unwrap().len(), 2);
    message(
        &host,
        &first_label,
        json!(7),
        "ui/update-model-context",
        json!({}),
    )
    .await;
    let remaining = contexts(&core).await;
    assert_eq!(remaining.as_array().unwrap().len(), 1);
    assert_eq!(remaining[0]["id"], second_id);
    let wrong_token = core
        .current()
        .await
        .unwrap()
        .rpc
        .call("get_desktop_app_context", json!({"token":"invalid"}))
        .await
        .unwrap();
    assert_eq!(wrong_token["cancelled"], true);
    let wrong_session = core
        .current()
        .await
        .unwrap()
        .rpc
        .call("get_desktop_app_context", json!({"sessionId":"foreign"}))
        .await
        .unwrap();
    assert_eq!(wrong_session["contexts"], json!([]));

    let (earlier, later) = tokio::join!(
        biased;
        message(
            &host,
            &first_label,
            json!(8),
            "ui/update-model-context",
            json!({"structuredContent":{"sequence":1}})
        ),
        message(
            &host,
            &first_label,
            json!(9),
            "ui/update-model-context",
            json!({"structuredContent":{"sequence":2}})
        ),
    );
    assert_eq!(earlier["response"]["result"], json!({}));
    assert_eq!(later["response"]["result"], json!({}));
    assert_eq!(
        contexts(&core)
            .await
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["id"] == first_id)
            .unwrap()["structuredContent"]["sequence"],
        2
    );
    host.close(first_id);
    assert_eq!(contexts(&core).await.as_array().unwrap().len(), 1);
    core.command("prompt", json!({"message":"等待 context update"}))
        .await
        .unwrap();
    let busy_update = message(
        &host,
        &second_label,
        json!(10),
        "ui/update-model-context",
        json!({"structuredContent":{"duringRun":true}}),
    )
    .await;
    assert_eq!(busy_update["response"]["result"], json!({}));
    core.command("abort", json!({})).await.unwrap();
    let snapshot = core.snapshot().await.unwrap();
    assert!(!snapshot["messages"].to_string().contains("duringRun"));
    let entry = snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["role"] == "user")
        .unwrap()["_entryId"]
        .as_str()
        .unwrap();
    core.prepare_message_edit(snapshot["state"]["sessionId"].as_str().unwrap(), entry)
        .await
        .unwrap();
    assert_eq!(contexts(&core).await, json!([]));
    let stale = message(
        &host,
        &second_label,
        json!(11),
        "ui/update-model-context",
        json!({"structuredContent":{"stale":true}}),
    )
    .await;
    assert!(stale["response"]["error"].is_object());
    host.close(second_id);

    let fresh = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let fresh_id = fresh["id"].as_str().unwrap();
    let fresh_label = host
        .activate(
            fresh_id,
            &[],
            false,
            Some(PiAccess {
                binding: core.bind_app_chat().await.unwrap(),
                messages: false,
                model_context: true,
            }),
            json!({}),
            json!({}),
        )
        .unwrap();
    initialize(&host, &fresh_label).await;
    message(
        &host,
        &fresh_label,
        json!(12),
        "ui/update-model-context",
        json!({"structuredContent":{"connected":true}}),
    )
    .await;
    assert_eq!(contexts(&core).await.as_array().unwrap().len(), 1);
    mcp.disconnect("fixture").await;
    assert_eq!(contexts(&core).await, json!([]));
    mcp.connect("fixture").await.unwrap();
    assert_eq!(contexts(&core).await, json!([]));
    host.close(fresh_id);
    let active = core.snapshot().await.unwrap();
    let context = core.bind_app_chat().await.unwrap().model_context(
        "old-binding".into(),
        "source".into(),
        || true,
    );
    context
        .update(&json!({"structuredContent":{"beforeReconnect":true}}))
        .await
        .unwrap();
    assert_eq!(contexts(&core).await.as_array().unwrap().len(), 1);
    core.connect(ConnectOptions {
        cwd: Some(work.to_string_lossy().into_owned()),
        session_path: Some(active["state"]["sessionFile"].as_str().unwrap().to_owned()),
        ..Default::default()
    })
    .await
    .unwrap();
    assert!(context
        .update(&json!({"structuredContent":{"reconnected":true}}))
        .await
        .is_err());
    assert_eq!(contexts(&core).await, json!([]));
    tokio::time::timeout(Duration::from_secs(10), core.shutdown())
        .await
        .unwrap();
    mcp.disconnect("*").await;
}
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
            false,
            None,
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
    for (method, params, grants, resources) in [
        (
            "tools/call",
            json!({"name":"app_failure","arguments":{}}),
            vec!["app_failure".into()],
            false,
        ),
        (
            "resources/read",
            json!({"uri":"fixture://failure"}),
            vec![],
            true,
        ),
    ] {
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
                &grants,
                resources,
                None,
                json!({}),
                json!({}),
            )
            .unwrap();
        initialize(&host, &label).await;
        let response = message(&host, &label, json!(13), method, params).await;
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
}

#[tokio::test]
async fn http_app_resources_share_request_limits_and_discard_results_after_close() {
    use std::{sync::Arc, time::Duration};
    let root = tempfile::tempdir().unwrap();
    let log = root.path().join("resource-http.jsonl");
    let (_fixture, url) = HttpFixture::start(&log);
    let mcp = manager(root.path(), json!({"url":url}));
    let host = Arc::new(McpAppHost::default());
    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let id = prepared["id"].as_str().unwrap();
    let label = host
        .activate(id, &[], false, None, json!({}), json!({}))
        .unwrap();
    initialize(&host, &label).await;
    let denied = message(
        &host,
        &label,
        json!(2),
        "resources/read",
        json!({"uri":"fixture://denied"}),
    )
    .await;
    assert!(denied["response"]["error"].is_object());
    host.close(id);
    let prepared = host.prepare(&mcp, "fixture", "app_view").await.unwrap();
    let id = prepared["id"].as_str().unwrap();
    let label = host
        .activate(
            id,
            &["app_refresh".into()],
            true,
            None,
            json!({}),
            json!({}),
        )
        .unwrap();
    let ready = initialize(&host, &label).await;
    assert!(ready["initializeResult"]["hostCapabilities"]["serverResources"].is_object());
    for uri in ["fixture://hello", "fixture://binary"] {
        let expected = mcp.read_resource("fixture", uri).await.unwrap();
        let response = message(
            &host,
            &label,
            json!(3),
            "resources/read",
            json!({"uri":uri}),
        )
        .await;
        assert_eq!(response["response"]["result"], expected["result"]);
    }
    let mut pending = Vec::new();
    for index in 0..16 {
        if index == 1 {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !fs::read_to_string(&log).unwrap().contains("fixture://held") {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let duplicate = message(
                &host,
                &label,
                json!("held-0"),
                "tools/call",
                json!({"name":"app_refresh"}),
            )
            .await;
            assert!(duplicate["response"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("id 重复"));
        }
        let host = host.clone();
        let label = label.clone();
        pending.push(tokio::spawn(async move {
            message(
                &host,
                &label,
                json!(format!("held-{index}")),
                "resources/read",
                json!({"uri":"fixture://held"}),
            )
            .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if fs::read_to_string(&log)
                .unwrap()
                .lines()
                .filter(|line| line.contains("fixture://held"))
                .count()
                == 16
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let excess = message(
        &host,
        &label,
        json!("excess"),
        "resources/read",
        json!({"uri":"fixture://hello"}),
    )
    .await;
    assert!(excess["response"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("请求过多或 id 重复"));
    host.close(id);
    mcp.call("fixture", "app_refresh", json!({"releaseResources":true}))
        .await
        .unwrap();
    for request in pending {
        let response = request.await.unwrap();
        assert!(response["response"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("关闭"));
        assert!(response["response"]["result"].is_null());
    }
    mcp.disconnect("*").await;
    let records = fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(!records
        .iter()
        .any(|record| record["message"]["params"]["uri"] == "fixture://denied"));
    assert!(records
        .iter()
        .filter(|record| record["message"]["method"] == "resources/read")
        .all(|record| record["headers"]["mcp-session-id"] == "fixture-session"));
}
