use pi_desktop::antigravity::{Antigravity, LaunchSpec};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};

fn fixture(root: &std::path::Path) -> Arc<Antigravity> {
    Antigravity::with_launcher(
        root.join("desktop-data"),
        Some(LaunchSpec {
            executable: PathBuf::from(env!("CARGO_BIN_EXE_acp-fixture")),
            args: vec![],
        }),
    )
}
async fn until(manager: &Antigravity, predicate: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let state = manager.status();
            if predicate(&state) {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("ACP fixture did not settle")
}
#[tokio::test]
async fn handshake_stream_config_cache_resume_and_shutdown() {
    let root = tempfile::tempdir().unwrap();
    let manager = fixture(root.path());
    let connected = manager.connect(root.path(), None).await.unwrap();
    let id = connected["sessionId"].as_str().unwrap().to_owned();
    manager.configure("model", "claude-fixture").await.unwrap();
    manager.configure("thought_level", "high").await.unwrap();
    assert!(manager.configure("model", "unknown").await.is_err());
    manager.prompt("hello", &[]).await.unwrap();
    let complete = until(&manager, |state| state["busy"] == false).await;
    assert!(complete["messages"].to_string().contains("ACP 中文🙂 完成"));
    assert_eq!(complete["messages"][1]["model"], "Claude fixture");
    assert_eq!(
        complete["configOptions"][0]["currentValue"],
        "claude-fixture"
    );
    manager.session(None).await.unwrap();
    assert!(manager.status()["messages"].as_array().unwrap().is_empty());
    manager.session(Some(&id)).await.unwrap();
    assert_eq!(manager.status()["messages"], complete["messages"]);
    assert!(manager.session(Some("../outside")).await.is_err());
    manager.shutdown().await;
    assert_eq!(manager.status()["connected"], false);
    let reopened = fixture(root.path());
    reopened.connect(root.path(), None).await.unwrap();
    reopened.session(Some(&id)).await.unwrap();
    assert_eq!(reopened.status()["messages"], complete["messages"]);
    reopened.shutdown().await;
}
#[tokio::test]
async fn session_load_replay_replaces_cached_messages_without_duplicates() {
    let root = tempfile::tempdir().unwrap();
    let manager = Antigravity::with_launcher(
        root.path().join("desktop-data"),
        Some(LaunchSpec {
            executable: PathBuf::from(env!("CARGO_BIN_EXE_acp-fixture")),
            args: vec!["--no-resume".into()],
        }),
    );
    let state = manager.connect(root.path(), None).await.unwrap();
    let id = state["sessionId"].as_str().unwrap().to_owned();
    manager.prompt("replay marker", &[]).await.unwrap();
    until(&manager, |state| state["busy"] == false).await;
    manager.session(None).await.unwrap();
    manager.session(Some(&id)).await.unwrap();
    let replay = manager.status();
    assert_eq!(replay["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        replay["messages"]
            .to_string()
            .matches("replay marker")
            .count(),
        1
    );
    manager.shutdown().await;
}
#[tokio::test]
async fn permission_is_explicit_and_cancel_clears_pending_requests() {
    let root = tempfile::tempdir().unwrap();
    let manager = fixture(root.path());
    manager.connect(root.path(), None).await.unwrap();
    manager.prompt("[permission]", &[]).await.unwrap();
    let waiting = until(&manager, |state| {
        !state["permissions"].as_array().unwrap().is_empty()
    })
    .await;
    let id = waiting["permissions"][0]["id"].as_str().unwrap();
    assert!(manager
        .permission(id, Some("invalid-option"))
        .await
        .is_err());
    assert!(manager.busy());
    manager.permission(id, Some("allow")).await.unwrap();
    let done = until(&manager, |state| state["busy"] == false).await;
    assert!(done["tools"].to_string().contains("ACP_PERMISSION_ALLOWED"));
    assert!(manager.permission(id, Some("allow")).await.is_err());
    manager.prompt("[permission]", &[]).await.unwrap();
    until(&manager, |state| {
        !state["permissions"].as_array().unwrap().is_empty()
    })
    .await;
    manager.cancel().await.unwrap();
    let cancelled = until(&manager, |state| state["busy"] == false).await;
    assert!(cancelled["permissions"].as_array().unwrap().is_empty());
    manager.prompt("[wait]", &[]).await.unwrap();
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert_eq!(
        manager.status()["connected"],
        true,
        "A previous cancellation watchdog must not kill a later turn"
    );
    assert!(manager.configure("model", "gemini-fixture").await.is_err());
    manager.cancel().await.unwrap();
    until(&manager, |state| state["busy"] == false).await;
    manager.shutdown().await;
}
#[tokio::test]
async fn abrupt_exit_and_unresponsive_cancel_release_the_transport() {
    let root = tempfile::tempdir().unwrap();
    let manager = fixture(root.path());
    manager.connect(root.path(), None).await.unwrap();
    manager.prompt("[exit]", &[]).await.unwrap();
    until(&manager, |state| state["connected"] == false).await;
    manager.connect(root.path(), None).await.unwrap();
    manager.prompt("[hang]", &[]).await.unwrap();
    manager.cancel().await.unwrap();
    until(&manager, |state| state["connected"] == false).await;
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "Uses installed official CLI and cached login; set PI_DESKTOP_ACP_MODEL_TEST=1 for one short model request"]
async fn installed_official_cli() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("README.md"), "ACP_INTEGRATION_OK").unwrap();
    let manager = Antigravity::new(root.path().join("desktop-data"));
    let state = manager.connect(root.path(), None).await.unwrap();
    assert_eq!(state["agentInfo"]["name"], "Antigravity ACP Server");
    manager.configure("model", "claude-opus-5-5").await.unwrap();
    manager.configure("thought_level", "low").await.unwrap();
    assert!(manager.list().await.unwrap()["sessions"].is_array());
    let first_session = state["sessionId"].as_str().unwrap().to_owned();
    manager.session(None).await.unwrap();
    manager.session(Some(&first_session)).await.unwrap();
    assert_eq!(manager.status()["sessionId"], first_session);
    if std::env::var("PI_DESKTOP_ACP_MODEL_TEST").as_deref() == Ok("1") {
        manager.prompt("Read README.md without editing files or running commands. Reply only with the exact marker in it.",&[]).await.unwrap();
        let done = tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                let state = manager.status();
                if state["busy"] == false {
                    return state;
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(done["error"], "", "{}", done["error"]);
        assert!(done["messages"].to_string().contains("ACP_INTEGRATION_OK"));
        println!("Official ACP model and read-only tool request completed; desktop transcript is independent.");
    } else {
        println!("Official ACP initialize/session/config verified; model requests: 0.");
    }
    manager.shutdown().await;
}
