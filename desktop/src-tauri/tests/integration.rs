use anyhow::Result;
use pi_desktop::{
    rpc::{EventSink, Rpc},
    workspace,
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio::process::Command;

fn fixture_path() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixture-pi.mjs")
        .to_string_lossy()
        .into_owned()
}
#[tokio::test]
async fn rpc_correlation_timeout_stop_and_recovery() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let sink: EventSink = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let rpc = Rpc::spawn(
        Path::new("node"),
        temp.path(),
        &[fixture_path()],
        &["--no-session".into()],
        sink,
        &[(
            "PI_CODING_AGENT_DIR".into(),
            temp.path().to_string_lossy().into_owned(),
        )],
    )
    .await?;
    let result: Result<()> = async {
        let (slow, fast) = tokio::try_join!(
            rpc.call("echo", json!({"value":"slow","delay":40})),
            rpc.call("echo", json!({"value":"fast","delay":1}))
        )?;
        assert_eq!(slow["value"], "slow");
        assert_eq!(fast["value"], "fast");
        assert!(rpc
            .request("hang", json!({}), Duration::from_millis(40))
            .await
            .is_err());
        assert!(rpc.call("invalid", json!({})).await.is_err());
        assert_eq!(
            rpc.call("get_state", json!({})).await?["isStreaming"],
            false
        );
        rpc.call("prompt", json!({"message":"等待停止"})).await?;
        assert!(rpc.busy.load(Ordering::SeqCst));
        rpc.call(
            "prompt",
            json!({"message":"稍后任务","streamingBehavior":"followUp"}),
        )
        .await?;
        let queue = rpc.call("clear_queue", json!({})).await?;
        assert_eq!(queue["followUp"][0], "稍后任务");
        rpc.call("abort", json!({})).await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = receiver.recv().await {
                if event["type"] == "agent_settled" {
                    break;
                }
            }
        })
        .await?;
        assert!(!rpc.busy.load(Ordering::SeqCst));
        Ok(())
    }
    .await;
    rpc.stop().await;
    assert!(rpc.closed.load(Ordering::SeqCst));
    result
}
#[tokio::test]
async fn blocked_stdin_write_does_not_block_shutdown() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let script = temp.path().join("blocked.cjs");
    std::fs::write(&script, "setInterval(()=>{},1000)")?;
    let rpc = Rpc::spawn(
        Path::new("node"),
        temp.path(),
        &[script.to_string_lossy().into_owned()],
        &[],
        Arc::new(|_| {}),
        &[],
    )
    .await?;
    let sending_rpc = rpc.clone();
    let write = tokio::spawn(async move {
        sending_rpc
            .call("large", json!({"text":"x".repeat(8 * 1024 * 1024)}))
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    tokio::time::timeout(Duration::from_secs(6), rpc.stop()).await?;
    assert!(tokio::time::timeout(Duration::from_secs(1), write)
        .await??
        .is_err());
    assert!(rpc.closed.load(Ordering::SeqCst));
    Ok(())
}
#[tokio::test]
async fn abrupt_exit_rejects_pending_requests() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let script = temp.path().join("exit.cjs");
    std::fs::write(&script, "setTimeout(() => process.exit(7), 120)")?;
    let rpc = Rpc::spawn(
        Path::new("node"),
        temp.path(),
        &[script.to_string_lossy().into_owned()],
        &[],
        Arc::new(|_| {}),
        &[],
    )
    .await?;
    let request = rpc
        .request("never", json!({}), Duration::from_secs(3))
        .await;
    assert!(request.is_err());
    assert!(rpc.closed.load(Ordering::SeqCst));
    rpc.stop().await;
    Ok(())
}
#[cfg(windows)]
#[tokio::test]
async fn job_cleans_descendants_after_grace_period() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let script = temp.path().join("tree.cjs");
    std::fs::write(&script, "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({type:'child_pid',pid:child.pid})); process.stdin.resume(); process.stdin.on('end',()=>{}); setInterval(()=>{},1000);")?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let rpc = Rpc::spawn(
        Path::new("node"),
        temp.path(),
        &[script.to_string_lossy().into_owned()],
        &[],
        Arc::new(move |value| {
            let _ = tx.send(value);
        }),
        &[],
    )
    .await?;
    let pid = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await?
        .unwrap()["pid"]
        .as_u64()
        .unwrap();
    rpc.stop().await;
    // OpenProcess fails once the grandchild is gone. An existing process handle
    // may remain signalled while OS cleanup finishes, which is also acceptable.
    unsafe {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_OBJECT_0},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid as u32);
        if !handle.is_null() {
            let status = WaitForSingleObject(handle, 3000);
            CloseHandle(handle);
            assert_eq!(status, WAIT_OBJECT_0);
        }
    }
    Ok(())
}
async fn run_git(dir: &Path, args: &[&str]) -> Result<()> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
#[tokio::test]
async fn git_nested_workspace_staged_and_untracked() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let dir = temp.path();
    run_git(dir, &["init"]).await?;
    std::fs::write(dir.join("file.txt"), "initial\n")?;
    run_git(dir, &["add", "."]).await?;
    run_git(
        dir,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "test",
        ],
    )
    .await?;
    std::fs::write(dir.join("file.txt"), "staged\n")?;
    run_git(dir, &["add", "."]).await?;
    std::fs::write(dir.join("file.txt"), "unstaged\n")?;
    std::fs::create_dir(dir.join("sub"))?;
    std::fs::write(dir.join("sub/中文.txt"), "child")?;
    let changes = workspace::git_changes(&dir.join("sub")).await?;
    assert_eq!(changes["files"].as_array().unwrap().len(), 1);
    assert_eq!(changes["files"][0]["path"], "中文.txt");
    let diff = workspace::git_diff(dir, "file.txt").await?;
    let text = diff["content"].as_str().unwrap();
    assert!(text.contains("未暂存") && text.contains("已暂存"));
    assert_eq!(
        workspace::git_diff(&dir.join("sub"), "中文.txt").await?["content"],
        "child"
    );
    assert!(workspace::git_diff(dir, "../outside").await.is_err());
    Ok(())
}
#[cfg(windows)]
#[test]
fn junction_escape_is_rejected() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("root");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&root)?;
    std::fs::create_dir(&outside)?;
    std::fs::write(outside.join("secret.txt"), "secret")?;
    // Node creates directory junctions without requiring symlink elevation.
    let script = "require('fs').symlinkSync(process.argv[1],process.argv[2],'junction')";
    let status = std::process::Command::new("node")
        .args(["-e", script])
        .arg(&outside)
        .arg(root.join("escape"))
        .status()?;
    assert!(status.success());
    assert!(workspace::within_workspace(&root, "escape/secret.txt").is_err());
    Ok(())
}
