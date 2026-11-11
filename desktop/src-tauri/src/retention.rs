//! 保留策略：把"过期可清理的东西"算出来，并且**只清理可再生的东西**。
//!
//! 安全边界（刻意的）：
//!   · 只清理**已归档**的任务记录（运行中 / 已完成未归档的一律不动）；
//!   · **绝不**删除会话文件——那是用户的对话原文，索引可以重建，对话不能；
//!   · 更新缓存是可再生的（下次检查更新会重新下载），因此允许自动清理；
//!   · 隔离工作树里有代码，永不自动删除。
//!
//! 记录清理必须走"先预览再执行"：保留期到了也只提示，不静默删用户数据。

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::Path;

/// 更新缓存的自动清理门槛（天）：纯缓存，留着没意义。
pub const UPDATE_CACHE_DAYS: i64 = 7;
/// 保留期的可选值（天）；0 表示永久保留。
pub const RETENTION_CHOICES: [i64; 4] = [0, 90, 180, 365];

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

/// 保留期是否合法（界面只提供固定档位，后端也校验一遍）。
pub fn is_valid_retention(days: i64) -> bool {
    RETENTION_CHOICES.contains(&days)
}

/// 归档时间是否已超过保留期。days = 0 表示永久保留（永不视为过期）。
pub fn expired(archived_at: Option<i64>, days: i64, now: i64) -> bool {
    if days <= 0 {
        return false;
    }
    let Some(archived_at) = archived_at else {
        return false;
    };
    let cutoff = now - days * 86_400_000;
    archived_at < cutoff
}

/// 一条待清理的归档记录。
#[derive(Debug, Clone, PartialEq)]
pub struct RecordCandidate {
    pub id: String,
    pub path: String,
    pub bytes: u64,
    pub archived_at: i64,
}

/// 扫描记录目录，挑出超过保留期的已归档记录。
/// 只看文件内容里的 archivedAt 字段，不猜测文件名；读不动或结构不符的一律跳过。
pub fn record_candidates(root: &Path, days: i64, now: i64) -> Vec<RecordCandidate> {
    if days <= 0 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Ok(text) = std::fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&text) else {
            continue;
        };
        let archived_at = value["archivedAt"].as_i64();
        if !expired(archived_at, days, now) {
            continue;
        }
        let Some(id) = value["id"].as_str() else {
            continue;
        };
        found.push(RecordCandidate {
            id: id.to_owned(),
            path: path.to_string_lossy().to_string(),
            bytes: text.len() as u64,
            archived_at: archived_at.unwrap_or_default(),
        });
    }
    found.sort_by_key(|candidate| candidate.archived_at);
    found
}

/// 更新缓存里超过门槛的文件数（用于自动清理前的判断与展示）。
pub fn update_cache_files(data_dir: &Path, now: i64, days: i64) -> u64 {
    let root = data_dir.join("updates");
    let cutoff = now - days.max(0) * 86_400_000;
    let mut count = 0_u64;
    let mut stack = vec![root];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as i64)
                .unwrap_or_default();
            if modified < cutoff {
                count += 1;
            }
        }
    }
    count
}

/// 生成保留策略概览（界面据此展示，不产生任何副作用）。
pub fn overview(records_root: &Path, data_dir: &Path, days: i64, now: i64) -> Value {
    let candidates = record_candidates(records_root, days, now);
    let bytes: u64 = candidates.iter().map(|candidate| candidate.bytes).sum();
    json!({
        "retentionDays": days,
        "choices": RETENTION_CHOICES,
        "records": candidates.len(),
        "recordBytes": bytes,
        "recordIds": candidates.iter().map(|candidate| candidate.id.clone()).collect::<Vec<_>>(),
        "updateCacheFiles": update_cache_files(data_dir, now, UPDATE_CACHE_DAYS),
        "updateCacheDays": UPDATE_CACHE_DAYS,
    })
}

/// 自动清理过期的更新缓存（纯缓存，可静默）。返回清理的文件数，便于日志核对。
///
/// 只删**超过门槛的单个文件**，不是整个目录：刚下载的包不该因为旁边有旧文件而被一起删掉。
/// 顺带剪掉清空后的空目录。
pub fn clean_update_cache(data_dir: &Path) -> u64 {
    let root = data_dir.join("updates");
    if !root.exists() {
        return 0;
    }
    let cutoff = now_ms() - UPDATE_CACHE_DAYS * 86_400_000;
    let mut removed = 0_u64;
    let mut directories: Vec<std::path::PathBuf> = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                directories.push(path.clone());
                stack.push(path);
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as i64)
                .unwrap_or_default();
            if modified < cutoff && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    // 目录由深到浅剪空（浅的先删会导致深的删不掉）
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        let empty = std::fs::read_dir(&directory)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if empty {
            let _ = std::fs::remove_dir(&directory);
        }
    }
    removed
}

