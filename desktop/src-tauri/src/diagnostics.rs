//! 崩溃与异常退出诊断（纯本地，不上报任何地方）。
//!
//! 两件事：
//!   1. 把 panic 写成本地报告文件（含版本、线程、位置、消息、回溯），并只保留最近若干份；
//!   2. 通过"正常退出标记"判断上次是否是异常退出——下次启动时能明确告诉用户。
//!
//! 刻意不做的事：不联网上报、不收集隐私数据。诊断信息就放在用户自己的数据目录里。

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 崩溃报告的存放子目录。
pub const CRASH_DIR: &str = "crashes";
/// panic 报告文件前缀（用于判定"异常退出"）。
pub const CRASH_PREFIX: &str = "crash-";
/// 前端错误报告前缀：它不代表进程崩溃，因此**不参与**"上次是否正常退出"的判定。
pub const RENDERER_PREFIX: &str = "renderer-";
/// 正常退出标记文件。
pub const EXIT_MARKER: &str = "last-exit.json";
/// 最多保留的崩溃报告份数（超出按时间删最旧的）。
pub const MAX_CRASH_FILES: usize = 20;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

pub fn crash_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(CRASH_DIR)
}

fn marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(EXIT_MARKER)
}

/// 把 panic 信息渲染成可读文本。纯函数，便于测试格式而不触发真 panic。
pub fn report_text(
    version: &str,
    thread: &str,
    message: &str,
    location: &str,
    backtrace: &str,
    at: u64,
) -> String {
    let mut text = String::new();
    text.push_str("Pi Desktop 崩溃报告\n");
    text.push_str("===================\n");
    text.push_str(&format!("时间戳（毫秒）: {at}\n"));
    text.push_str(&format!("应用版本: {version}\n"));
    text.push_str(&format!("线程: {thread}\n"));
    text.push_str(&format!("位置: {location}\n"));
    text.push_str(&format!("消息: {message}\n"));
    if !backtrace.trim().is_empty() {
        text.push_str("\n回溯:\n");
        text.push_str(backtrace.trim_end());
        text.push('\n');
    }
    text
}

/// 写入一份报告（按前缀区分种类），并把该种类裁剪到上限。返回写入的路径。
pub fn write_report(data_dir: &Path, prefix: &str, text: &str, at: u64) -> Result<PathBuf> {
    let dir = crash_dir(data_dir);
    std::fs::create_dir_all(&dir).context("无法创建崩溃报告目录")?;
    let path = dir.join(format!("{prefix}{at}.txt"));
    std::fs::write(&path, text).context("无法写入崩溃报告")?;
    prune(&dir, prefix, MAX_CRASH_FILES);
    Ok(path)
}

/// panic 报告。
pub fn write_crash(data_dir: &Path, text: &str, at: u64) -> Result<PathBuf> {
    write_report(data_dir, CRASH_PREFIX, text, at)
}

/// 前端错误报告（不算崩溃）。
pub fn write_renderer(data_dir: &Path, text: &str, at: u64) -> Result<PathBuf> {
    write_report(data_dir, RENDERER_PREFIX, text, at)
}

/// 只保留**同一前缀**的最近 limit 份（避免前端错误把 panic 报告挤掉）。
pub fn prune(dir: &Path, prefix: &str, limit: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .map(|name| name.to_string_lossy().starts_with(prefix))
                    .unwrap_or(false)
        })
        .collect();
    if files.len() <= limit {
        return;
    }
    files.sort();
    for path in files.iter().take(files.len() - limit) {
        let _ = std::fs::remove_file(path);
    }
}

/// 记录一次正常退出。
pub fn mark_clean_exit(data_dir: &Path, version: &str) -> Result<()> {
    std::fs::create_dir_all(data_dir).context("无法创建数据目录")?;
    let payload = json!({ "clean": true, "at": now_ms(), "version": version });
    std::fs::write(marker_path(data_dir), serde_json::to_vec_pretty(&payload)?)
        .context("无法写入退出标记")?;
    Ok(())
}

fn marker_at(data_dir: &Path) -> Option<u64> {
    let text = std::fs::read_to_string(marker_path(data_dir)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["clean"].as_bool().filter(|clean| *clean)?;
    value["at"].as_u64()
}

/// 诊断概览：上次是否正常退出、有哪些崩溃报告。
/// 判定规则：存在比"正常退出标记"更新的崩溃报告即视为异常退出；没有标记也没有报告视为干净。
pub fn status(data_dir: &Path) -> Value {
    let marker = marker_at(data_dir);
    let dir = crash_dir(data_dir);
    let mut crashes: Vec<Value> = Vec::new();
    let mut renderer: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let is_crash = name.starts_with(CRASH_PREFIX);
            let is_renderer = name.starts_with(RENDERER_PREFIX);
            if !is_crash && !is_renderer {
                continue;
            }
            let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or_default();
            let at = name
                .trim_start_matches(if is_crash {
                    CRASH_PREFIX
                } else {
                    RENDERER_PREFIX
                })
                .trim_end_matches(".txt")
                .parse::<u64>()
                .unwrap_or_default();
            let preview = std::fs::read_to_string(&path)
                .map(|text| {
                    text.lines()
                        .find(|line| line.starts_with("消息:"))
                        .unwrap_or("（无可读消息行）")
                        .to_string()
                })
                .unwrap_or_default();
            let item = json!({ "name": name, "at": at, "bytes": bytes, "preview": preview });
            if is_crash {
                crashes.push(item);
            } else {
                renderer.push(item);
            }
        }
    }
    crashes.sort_by(|left, right| right["at"].as_u64().cmp(&left["at"].as_u64()));
    renderer.sort_by(|left, right| right["at"].as_u64().cmp(&left["at"].as_u64()));
    // 只有 panic 报告参与"上次是否正常退出"的判定
    let newest = crashes.first().and_then(|item| item["at"].as_u64());
    let dirty = match (marker, newest) {
        (Some(marker_at), Some(newest_at)) => newest_at > marker_at,
        (None, Some(_)) => true,
        _ => false,
    };
    json!({
        "cleanExit": !dirty,
        "lastCleanExitAtMs": marker,
        "crashCount": crashes.len(),
        "crashes": crashes,
        "rendererCount": renderer.len(),
        "rendererErrors": renderer,
        "dir": dir.to_string_lossy(),
    })
}

