use pi_desktop::antigravity::{Antigravity, LaunchSpec};
use serde_json::{json, Value};
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
    assert_eq!(
        reopened.status()["configOptions"][0]["currentValue"],
        "claude-fixture"
    );
    assert_eq!(
        reopened.status()["configOptions"][1]["currentValue"],
        "high"
    );
    reopened.shutdown().await;
}
#[tokio::test]
async fn permission_mode_restarts_same_session_and_reconnect_keeps_config() {
    let root = tempfile::tempdir().unwrap();
    let manager = fixture(root.path());
    let original = manager.connect(root.path(), None).await.unwrap();
    assert_eq!(original["permissionMode"], "ask");
    assert!(manager.set_permission_mode("invalid").await.is_err());
    manager.configure("model", "claude-fixture").await.unwrap();
    manager.configure("thought_level", "high").await.unwrap();
    manager.prompt("preserved conversation", &[]).await.unwrap();
    let before = until(&manager, |state| state["busy"] == false).await;
    let full = manager.set_permission_mode("full-access").await.unwrap();
    assert_eq!(full["permissionMode"], "full-access");
    assert_ne!(full["pid"], before["pid"]);
    assert_eq!(full["sessionId"], before["sessionId"]);
    assert_eq!(full["messages"], before["messages"]);
    assert_eq!(full["configOptions"], before["configOptions"]);
    manager.prompt("[permission]", &[]).await.unwrap();
    let approved = until(&manager, |state| state["busy"] == false).await;
    assert!(approved["tools"]
        .to_string()
        .contains("ACP_PERMISSION_ALLOWED"));
    assert!(approved["permissions"].as_array().unwrap().is_empty());
    let ask = manager.set_permission_mode("ask").await.unwrap();
    assert_ne!(ask["pid"], full["pid"]);
    manager.prompt("[permission]", &[]).await.unwrap();
    until(&manager, |state| {
        !state["permissions"].as_array().unwrap().is_empty()
    })
    .await;
    assert!(manager.set_permission_mode("full-access").await.is_err());
    assert_eq!(manager.status()["pid"], ask["pid"]);
    manager.cancel().await.unwrap();
    until(&manager, |state| state["busy"] == false).await;
    manager.shutdown().await;
    let before = manager.status();
    let reconnected = manager.connect(root.path(), None).await.unwrap();
    assert_eq!(reconnected["sessionId"], before["sessionId"]);
    assert_eq!(reconnected["messages"], before["messages"]);
    assert_eq!(reconnected["configOptions"], before["configOptions"]);
    manager.shutdown().await;
}
#[tokio::test]
async fn failed_permission_restart_preserves_conversation_and_previous_policy() {
    let root = tempfile::tempdir().unwrap();
    let manager = Antigravity::with_launcher(
        root.path().join("desktop-data"),
        Some(LaunchSpec {
            executable: PathBuf::from(env!("CARGO_BIN_EXE_acp-fixture")),
            args: vec!["--fail-full-access".into()],
        }),
    );
    manager.connect(root.path(), None).await.unwrap();
    manager
        .prompt("keep after restart failure", &[])
        .await
        .unwrap();
    let before = until(&manager, |state| state["busy"] == false).await;
    assert!(manager.set_permission_mode("full-access").await.is_err());
    let failed = manager.status();
    assert_eq!(failed["connected"], false);
    assert_eq!(failed["permissionMode"], "ask");
    assert_eq!(failed["sessionId"], before["sessionId"]);
    assert_eq!(failed["messages"], before["messages"]);
    let recovered = manager.connect(root.path(), None).await.unwrap();
    assert_eq!(recovered["messages"], before["messages"]);
    manager.shutdown().await;
    let restrictive = Antigravity::with_launcher(
        root.path().join("restrictive"),
        Some(LaunchSpec {
            executable: PathBuf::from(env!("CARGO_BIN_EXE_acp-fixture")),
            args: vec!["--fail-ask".into()],
        }),
    );
    restrictive
        .set_permission_mode("full-access")
        .await
        .unwrap();
    restrictive.connect(root.path(), None).await.unwrap();
    assert!(restrictive.set_permission_mode("ask").await.is_err());
    assert_eq!(restrictive.status()["permissionMode"], "ask");
    assert_eq!(restrictive.status()["connected"], false);
    assert!(
        restrictive.connect(root.path(), None).await.is_err(),
        "Retry must not silently enable full access"
    );
    restrictive.shutdown().await;
}
#[tokio::test]
async fn long_unicode_stream_and_images_survive_cache_restore() {
    let root = tempfile::tempdir().unwrap();
    let manager = fixture(root.path());
    let initial = manager.connect(root.path(), None).await.unwrap();
    manager.prompt("[long]", &[]).await.unwrap();
    let complete = until(&manager, |state| state["busy"] == false).await;
    let text = complete["messages"][1]["content"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|block| block["text"].as_str())
        .unwrap();
    assert_eq!(text.matches("长输出🙂").count(), 2048);
    assert!(text.ends_with("ACP_LONG_END🙂 完成"));
    let image = json!({"mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII="});
    manager
        .prompt("", std::slice::from_ref(&image))
        .await
        .unwrap();
    let complete = until(&manager, |state| state["busy"] == false).await;
    assert!(complete["messages"]
        .to_string()
        .contains("ACP_IMAGE_COUNT:1"));
    assert!(manager
        .prompt(
            "bad attachment",
            &[json!({"mimeType":"text/html","data":"bad"})]
        )
        .await
        .is_err());
    assert_eq!(manager.status()["messages"], complete["messages"]);
    manager.shutdown().await;
    let reopened = fixture(root.path());
    reopened.connect(root.path(), None).await.unwrap();
    reopened
        .session(Some(initial["sessionId"].as_str().unwrap()))
        .await
        .unwrap();
    assert_eq!(reopened.status()["messages"], complete["messages"]);
    reopened.shutdown().await;
    let no_images = Antigravity::with_launcher(
        root.path().join("without-images"),
        Some(LaunchSpec {
            executable: PathBuf::from(env!("CARGO_BIN_EXE_acp-fixture")),
            args: vec!["--no-images".into()],
        }),
    );
    no_images.connect(root.path(), None).await.unwrap();
    assert!(no_images.prompt("", &[image]).await.is_err());
    assert!(no_images.status()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    no_images.shutdown().await;
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
    for mode in ["full-access", "ask"] {
        let updated = manager.set_permission_mode(mode).await.unwrap();
        assert_eq!(updated["sessionId"], first_session);
        assert_eq!(updated["permissionMode"], mode);
        assert_eq!(
            updated["configOptions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| option["id"] == "model")
                .unwrap()["currentValue"],
            "claude-opus-5-5"
        );
    }
    manager.shutdown().await;
    let manager = Antigravity::new(root.path().join("desktop-data"));
    manager.connect(root.path(), None).await.unwrap();
    let reopened = manager.session(Some(&first_session)).await.unwrap();
    for (id, value) in [("model", "claude-opus-5-5"), ("thought_level", "low")] {
        assert_eq!(
            reopened["configOptions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| option["id"] == id)
                .unwrap()["currentValue"],
            value
        );
    }
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
