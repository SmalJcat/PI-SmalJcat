use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn clipped(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}
pub fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("记录路径无效")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    let result = fs::rename(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.context("无法保存本地记录")
}

struct SettingsLock(PathBuf);
impl Drop for SettingsLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}
fn lock_settings(path: &Path, stale: Duration) -> Result<SettingsLock> {
    for _ in 0..25 {
        match fs::create_dir(path) {
            Ok(()) => return Ok(SettingsLock(path.to_path_buf())),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Ok(modified) = fs::metadata(path).and_then(|m| m.modified()) {
                    if modified.elapsed().is_ok_and(|age| age >= stale)
                        && fs::metadata(path).and_then(|m| m.modified()).ok() == Some(modified)
                    {
                        let _ = fs::remove_dir(path);
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.into()),
        }
    }
    bail!("Pi 设置正在由其他进程写入，请稍后重试")
}

/// Follow Pi's proper-lockfile directory convention and ten-second stale policy.
pub fn patch_settings(file: &Path, model: &str, patch: &Value, window: u64) -> Result<()> {
    if model.is_empty() || model.len() > 400 {
        bail!("当前模型无效");
    }
    if let Some(value) = patch.get("enabled") {
        if !value.is_boolean() {
            bail!("自动压缩开关无效");
        }
    }
    for field in ["reserveTokens", "keepRecentTokens"] {
        if let Some(value) = patch.get(field) {
            let value = value.as_u64().context("Token 设置必须是非负整数")?;
            if value >= window || value > 9_007_199_254_740_991 {
                bail!("Token 设置必须小于模型上下文窗口");
            }
        }
    }
    if let (Some(reserve), Some(keep)) = (
        patch["reserveTokens"].as_u64(),
        patch["keepRecentTokens"].as_u64(),
    ) {
        if keep >= window.saturating_sub(reserve) {
            bail!("保留的近期内容必须小于压缩触发阈值");
        }
    }
    fs::create_dir_all(file.parent().context("设置路径无效")?)?;
    let lock_path = PathBuf::from(format!("{}.lock", file.display()));
    let _lock = lock_settings(&lock_path, Duration::from_secs(10))?;
    let mut settings = match fs::read_to_string(file) {
        Ok(text) => serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
            .context("设置 JSON 无效，未修改文件")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error.into()),
    };
    if !settings.is_object() {
        bail!("设置必须是 JSON 对象");
    }
    if settings.get("compaction").is_none() {
        settings["compaction"] = json!({});
    }
    if !settings["compaction"].is_object() {
        bail!("compaction 设置不是对象");
    }
    if let Some(enabled) = patch.get("enabled") {
        settings["compaction"]["enabled"] = enabled.clone();
    }
    if patch.get("reserveTokens").is_some() || patch.get("keepRecentTokens").is_some() {
        let compaction = &mut settings["compaction"];
        if compaction.get("modelOverrides").is_none() {
            compaction["modelOverrides"] = json!({});
        }
        if !compaction["modelOverrides"].is_object() {
            bail!("modelOverrides 设置不是对象");
        }
        if compaction["modelOverrides"].get(model).is_none() {
            compaction["modelOverrides"][model] = json!({});
        }
        if !compaction["modelOverrides"][model].is_object() {
            bail!("当前模型设置不是对象");
        }
        for field in ["reserveTokens", "keepRecentTokens"] {
            if let Some(value) = patch.get(field) {
                compaction["modelOverrides"][model][field] = value.clone();
            }
        }
    }
    atomic_json(file, &settings)
}

