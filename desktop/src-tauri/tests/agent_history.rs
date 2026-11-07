use anyhow::Result;
use pi_desktop::{
    agent_history,
    agents::{Manager, Runner, Task},
    context::atomic_json,
    session_guard,
};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path};
use uuid::Uuid;

fn save(root: &Path, task: &Task) -> Result<()> {
    atomic_json(
        &root.join(format!("{}.json", task.id)),
        &serde_json::to_value(task)?,
    )
}
fn record(root: &Path, status: &str) -> Result<Task> {
    let id = Uuid::new_v4().to_string();
    let directory = root.join(&id);
    fs::create_dir_all(&directory)?;
    let task: Task = serde_json::from_value(json!({
        "id":id,"status":status,"cwd":root,"task":"探索任务",
        "model":"fixture/model","thinking":"medium","sessionPath":directory.join("session.jsonl")
    }))?;
    fs::write(
        task.session_path.as_ref().unwrap(),
        "{\"type\":\"session\"}\n",
    )?;
    save(root, &task)?;
    Ok(task)
}
fn session(path: &Path, entries: &[Value]) -> Result<()> {
    fs::write(
        path,
        entries
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )?;
    Ok(())
}
#[test]
fn history_search_and_pagination_include_older_than_300_records() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("tasks");
    for index in 1..=305 {
        save(
            &root,
            &serde_json::from_value(json!({
                "id":Uuid::from_u128(index).to_string(),"createdAt":123,
                "task":if index == 1 { "Older needle".into() } else { format!("Task {index}") },
                "cwd":if index % 2 == 0 { "work-a" } else { "work-b" },
                "model":"Fixture/Model","status":"completed"
            }))?,
        )?;
    }
    let manager = Manager::new(root, temp.path().join("locks"))?;
    assert_eq!(manager.list()["total"], 305);
    assert_eq!(manager.list()["tasks"].as_array().unwrap().len(), 300);
    let found = manager.query(&json!({"query":"NEEDLE","page":1,"pageSize":20}))?;
    assert_eq!(found["total"], 1);
    assert_eq!(found["tasks"][0]["id"], Uuid::from_u128(1).to_string());
    let mut ids = Vec::new();
    for page in 1..=16 {
        let value = manager.query(&json!({"page":page,"pageSize":20}))?;
        assert_eq!(value["totalPages"], 16);
        ids.extend(
            value["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|task| task["id"].as_str().unwrap().to_owned()),
        );
    }
    assert_eq!(ids.len(), 305);
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 305);
    assert_eq!(ids.first().unwrap(), &Uuid::from_u128(1).to_string());
    assert_eq!(
        manager.query(&json!({"page":usize::MAX,"pageSize":20}))?["page"],
        16
    );
    assert_eq!(
        manager.query(
            &json!({"query":"fixture/model","cwd":"work-a","status":"completed","page":1})
        )?["total"],
        152
    );
    assert_eq!(
        manager.query(&json!({"query":"not found","page":3}))?["page"],
        1
    );
    for query in [
        json!({"page":0}),
        json!({"pageSize":0}),
        json!({"pageSize":101}),
        json!({"status":"bad"}),
        json!({"archive":"bad"}),
        json!({"query":"a".repeat(1025)}),
    ] {
        assert!(manager.query(&query).is_err());
    }
    Ok(())
}
#[test]
fn archive_roundtrip_keeps_sessions_and_protects_recovery_records() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("tasks");
    let completed = record(&root, "completed")?;
    let protected = [
        "failed",
        "cancelled",
        "interrupted",
        "queued",
        "starting",
        "running",
        "cancelling",
    ]
    .into_iter()
    .map(|status| record(&root, status))
    .collect::<Result<Vec<_>>>()?;
    let bytes = fs::read(completed.session_path.as_ref().unwrap())?;
    let manager = Manager::new(root.clone(), temp.path().join("locks"))?;
    for task in &protected {
        assert!(manager.archive(&task.id, true).is_err());
    }
    manager.archive(&completed.id, true)?;
    assert_eq!(manager.query(&json!({"archive":"archived"}))?["total"], 1);
    assert_eq!(manager.list()["total"], protected.len());
    assert_eq!(fs::read(completed.session_path.as_ref().unwrap())?, bytes);
    drop(manager);
    let manager = Manager::new(root, temp.path().join("locks"))?;
    assert!(manager.detail(&completed.id)?["archivedAt"].is_number());
    manager.archive(&completed.id, false)?;
    assert!(manager.detail(&completed.id)?["archivedAt"].is_null());
    assert_eq!(manager.list()["total"], protected.len() + 1);
    assert_eq!(fs::read(completed.session_path.as_ref().unwrap())?, bytes);
    Ok(())
}
#[test]
fn failed_archive_write_does_not_change_memory() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let task = record(temp.path(), "completed")?;
    let manager = Manager::new(temp.path().into(), temp.path().join("locks"))?;
    let path = temp.path().join(format!("{}.json", task.id));
    fs::rename(&path, path.with_extension("backup"))?;
    fs::create_dir(&path)?;
    assert!(manager.archive(&task.id, true).is_err());
    assert!(manager.detail(&task.id)?["archivedAt"].is_null());
    Ok(())
}
#[test]
fn full_output_pages_follow_branch_and_preserve_utf8_with_version_checks() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let task = record(temp.path(), "completed")?;
    let path = task.session_path.as_ref().unwrap();
    let text = "中文🙂".repeat(20000) + "RESULT_END";
    let entries = [
        json!({"type":"session"}),
        json!({"id":"a","parentId":null,"type":"message","message":{"role":"user","content":"do not show"}}),
        json!({"id":"b","parentId":"a","type":"message","message":{"role":"assistant","content":"abandoned"}}),
        json!({"id":"c","parentId":"a","type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private"},{"type":"text","text":text}]}}),
    ];
    session(path, &entries)?;
    let manager = Manager::new(temp.path().into(), temp.path().join("locks"))?;
    let mut next = Some(0);
    let mut version = None;
    let mut collected = String::new();
    let mut pages = 0;
    while let Some(offset) = next {
        let value = manager.output(&task.id, offset, version.as_deref())?;
        let page = value["text"].as_str().unwrap();
        assert!(page.len() <= 64 * 1024);
        collected.push_str(page);
        pages += 1;
        next = value["nextOffset"].as_u64().map(|n| n as usize);
        version = value["version"].as_str().map(String::from);
    }
    assert!(pages > 2);
    assert_eq!(collected, text);
    assert!(manager.output(&task.id, 1, version.as_deref()).is_err());
    assert!(manager.output(&task.id, 3, None).is_err());
    fs::write(path, format!("{}\n", fs::read_to_string(path)?))?;
    assert!(manager.output(&task.id, 0, version.as_deref()).is_err());
    let lease = session_guard::acquire(&temp.path().join("locks"), path)?;
    assert!(manager.output(&task.id, 0, None).is_err());
    drop(lease);
    assert!(manager.output(&task.id, 0, None).is_ok());
    Ok(())
}
#[test]
fn output_and_resume_reject_other_task_sessions() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut task = record(temp.path(), "interrupted")?;
    let other = record(temp.path(), "completed")?;
    task.session_path = other.session_path.clone();
    save(temp.path(), &task)?;
    let manager = Manager::new(temp.path().into(), temp.path().join("locks"))?;
    assert!(manager.output(&task.id, 0, None).is_err());
    assert!(manager
        .retry(
            &task.id,
            Runner {
                executable: "node".into(),
                prefix: vec![]
            },
            true
        )
        .is_err());
    assert!(other.session_path.unwrap().is_file());
    Ok(())
}
#[test]
fn corrupted_and_oversized_sessions_are_explicit_errors() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("session.jsonl");
    for contents in [
        "{bad",
        "{\"id\":\"a\",\"parentId\":\"a\"}",
        "{\"id\":\"a\",\"parentId\":\"missing\"}",
        "{\"id\":\"a\"}\n{\"id\":\"a\"}",
    ] {
        fs::write(&path, format!("{{\"type\":\"session\"}}\n{contents}"))?;
        assert!(agent_history::session_output(&path).is_err());
    }
    let file = fs::File::create(&path)?;
    file.set_len(64 * 1024 * 1024 + 1)?;
    assert!(agent_history::session_output(&path).is_err());
    let truncated: Task = serde_json::from_value(json!({"truncated":true}))?;
    assert!(agent_history::record_output(&truncated).is_err());
    Ok(())
}
#[cfg(unix)]
#[test]
fn output_rejects_symlink_escape_from_own_task_directory() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let task = record(temp.path(), "completed")?;
    let path = task.session_path.as_ref().unwrap();
    let outside = temp.path().join("outside.jsonl");
    fs::write(&outside, "secret")?;
    fs::remove_file(path)?;
    std::os::unix::fs::symlink(&outside, path)?;
    let manager = Manager::new(temp.path().into(), temp.path().join("locks"))?;
    assert!(manager.output(&task.id, 0, None).is_err());
    assert_eq!(fs::read_to_string(outside)?, "secret");
    Ok(())
}