/// 执行记录清理：删除文件并返回实际删掉的条目（由调用方同步内存与索引）。
pub fn remove_records(candidates: &[RecordCandidate]) -> Result<Value> {
    let mut removed = 0_u64;
    let mut freed = 0_u64;
    let mut ids = Vec::new();
    for candidate in candidates {
        let path = Path::new(&candidate.path);
        match std::fs::remove_file(path) {
            Ok(()) => {
                removed += 1;
                freed += candidate.bytes;
                ids.push(candidate.id.clone());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("无法删除记录 {}", candidate.path));
            }
        }
    }
    Ok(json!({ "removed": removed, "freedBytes": freed, "ids": ids }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;

    fn write_record(root: &Path, id: &str, archived_at: Option<i64>, extra: &str) {
        let archived = match archived_at {
            Some(value) => format!(",\"archivedAt\":{value}"),
            None => String::new(),
        };
        let body =
            format!("{{\"id\":\"{id}\",\"status\":\"completed\"{archived},\"note\":\"{extra}\"}}");
        std::fs::write(root.join(format!("{id}.json")), body).unwrap();
    }

    #[test]
    fn retention_values_are_validated() {
        assert!(is_valid_retention(0));
        assert!(is_valid_retention(90));
        assert!(!is_valid_retention(7));
        assert!(!is_valid_retention(-1));
    }

    #[test]
    fn expiry_only_affects_archived_and_past_cutoff() {
        let now = 1_000 * DAY;
        // 永久保留：任何时间都不过期
        assert!(!expired(Some(now - 400 * DAY), 0, now));
        // 未归档：不过期
        assert!(!expired(None, 90, now));
        // 归档时间在保留期内：不过期
        assert!(!expired(Some(now - 89 * DAY), 90, now));
        // 超过保留期：过期
        assert!(expired(Some(now - 91 * DAY), 90, now));
        // 边界：正好等于截止点不算过期（用 < 而不是 <=）
        assert!(!expired(Some(now - 90 * DAY), 90, now));
    }

    #[test]
    fn candidates_skip_other_files_and_bad_json() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let now = 1_000 * DAY;
        write_record(root, "old", Some(now - 200 * DAY), "超过 90 天");
        write_record(root, "recent", Some(now - 10 * DAY), "还在期内");
        write_record(root, "active", None, "未归档");
        // 注意：字节串字面量只能是 ASCII，含中文要走 as_bytes()
        std::fs::write(root.join("broken.json"), "{ 这不是 json".as_bytes()).unwrap();
        std::fs::write(root.join("ignore.txt"), b"not a record").unwrap();

        let candidates = record_candidates(root, 90, now);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, "old");
        assert!(candidates[0].bytes > 0);

        // 永久保留时不产生任何候选
        assert!(record_candidates(root, 0, now).is_empty());
    }

    #[test]
    fn removing_candidates_deletes_files_and_reports_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let now = 1_000 * DAY;
        write_record(root, "old", Some(now - 400 * DAY), "待清理");
        let candidates = record_candidates(root, 90, now);
        assert_eq!(candidates.len(), 1);

        let result = remove_records(&candidates).unwrap();
        assert_eq!(result["removed"], 1);
        assert!(result["freedBytes"].as_u64().unwrap() > 0);
        assert!(!root.join("old.json").exists());

        // 重复执行不报错、也不再计数
        // 注意：candidate.path 指向已删除文件，remove_file 会返回 NotFound 并被忽略
        let again = remove_records(&candidates).unwrap();
        assert_eq!(again["removed"], 0);
    }

    #[test]
    fn update_cache_cleanup_only_removes_expired_files() {
        let dir = tempfile::tempdir().unwrap();
        let updates = dir.path().join("updates/0.4.1");
        std::fs::create_dir_all(&updates).unwrap();
        let fresh = updates.join("fresh.exe");
        std::fs::write(&fresh, vec![0_u8; 16]).unwrap();
        let stale = updates.join("stale.exe");
        std::fs::write(&stale, vec![0_u8; 16]).unwrap();
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86_400);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old_time)
            .unwrap();

        assert_eq!(clean_update_cache(dir.path()), 1, "只应删掉过期那一个");
        assert!(!stale.exists());
        assert!(fresh.exists(), "新下载的包不能被一起删掉");
        // 再跑一次没有可删的
        assert_eq!(clean_update_cache(dir.path()), 0);
        assert!(fresh.exists());
    }

    #[test]
    fn update_cache_expiry_counts_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let updates = dir.path().join("updates/1.0.0");
        std::fs::create_dir_all(&updates).unwrap();
        std::fs::write(updates.join("new.bin"), vec![0_u8; 8]).unwrap();
        let old = updates.join("old.bin");
        std::fs::write(&old, vec![0_u8; 8]).unwrap();
        let ten_days_ago =
            std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 86_400);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(ten_days_ago)
            .unwrap();

        let now = now_ms();
        assert_eq!(update_cache_files(dir.path(), now, UPDATE_CACHE_DAYS), 1);
        assert_eq!(update_cache_files(dir.path(), now, 30), 0);

        let overview = overview(dir.path(), dir.path(), 90, now);
        assert_eq!(overview["retentionDays"], 90);
        assert_eq!(overview["updateCacheFiles"], 1);
        assert_eq!(overview["records"], 0);
    }
}