pub struct History {
    file: PathBuf,
    rows: Mutex<Vec<Value>>,
    error: Mutex<Option<String>>,
}
impl History {
    pub fn new(file: PathBuf) -> Result<Self> {
        let value = crate::workspace::read_json(&file)?;
        let rows = value["attempts"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut row| {
                if row["status"] == "running" {
                    row["status"] = "interrupted".into();
                    row["error"] = "应用退出时压缩尚未结束".into();
                }
                row
            })
            .collect();
        Ok(Self {
            file,
            rows: Mutex::new(rows),
            error: Mutex::new(None),
        })
    }
    pub fn event(&self, session: &str, event: &Value) {
        let kind = event["type"].as_str().unwrap_or_default();
        if !["compaction_start", "compaction_end"].contains(&kind) {
            return;
        }
        let mut rows = self.rows.lock().unwrap();
        if kind == "compaction_start" {
            rows.push(json!({"id":Uuid::new_v4().to_string(),"session":session,"startedAt":now(),"reason":event["reason"],"status":"running"}));
        } else if let Some(row) = rows
            .iter_mut()
            .rev()
            .find(|row| row["session"] == session && row["status"] == "running")
        {
            row["finishedAt"] = now().into();
            row["durationMs"] = now()
                .saturating_sub(row["startedAt"].as_u64().unwrap_or_default())
                .into();
            row["status"] = if event["aborted"] == true {
                "cancelled"
            } else if event["errorMessage"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            {
                "failed"
            } else {
                "completed"
            }
            .into();
            row["error"] = event["errorMessage"].clone();
            for key in [
                "tokensBefore",
                "estimatedTokensAfter",
                "usage",
                "firstKeptEntryId",
            ] {
                row[key] = event["result"][key].clone();
            }
            row["summary"] = clipped(
                event["result"]["summary"].as_str().unwrap_or_default(),
                128 * 1024,
            )
            .into();
        }
        if rows.len() > 120 {
            let count = rows.len() - 120;
            rows.drain(..count);
        }
        if let Err(error) = atomic_json(&self.file, &json!({"attempts":*rows})) {
            *self.error.lock().unwrap() = Some(error.to_string());
        }
    }
    pub fn list(&self, session: &str, entries: &[Value], leaf: Option<&str>) -> Vec<Value> {
        let mut result: Vec<Value> = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|row| row["session"] == session)
            .cloned()
            .collect();
        let by_id: HashMap<_, _> = entries
            .iter()
            .filter_map(|row| row["id"].as_str().map(|id| (id, row)))
            .collect();
        let mut seen = HashSet::new();
        let mut current = leaf;
        while let Some(id) = current {
            if !seen.insert(id) {
                break;
            }
            let Some(entry) = by_id.get(id) else {
                break;
            };
            if entry["type"] == "compaction"
                && !result.iter().any(|r| r["summary"] == entry["summary"])
            {
                result.push(json!({"id":entry["id"],"status":"completed","reason":"history","summary":entry["summary"],"timestamp":entry["timestamp"],"tokensBefore":entry["tokensBefore"],"usage":entry["usage"]}));
            }
            current = entry["parentId"].as_str();
        }
        result.sort_by_key(|row| {
            std::cmp::Reverse(row["startedAt"].as_u64().unwrap_or_else(|| {
                row["timestamp"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.timestamp_millis() as u64)
                    .unwrap_or_default()
            }))
        });
        result
    }
    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_patch_preserves_other_settings_and_refuses_bad_input() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, r#"{"retry":{"enabled":true},"compaction":{"modelOverrides":{"p/other":{"reserveTokens":30}},"keepRecentTokens":100}}"#).unwrap();
        patch_settings(
            &file,
            "p/model",
            &json!({"reserveTokens":200,"keepRecentTokens":100,"enabled":false}),
            1000,
        )
        .unwrap();
        let value = crate::workspace::read_json(&file).unwrap();
        assert_eq!(value["retry"]["enabled"], true);
        assert_eq!(
            value["compaction"]["modelOverrides"]["p/other"]["reserveTokens"],
            30
        );
        assert_eq!(
            value["compaction"]["modelOverrides"]["p/model"]["reserveTokens"],
            200
        );
        let bytes = fs::read(&file).unwrap();
        assert!(patch_settings(&file, "p/model", &json!({"reserveTokens":-1}), 1000).is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);
        fs::write(&file, "not json").unwrap();
        assert!(patch_settings(&file, "p/model", &json!({"enabled":true}), 1000).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "not json");
    }
    #[test]
    fn history_retains_failed_attempts_and_recovers_interruption() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("history.json");
        let history = History::new(file.clone()).unwrap();
        history.event(
            "session",
            &json!({"type":"compaction_start","reason":"threshold"}),
        );
        history.event(
            "session",
            &json!({"type":"compaction_end","errorMessage":"provider error"}),
        );
        history.event(
            "session",
            &json!({"type":"compaction_start","reason":"manual"}),
        );
        let recovered = History::new(file).unwrap();
        let rows = recovered.list("session", &[], None);
        assert!(rows.iter().any(|r| r["status"] == "failed"));
        assert!(rows.iter().any(|r| r["status"] == "interrupted"));
    }
    #[test]
    fn settings_lock_preserves_live_writers_and_recovers_stale_directories() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("settings.json.lock");
        fs::create_dir(&lock).unwrap();
        assert!(lock_settings(&lock, Duration::from_secs(10)).is_err());
        assert!(lock.is_dir());
        let acquired = lock_settings(&lock, Duration::ZERO).unwrap();
        assert!(lock.is_dir());
        drop(acquired);
        assert!(!lock.exists());
    }
}
