//! 本地存储用量与清理（单机使用场景）。
//!
//! 只统计与清理应用自己管理的目录：任务记录、会话、更新缓存、隔离工作树、索引。
//! 清理目标都是"可再生"的：更新缓存会重新下载，索引会从记录重建。

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 递归统计一个目录的字节数与文件数（不跟随符号链接）。
pub fn measure(path: &Path) -> (u64, u64) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return (0, 0);
    };
    if meta.is_file() {
        return (meta.len(), 1);
    }
    if !meta.is_dir() {
        return (0, 0);
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return (0, 0);
    };
    let mut bytes = 0_u64;
    let mut files = 0_u64;
    for entry in entries.flatten() {
        let (child_bytes, child_files) = measure(&entry.path());
        bytes += child_bytes;
        files += child_files;
    }
    (bytes, files)
}

/// 与索引相关的文件（主库 + WAL + 共享内存）。
pub fn index_files(path: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let candidates = [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ];
    for candidate in candidates {
        if candidate.exists() {
            files.push(candidate);
        }
    }
    files
}

/// 可清理的目标；未知目标直接拒绝，不做"猜测式清理"。
/// 注意：索引不在这里——正在使用的连接下删除数据库文件不安全，索引走 index-reset（清空并重建）。
pub const TARGETS: [&str; 1] = ["updates"];

pub fn clean(target: &str, data_dir: &Path, index_path: &Path) -> Result<Value> {
    if !TARGETS.contains(&target) {
        bail!("不支持的清理目标：{target}");
    }
    let _ = index_path;
    let (before_bytes, before_files) = measure(&data_dir.join("updates"));
    let updates = data_dir.join("updates");
    if updates.exists() {
        std::fs::remove_dir_all(&updates).context("无法清理更新缓存")?;
    }
    Ok(json!({
        "target": target,
        "freedBytes": before_bytes,
        "removedFiles": before_files,
        "note": "更新缓存已清空，下次检查更新会重新下载",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn measure_counts_files_recursively_and_tolerates_missing_paths() {
        let dir = temp();
        assert_eq!(measure(&dir.path().join("缺省目录")), (0, 0));
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/one.txt"), b"12345").unwrap();
        std::fs::write(dir.path().join("a/b/two.txt"), b"123").unwrap();
        assert_eq!(measure(dir.path()), (8, 2));
        assert_eq!(measure(&dir.path().join("a/one.txt")), (5, 1));
    }

    #[test]
    fn clean_rejects_unknown_targets() {
        let dir = temp();
        let error = clean("sessions", dir.path(), &dir.path().join("index.sqlite")).unwrap_err();
        assert!(error.to_string().contains("不支持的清理目标"));
    }

    #[test]
    fn clean_updates_removes_cache_and_reports_reclaimed_bytes() {
        let dir = temp();
        let updates = dir.path().join("updates/0.4.1");
        std::fs::create_dir_all(&updates).unwrap();
        std::fs::write(updates.join("Pi Desktop.exe"), vec![7_u8; 64]).unwrap();
        let result = clean("updates", dir.path(), &dir.path().join("index.sqlite")).unwrap();
        assert_eq!(result["freedBytes"], 64);
        assert_eq!(result["removedFiles"], 1);
        assert!(!dir.path().join("updates").exists());
        // 重复清理不报错
        let again = clean("updates", dir.path(), &dir.path().join("index.sqlite")).unwrap();
        assert_eq!(again["freedBytes"], 0);
    }

    #[test]
    fn index_files_lists_main_and_sidecars_only_when_present() {
        let dir = temp();
        let index = dir.path().join("index.sqlite");
        assert!(index_files(&index).is_empty(), "文件不存在时不应上报");
        std::fs::write(&index, vec![1_u8; 32]).unwrap();
        std::fs::write(dir.path().join("index.sqlite-wal"), vec![2_u8; 16]).unwrap();
        std::fs::write(dir.path().join("index.sqlite-shm"), vec![3_u8; 8]).unwrap();
        assert_eq!(index_files(&index).len(), 3);
        let total: u64 = index_files(&index)
            .iter()
            .map(|path| {
                std::fs::metadata(path)
                    .map(|meta| meta.len())
                    .unwrap_or_default()
            })
            .sum();
        assert_eq!(total, 56);
    }

    #[test]
    fn index_is_not_a_file_clean_target() {
        // 索引走 index-reset（清空并重建），不在这里删除文件
        assert_eq!(TARGETS, ["updates"]);
        let dir = temp();
        assert!(clean("index", dir.path(), &dir.path().join("index.sqlite")).is_err());
    }
}
