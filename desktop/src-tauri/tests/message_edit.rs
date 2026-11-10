use pi_desktop::core::{ConnectOptions, Core};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn source_session(path: &Path, cwd: &Path) {
    let records = [
        json!({"type":"session","version":3,"id":"edit-source","cwd":cwd,"timestamp":"2026-11-09T00:00:00.000Z"}),
        json!({"type":"model_change","id":"c0000001","parentId":null,"provider":"edit-check","modelId":"metadata-only","timestamp":"2026-11-09T00:00:00.000Z"}),
        json!({"type":"message","id":"a0000001","parentId":"c0000001","timestamp":"2026-11-09T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"first prompt"}],"timestamp":1794182401000_u64}}),
        json!({"type":"message","id":"b0000001","parentId":"a0000001","timestamp":"2026-11-09T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"first answer"}],"api":"openai-completions","provider":"edit-check","model":"metadata-only","stopReason":"stop","timestamp":1794182402000_u64,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}),
        json!({"type":"message","id":"a0000002","parentId":"b0000001","timestamp":"2026-11-09T00:00:03.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1794182403000_u64}}),
        json!({"type":"message","id":"b0000002","parentId":"a0000002","timestamp":"2026-11-09T00:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"old second answer"}],"api":"openai-completions","provider":"edit-check","model":"metadata-only","stopReason":"stop","timestamp":1794182404000_u64,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}),
    ];
    fs::write(
        path,
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
}

#[tokio::test]
#[cfg(feature = "test-fixture")]
async fn editing_stays_in_session_and_rejects_stale_busy_or_cancelled_targets() {
    use std::{path::PathBuf, time::Duration};
    std::env::set_var("PI_DESKTOP_TEST", "1");
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    fs::create_dir(&work).unwrap();
    std::env::set_var("PI_DESKTOP_EXECUTABLE", "node");
    std::env::set_var(
        "PI_DESKTOP_RPC_SCRIPT",
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixture-pi.mjs"),
    );
    std::env::set_var("PI_CODING_AGENT_DIR", root.path().join("agent"));
    std::env::set_var("PI_CODING_AGENT_SESSION_DIR", root.path().join("sessions"));
    let source = root.path().join("source.jsonl");
    source_session(&source, &work);
    let core = Core::new(&root.path().join("profile")).unwrap();
    let before = core
        .connect(ConnectOptions {
            cwd: Some(work.to_string_lossy().into_owned()),
            session_path: Some(source.to_string_lossy().into_owned()),
            fork: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let id = before["state"]["sessionId"].as_str().unwrap();
    assert!(core
        .prepare_message_edit("stale-session", "a0000002")
        .await
        .is_err());
    assert!(core
        .prepare_message_edit(id, "missing-entry")
        .await
        .is_err());
    assert_eq!(
        core.snapshot().await.unwrap()["messages"],
        before["messages"]
    );
    let edited = core.prepare_message_edit(id, "a0000002").await.unwrap();
    let new_id = edited["snapshot"]["state"]["sessionId"].as_str().unwrap();
    assert_eq!(id, new_id);
    assert_eq!(
        edited["snapshot"]["state"]["sessionFile"],
        before["state"]["sessionFile"]
    );
    assert!(!edited["snapshot"]["messages"].to_string().contains("hello"));
    assert!(edited["snapshot"]["messages"]
        .to_string()
        .contains("first answer"));
    assert!(
        fs::read_to_string(before["state"]["sessionFile"].as_str().unwrap())
            .unwrap()
            .contains("old second answer")
    );
    assert!(!edited["snapshot"]["messages"]
        .to_string()
        .contains("old second answer"));
    assert!(fs::read_to_string(&source)
        .unwrap()
        .contains("old second answer"));
    let prepared_bytes = fs::read(before["state"]["sessionFile"].as_str().unwrap()).unwrap();
    let retry = core.prepare_message_edit(id, "a0000002").await.unwrap();
    assert_eq!(
        retry["snapshot"]["messages"],
        edited["snapshot"]["messages"]
    );
    assert_eq!(
        fs::read(before["state"]["sessionFile"].as_str().unwrap()).unwrap(),
        prepared_bytes
    );
    assert!(core
        .command(
            "prompt",
            json!({"message":"stale edit", "expectedSessionId":"stale-session"})
        )
        .await
        .is_err());
    assert!(core
        .command(
            "prompt",
            json!({"message":"[edit-send-fail]", "expectedSessionId":new_id})
        )
        .await
        .is_err());
    assert_eq!(core.snapshot().await.unwrap()["state"]["sessionId"], new_id);
    core.command(
        "prompt",
        json!({"message":"[edit-cancel]", "expectedSessionId":new_id}),
    )
    .await
    .unwrap();
    let idle = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = core.snapshot().await.unwrap();
            if snapshot["state"]["isStreaming"] == false {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    let target = idle["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "user" && message["content"] == "[edit-cancel]")
        .unwrap();
    assert_eq!(
        core.prepare_message_edit(new_id, target["_entryId"].as_str().unwrap())
            .await
            .unwrap()["cancelled"],
        true
    );
    assert_eq!(core.snapshot().await.unwrap()["messages"], idle["messages"]);
    core.command(
        "prompt",
        json!({"message":"等待编辑", "expectedSessionId":new_id}),
    )
    .await
    .unwrap();
    assert!(core
        .prepare_message_edit(new_id, target["_entryId"].as_str().unwrap())
        .await
        .is_err());
    core.command("abort", json!({})).await.unwrap();
    core.shutdown().await;
}

#[tokio::test]
#[ignore = "Uses installed Pi tree navigation API only, without model requests"]
async fn installed_pi_edit_contract_preserves_session_and_excludes_selected_message() {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    let agent = root.path().join("agent");
    fs::create_dir(&work).unwrap();
    fs::create_dir(&agent).unwrap();
    fs::write(
        agent.join("settings.json"),
        json!({"defaultProvider":"edit-check","defaultModel":"metadata-only"}).to_string(),
    )
    .unwrap();
    fs::write(agent.join("models.json"),json!({"providers":{"edit-check":{"api":"openai-completions","baseUrl":"http://127.0.0.1:1/v1","apiKey":"test-only","models":[{"id":"metadata-only","contextWindow":200000,"maxTokens":1024}]}}}).to_string()).unwrap();
    std::env::set_var("PI_DESKTOP_EXECUTABLE", "D:/PI/pi.exe");
    std::env::set_var("PI_CODING_AGENT_DIR", &agent);
    std::env::set_var("PI_CODING_AGENT_SESSION_DIR", root.path().join("sessions"));
    let source = root.path().join("source.jsonl");
    source_session(&source, &work);
    let core = Core::new(&root.path().join("profile")).unwrap();
    let before = core
        .connect(ConnectOptions {
            cwd: Some(work.to_string_lossy().into_owned()),
            session_path: Some(source.to_string_lossy().into_owned()),
            fork: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let selected = before["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| {
            message["role"] == "user" && message["content"].to_string().contains("hello")
        })
        .unwrap();
    let old_file = before["state"]["sessionFile"].as_str().unwrap().to_owned();
    let result = core
        .prepare_message_edit(
            before["state"]["sessionId"].as_str().unwrap(),
            selected["_entryId"].as_str().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result["cancelled"], false);
    assert_eq!(
        result["snapshot"]["state"]["sessionId"],
        before["state"]["sessionId"]
    );
    assert_eq!(
        result["snapshot"]["state"]["sessionFile"],
        before["state"]["sessionFile"]
    );
    assert!(!result["snapshot"]["messages"].to_string().contains("hello"));
    assert!(!result["snapshot"]["messages"]
        .to_string()
        .contains("old second answer"));
    assert!(result["snapshot"]["messages"]
        .to_string()
        .contains("first answer"));
    assert!(fs::read_to_string(&old_file)
        .unwrap()
        .contains("old second answer"));
    core.command(
        "set_session_name",
        json!({"name":"Edited branch metadata check"}),
    )
    .await
    .unwrap();
    // Editing the first prompt also works, with no preceding user/assistant messages.
    let first = core
        .prepare_message_edit(before["state"]["sessionId"].as_str().unwrap(), "a0000001")
        .await
        .unwrap();
    assert_eq!(first["snapshot"]["messages"], json!([]));
    assert_eq!(
        first["snapshot"]["state"]["sessionId"],
        before["state"]["sessionId"]
    );
    // The branch marker must survive reconnect even before a replacement is sent.
    let reopened = core
        .connect(ConnectOptions {
            cwd: Some(work.to_string_lossy().into_owned()),
            session_path: Some(old_file.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(reopened["state"]["sessionId"], before["state"]["sessionId"]);
    assert_eq!(reopened["messages"], json!([]));
    assert!(fs::read_to_string(&old_file)
        .unwrap()
        .contains("old second answer"));
    let reopened_bytes = fs::read(&old_file).unwrap();
    let retry = core
        .prepare_message_edit(before["state"]["sessionId"].as_str().unwrap(), "a0000001")
        .await
        .unwrap();
    assert_eq!(retry["snapshot"]["messages"], json!([]));
    assert_eq!(fs::read(&old_file).unwrap(), reopened_bytes);
    assert!(core
        .prepare_message_edit(before["state"]["sessionId"].as_str().unwrap(), "a0000002")
        .await
        .is_err());
    core.shutdown().await;
    println!("Official Pi edit keeps session ID/file, preserves old history, excludes selected messages, and persists across reconnect; model requests: 0.");
}
