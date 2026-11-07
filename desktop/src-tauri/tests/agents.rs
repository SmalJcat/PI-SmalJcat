use anyhow::{Context, Result};
use pi_desktop::agents::{Manager, NewTask, Runner};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

fn runner() -> Runner {
    Runner {
        executable: PathBuf::from("node"),
        prefix: vec![Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixture-pi.mjs")
            .to_string_lossy()
            .into_owned()],
    }
}
fn start(manager: &Arc<Manager>, cwd: &Path, task: &str) -> Result<Value> {
    manager.start(
        NewTask {
            task: task.into(),
            cwd: cwd.to_path_buf(),
            parent_session: "parent-session.jsonl".into(),
            model: "fixture/fixture-model".into(),
            thinking: "medium".into(),
            system_prompt: "Return paths and line numbers.".into(),
            owner: String::new(),
            project_trusted: false,
        },
        runner(),
        None,
    )
}
async fn wait(manager: &Manager, predicate: impl Fn(&Value) -> bool) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let value = manager.list();
            if predicate(&value) {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("task status timed out")
}
fn count(value: &Value, statuses: &[&str]) -> usize {
    value["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|task| statuses.contains(&task["status"].as_str().unwrap_or_default()))
        .count()
}

#[tokio::test]
async fn queue_is_bounded_and_cancellation_shutdown_and_resume_preserve_records() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let work = temp.path().join("work");
    fs::create_dir(&work)?;
    fs::write(work.join("README.md"), "source remains unchanged")?;
    let root = temp.path().join("tasks");
    let locks = temp.path().join("locks");
    let manager = Manager::new(root.clone(), locks.clone())?;
    let mut ids = Vec::new();
    for index in 0..8 {
        ids.push(
            start(&manager, &work, &format!("等待检查任务 {index}"))?["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let result: Result<()> = async {
        wait(&manager, |v| {
            count(v, &["running"]) == 4 && count(v, &["queued"]) == 4
        })
        .await?;
        assert_eq!(manager.pids().len(), 4);
        let sessions = ids
            .iter()
            .take(4)
            .filter_map(|id| manager.detail(id).ok())
            .filter_map(|t| t["sessionPath"].as_str().map(String::from))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(sessions.len(), 4);
        manager.cancel(&ids[7], false)?;
        wait(&manager, |v| {
            v["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["id"] == ids[7] && t["status"] == "cancelled")
        })
        .await?;
        manager.cancel(&ids[0], false)?;
        wait(&manager, |v| {
            v["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["id"] == ids[0] && t["status"] == "cancelled")
        })
        .await?;
        assert_eq!(
            fs::read_to_string(work.join("README.md"))?,
            "source remains unchanged"
        );
        Ok(())
    }
    .await;
    manager.shutdown().await;
    assert!(!manager.busy());
    assert!(manager.pids().is_empty());
    result?;
    let recovered = Manager::new(root, locks)?;
    assert!(count(&recovered.list(), &["interrupted"]) > 0);
    let old_session = recovered.detail(&ids[0])?["sessionPath"].clone();
    recovered.retry(&ids[0], runner(), true)?;
    let resumed = wait(&recovered, |v| {
        v["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == ids[0] && t["status"] == "completed")
    })
    .await;
    recovered.shutdown().await;
    resumed?;
    let detail = recovered.detail(&ids[0])?;
    assert_eq!(detail["sessionPath"], old_session);
    assert_eq!(detail["attempts"], 2);
    assert!(detail["output"].as_str().unwrap().contains("已完成检查"));
    assert!(detail["usage"]["tokens"]["input"].as_u64().unwrap() > 0);
    assert!(detail["usage"]["cost"].as_f64().unwrap() > 0.0);
    Ok(())
}

#[tokio::test]
async fn errors_are_recorded_and_retry_creates_an_independent_session() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let manager = Manager::new(temp.path().join("tasks"), temp.path().join("locks"))?;
    let first = start(&manager, temp.path(), "[fixture-fail-agent]")?;
    let id = first["id"].as_str().unwrap();
    let failed = wait(&manager, |v| count(v, &["failed"]) == 1).await;
    if let Err(error) = failed {
        manager.shutdown().await;
        return Err(error);
    }
    assert!(manager.detail(id)?["error"]
        .as_str()
        .unwrap()
        .contains("fixture provider failed"));
    let retried = manager.retry(id, runner(), false)?;
    let retry_id = retried["id"].as_str().unwrap();
    assert_ne!(id, retry_id);
    assert_eq!(retried["retryOf"], id);
    let result = wait(&manager, |v| count(v, &["failed"]) == 2).await;
    manager.shutdown().await;
    result?;
    assert_ne!(
        manager.detail(id)?["sessionPath"],
        manager.detail(retry_id)?["sessionPath"]
    );
    Ok(())
}

#[tokio::test]
async fn resume_refuses_session_paths_outside_the_task_store() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("tasks");
    fs::create_dir(&root)?;
    let id = uuid::Uuid::new_v4().to_string();
    let outside = temp.path().join("outside.jsonl");
    fs::write(&outside, "untouched")?;
    fs::write(root.join(format!("{id}.json")),json!({"id":id,"status":"interrupted","sessionPath":outside,"cwd":temp.path(),"model":"fixture/fixture-model","thinking":"medium"}).to_string())?;
    let manager = Manager::new(root, temp.path().join("locks"))?;
    assert!(manager.retry(&id, runner(), true).is_err());
    assert!(!manager.busy());
    assert_eq!(fs::read_to_string(outside)?, "untouched");
    Ok(())
}

#[tokio::test]
async fn cancelling_a_parent_tool_does_not_cancel_manual_background_tasks() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let manager = Manager::new(temp.path().join("tasks"), temp.path().join("locks"))?;
    let manual = start(&manager, temp.path(), "等待手动后台任务")?;
    let owned = manager.start(
        NewTask {
            task: "等待父工具任务".into(),
            cwd: temp.path().to_path_buf(),
            parent_session: "parent-session.jsonl".into(),
            model: "fixture/fixture-model".into(),
            thinking: "medium".into(),
            system_prompt: String::new(),
            owner: "parent-call".into(),
            project_trusted: false,
        },
        runner(),
        None,
    )?;
    let result: Result<()> = async {
        wait(&manager, |value| count(value, &["running"]) == 2).await?;
        manager.cancel_owner("parent-call", false);
        wait(&manager, |value| {
            value["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["id"] == owned["id"] && t["status"] == "cancelled")
        })
        .await?;
        assert_eq!(
            manager.detail(manual["id"].as_str().unwrap())?["status"],
            "running"
        );
        Ok(())
    }
    .await;
    manager.shutdown().await;
    result
}

#[tokio::test]
async fn full_result_and_archive_preserve_a_real_fixture_session() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let manager = Manager::new(temp.path().join("tasks"), temp.path().join("locks"))?;
    let task = start(&manager, temp.path(), "[fixture-long-agent]")?;
    let id = task["id"].as_str().unwrap();
    assert!(manager.archive(id, true).is_err());
    assert!(manager.output(id, 0, None).is_err());
    let finished = wait(&manager, |v| {
        count(v, &["completed"]) == 1 && v["active"] == 0
    })
    .await;
    manager.shutdown().await;
    finished?;
    let detail = manager.detail(id)?;
    assert_eq!(detail["truncated"], true);
    let session = PathBuf::from(detail["sessionPath"].as_str().unwrap());
    let bytes = fs::read(&session)?;
    let mut output = String::new();
    let mut offset = Some(0);
    let mut version = None;
    while let Some(next) = offset {
        let page = manager.output(id, next, version.as_deref())?;
        output.push_str(page["text"].as_str().unwrap());
        offset = page["nextOffset"].as_u64().map(|n| n as usize);
        version = page["version"].as_str().map(String::from);
    }
    assert!(output.ends_with("RESULT_END"));
    assert!(output.len() > 128 * 1024);
    manager.archive(id, true)?;
    assert!(manager.retry(id, runner(), false).is_err());
    manager.archive(id, false)?;
    assert_eq!(fs::read(session)?, bytes);
    Ok(())
}
