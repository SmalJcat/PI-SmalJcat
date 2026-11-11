use pi_desktop::{
    permissions::{Manager, Mode, Rules},
    rpc::Rpc,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

#[test]
fn native_policy_checks_workspace_boundaries_rules_and_protected_configuration() {
    use pi_desktop::permissions::{decide_pi, Policy};
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    let profile = root.path().join("profile");
    std::fs::create_dir_all(work.join(".git")).unwrap();
    std::fs::create_dir(&profile).unwrap();
    let mut policy = Policy {
        mode: Mode::Ask,
        protected_paths: vec![profile.clone()],
        ..Default::default()
    };
    assert_eq!(
        decide_pi(&policy, "read", &json!({"path":"README.md"}), &work),
        Some(true)
    );
    assert_eq!(
        decide_pi(&policy, "write", &json!({"path":"new.txt"}), &work),
        None
    );
    policy.mode = Mode::Smart;
    assert_eq!(
        decide_pi(&policy, "write", &json!({"path":"nested/new.txt"}), &work),
        Some(true)
    );
    for target in [
        "../outside.txt",
        ".git/config",
        "~/private",
        "%USERPROFILE%/private",
        "https://site.test/x",
    ] {
        assert_eq!(
            decide_pi(&policy, "write", &json!({"path":target}), &work),
            None
        );
    }
    for tool in ["bash", "powershell", "mcp__server__read", "unknown"] {
        assert_eq!(
            decide_pi(&policy, tool, &json!({"command":"echo anything"}), &work),
            None
        );
    }
    let outside = root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    let status=std::process::Command::new("node").args(["-e","require('fs').symlinkSync(process.argv[1],process.argv[2],process.platform==='win32'?'junction':'dir')"]).arg(&outside).arg(work.join("junction")).status().unwrap();
    assert!(status.success());
    assert_eq!(
        decide_pi(&policy, "write", &json!({"path":"junction/new.txt"}), &work),
        None
    );
    policy.mode = Mode::Custom;
    policy.rules.allow_tools = vec!["*".into()];
    policy.rules.deny_tools = vec!["bash".into()];
    assert_eq!(decide_pi(&policy, "bash", &json!({}), &work), Some(false));
    assert_eq!(
        decide_pi(
            &policy,
            "write",
            &json!({"path":profile.join("active-policy.json")}),
            root.path()
        ),
        None,
        "An agent cannot auto-edit the approval host configuration even in a broad workspace"
    );
    policy.mode = Mode::FullAccess;
    assert_eq!(
        decide_pi(&policy, "powershell", &json!({}), &work),
        Some(true)
    );
}

#[test]
fn protected_configuration_aliases_require_approval() {
    use pi_desktop::permissions::{decide_pi, Policy};
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    let profile = root.path().join("profile");
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir(&profile).unwrap();
    std::fs::write(profile.join("existing.json"), "{}").unwrap();
    let alias = work.join("configuration-alias");
    let status = std::process::Command::new("node")
        .args([
            "-e",
            "require('fs').symlinkSync(process.argv[1],process.argv[2],process.platform==='win32'?'junction':'dir')",
        ])
        .arg(&profile)
        .arg(&alias)
        .status()
        .unwrap();
    assert!(status.success());
    let policy = Policy {
        mode: Mode::Custom,
        rules: Rules {
            allow_tools: vec!["*".into()],
            ..Default::default()
        },
        protected_paths: vec![profile],
    };
    for target in [alias.join("existing.json"), alias.join("nested/new.json")] {
        for tool in ["write", "edit"] {
            assert_eq!(
                decide_pi(&policy, tool, &json!({"path": target}), &work),
                None,
                "Protected configuration aliases must require approval"
            );
        }
    }
}

#[test]
fn rules_validate_and_default_back_to_ask_without_losing_custom_rules() {
    let root = tempfile::tempdir().unwrap();
    let manager = Manager::new(root.path().into()).unwrap();
    let rules = Rules {
        allow_tools: vec!["read".into(), "mcp__safe__*".into()],
        deny_tools: vec!["bash".into()],
        ..Default::default()
    };
    manager.set(Mode::Custom, Some(rules)).unwrap();
    assert_eq!(manager.status()["mode"], "custom");
    assert!(
        !root.path().join("active-policy.json").exists(),
        "Approval mode stays in native memory"
    );
    let reopened = Manager::new(root.path().into()).unwrap();
    assert_eq!(reopened.status()["mode"], "ask");
    assert_eq!(reopened.status()["rules"]["denyTools"], json!(["bash"]));
    let invalid = Rules {
        allow_tools: vec!["rm; secret".into()],
        ..Default::default()
    };
    assert!(manager.set(Mode::Custom, Some(invalid)).is_err());
    assert_eq!(manager.status()["mode"], "custom");
    std::fs::write(root.path().join("permissions.json"), "{bad").unwrap();
    let invalid = Manager::new(root.path().into()).unwrap();
    assert_eq!(invalid.status()["mode"], "ask");
    assert!(invalid.set(Mode::Custom, None).is_err());
}
#[tokio::test]
#[cfg(feature = "test-fixture")]
async fn pi_broker_matches_requests_and_deny_does_not_execute_the_tool() {
    use pi_desktop::core::{ConnectOptions, Core};
    use std::time::Duration;
    std::env::set_var("PI_DESKTOP_TEST", "1");
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    std::env::set_var(
        "PI_DESKTOP_EXECUTABLE",
        std::env::var("NODE_EXE").unwrap_or_else(|_| "node".into()),
    );
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
    core.command("prompt", json!({"message":"/context-priority-test"}))
        .await
        .unwrap();
    assert_eq!(
        core.context_usage().await.unwrap()["usage"]["tokens"],
        1200,
        "A fresh RPC estimate takes precedence over an earlier pushed estimate"
    );
    core.command("prompt", json!({"message":"/permission-write-test"}))
        .await
        .unwrap();
    let request = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let status = core.agents.permissions.status();
            if let Some(first) = status["requests"].as_array().unwrap().first() {
                break first.clone();
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .unwrap();
    assert!(!work.join("approved.txt").exists());
    core.permission_action(json!({"action":"reply","id":request["id"],"allow":false}))
        .await
        .unwrap();
    assert!(core
        .permission_action(json!({"action":"reply","id":request["id"],"allow":true}))
        .await
        .is_err());
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!work.join("approved.txt").exists());
    core.command("prompt", json!({"message":"/permission-write-test"}))
        .await
        .unwrap();
    let id = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let status = core.agents.permissions.status();
            if let Some(first) = status["requests"].as_array().unwrap().first() {
                break first["id"].as_str().unwrap().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .unwrap();
    core.permission_action(json!({"action":"reply","id":id,"allow":true}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !work.join("approved.txt").exists() {
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .unwrap();
    core.shutdown().await;
}
#[tokio::test]
#[ignore = "Uses installed Pi to verify the real extension contract without model requests"]
async fn installed_pi_main_and_child_load_real_gate() {
    let root = tempfile::tempdir().unwrap();
    let manager = Manager::new(root.path().join("policy")).unwrap();
    let executable = PathBuf::from("D:/PI/pi.exe");
    let agent = root.path().join("agent");
    std::fs::create_dir(&agent).unwrap();
    std::fs::write(
        agent.join("settings.json"),
        json!({"defaultProvider":"permission-check","defaultModel":"metadata-only"}).to_string(),
    )
    .unwrap();
    std::fs::write(agent.join("models.json"),json!({"providers":{"permission-check":{"api":"openai-completions","baseUrl":"http://127.0.0.1:1/v1","apiKey":"test-only","models":[{"id":"metadata-only","contextWindow":200000,"maxTokens":1024}]}}}).to_string()).unwrap();
    let mut environment = manager.environment();
    environment.push((
        "PI_CODING_AGENT_DIR".into(),
        agent.to_string_lossy().into_owned(),
    ));
    let args = vec![
        "--offline".into(),
        "--no-extensions".into(),
        "--no-mcp".into(),
        "--tools".into(),
        "read,grep,find,ls".into(),
        "-e".into(),
        manager.extension_path.to_string_lossy().into_owned(),
        "--no-session".into(),
    ];
    let binding = Arc::new(std::sync::Mutex::new(std::sync::Weak::<Rpc>::new()));
    let source = binding.clone();
    let gate = Arc::downgrade(&manager);
    let sink: pi_desktop::rpc::EventSink = Arc::new(move |event| {
        if event["title"] == "PI_DESKTOP_PERMISSION_QUERY" {
            if let (Some(manager), Some(rpc)) = (gate.upgrade(), source.lock().unwrap().upgrade()) {
                tokio::spawn(async move {
                    manager.answer_query(&rpc, &event).await;
                });
            }
        }
    });
    let rpc = Rpc::spawn(&executable, root.path(), &[], &args, sink, &environment)
        .await
        .unwrap();
    *binding.lock().unwrap() = Arc::downgrade(&rpc);
    manager.verify(&rpc, &manager.extension_path).await.unwrap();
    manager.set(Mode::Smart, None).unwrap();
    let nonce = uuid::Uuid::new_v4().to_string();
    let cursor = rpc.notification_cursor();
    rpc.call(
        "prompt",
        json!({"message":format!("/desktop-permissions {nonce}")}),
    )
    .await
    .unwrap();
    let prefix = format!("PI_DESKTOP_PERMISSIONS:{nonce}:");
    let policy = rpc
        .notifications_after(cursor)
        .iter()
        .find_map(|event| {
            event["message"]
                .as_str()
                .and_then(|text| text.strip_prefix(&prefix))
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        })
        .unwrap();
    assert_eq!(policy["mode"], "smart");
    rpc.stop().await;
    println!("Official Pi explicit gate and live policy read verified; model requests: 0.");
}