/// 清空崩溃报告（用户主动操作；这是诊断副本，删掉不影响其它数据）。
pub fn clear(data_dir: &Path) -> Result<u64> {
    let dir = crash_dir(data_dir);
    if !dir.exists() {
        return Ok(0);
    }
    let mut removed = 0_u64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_text_contains_the_essentials() {
        let text = report_text(
            "0.4.1",
            "main",
            "索引越界",
            "src/a.rs:12:5",
            "frame 1\nframe 2",
            42,
        );
        assert!(text.starts_with("Pi Desktop 崩溃报告"));
        assert!(text.contains("应用版本: 0.4.1"));
        assert!(text.contains("线程: main"));
        assert!(text.contains("位置: src/a.rs:12:5"));
        assert!(text.contains("消息: 索引越界"));
        assert!(text.contains("frame 2"));
        assert!(text.contains("时间戳（毫秒）: 42"));

        // 没有回溯时不出现"回溯"段落
        let bare = report_text("0.4.1", "main", "空回溯", "src/b.rs:1:1", "   ", 1);
        assert!(!bare.contains("回溯:"));
    }

    #[test]
    fn crash_files_are_pruned_to_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..25 {
            write_crash(dir.path(), "x", 1000 + index).unwrap();
        }
        let files = std::fs::read_dir(crash_dir(dir.path())).unwrap().count();
        assert_eq!(
            files, MAX_CRASH_FILES,
            "应当只保留最近 {MAX_CRASH_FILES} 份"
        );
        // 最早的那几份应被删除
        assert!(!crash_dir(dir.path()).join("crash-1000.txt").exists());
        assert!(crash_dir(dir.path()).join("crash-1024.txt").exists());
    }

    #[test]
    fn status_reports_dirty_only_when_a_crash_is_newer_than_the_marker() {
        let dir = tempfile::tempdir().unwrap();
        // 全新环境：没有标记也没有报告 → 视为干净
        let fresh = status(dir.path());
        assert_eq!(fresh["cleanExit"], true);
        assert_eq!(fresh["crashCount"], 0);

        // 有报告但没有标记 → 异常退出
        let report = report_text("0.4.1", "t", "崩了", "loc", "", 5000);
        write_crash(dir.path(), &report, 5000).unwrap();
        let crashed = status(dir.path());
        assert_eq!(crashed["cleanExit"], false);
        assert_eq!(crashed["crashCount"], 1);
        assert!(crashed["crashes"][0]["preview"]
            .as_str()
            .unwrap()
            .contains("崩了"));
        assert!(crashed["crashes"][0]["at"].as_u64().unwrap() >= 5000);

        // 报告比标记旧 → 干净退出（说明那次崩溃之后又正常启动过）
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            marker_path(dir.path()),
            serde_json::to_vec(&json!({ "clean": true, "at": 9000, "version": "0.4.1" })).unwrap(),
        )
        .unwrap();
        assert_eq!(status(dir.path())["cleanExit"], true);

        // 标记之后又崩了 → 异常退出
        write_crash(dir.path(), "y", 9500).unwrap();
        assert_eq!(status(dir.path())["cleanExit"], false);
    }

    #[test]
    fn renderer_reports_do_not_look_like_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        mark_clean_exit(dir.path(), "0.4.1").unwrap();
        // 前端报错写在标记之后：不能被判定为"异常退出"
        let at = now_ms() + 5000;
        write_renderer(dir.path(), "报告\n消息: 前端炸了", at).unwrap();
        // 注意：局部变量不能叫 status，否则会遮蔽同名函数
        let with_renderer = status(dir.path());
        assert_eq!(with_renderer["cleanExit"], true, "前端错误不算异常退出");
        assert_eq!(with_renderer["rendererCount"], 1);
        assert_eq!(with_renderer["crashCount"], 0);

        // panic 报告写在标记之后才算异常退出
        write_crash(dir.path(), "报告\n消息: 真崩了", at + 1000).unwrap();
        let after = status(dir.path());
        assert_eq!(after["cleanExit"], false);
        assert_eq!(after["crashCount"], 1);
        assert_eq!(after["rendererCount"], 1, "两类报告分开统计");
    }

    #[test]
    fn clear_removes_reports_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        write_crash(dir.path(), "a", 1).unwrap();
        write_crash(dir.path(), "b", 2).unwrap();
        assert_eq!(clear(dir.path()).unwrap(), 2);
        assert_eq!(status(dir.path())["crashCount"], 0);
        assert_eq!(clear(dir.path()).unwrap(), 0);
    }

    #[test]
    fn clean_marker_is_written_and_readable() {
        let dir = tempfile::tempdir().unwrap();
        mark_clean_exit(dir.path(), "0.4.1").unwrap();
        let status = status(dir.path());
        assert_eq!(status["cleanExit"], true);
        assert!(status["lastCleanExitAtMs"].as_u64().unwrap() > 0);
    }
}
