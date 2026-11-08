//! 会话全文检索：把历史会话正文索引进 FTS5，支持中文子串匹配。
//!
//! 设计要点：
//!   · 会话是 JSONL（首行文件头，其后每行一条消息），坏行跳过而不是整文件失败；
//!   · 用 FTS5 的 trigram 分词器：对中文这类无空格语言可做子串匹配，且带相关性排序；
//!   · trigram 要求至少 3 个字符，更短的查询回退到 LIKE，不静默返回空；
//!   · 增量：按（路径, mtime, size）判断是否需要重建，文件删掉后同步清理索引行。

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// 单个会话文件最多读取的字节数（超出部分不索引，避免超大文件拖慢启动）。
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 单文件正文入库上限。
pub const BODY_LIMIT: usize = 256 * 1024;
/// trigram 分词器的最短匹配长度。
pub const MIN_TERM_CHARS: usize = 3;
/// 会话文件的最大遍历深度。
const MAX_DEPTH: usize = 6;
/// 索引结构版本：变更时丢弃缓存重建（它是纯缓存，重建成本只是重新读一遍会话）。
const SCHEMA_VERSION: i64 = 2;

const SCHEMA: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS session_files (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  cwd TEXT NOT NULL DEFAULT ''
);
";

/// 工作区路径归一化：正斜杠 + 去尾斜杠，Windows 下再统一小写。
/// 索引里存的是归一化值，过滤时直接等值比较。
fn normalize_cwd(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/').to_owned();
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed
    }
}

/// 只读会话文件第一行拿工作区路径（文件头记录了 cwd），不整文件读取。
fn header_cwd(path: &Path) -> String {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut line = String::new();
    if std::io::BufReader::new(file).read_line(&mut line).is_err() {
        return String::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return String::new();
    };
    normalize_cwd(value["cwd"].as_str().unwrap_or_default())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

fn modified_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

/// 会话文件判定：Pi 写的是 .jsonl（一行一条记录），这里同时容忍 .json。
/// 只认 .json 会漏掉全部真实会话——这个坑是端到端验收抓出来的。
pub fn is_session_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl") || ext.eq_ignore_ascii_case("json"))
}

/// 递归收集会话文件，超过深度上限即停止。
fn collect(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect(&path, depth + 1, out);
        } else if kind.is_file() && is_session_file(&path) {
            out.push(path);
        }
    }
}

/// 从会话 JSONL 里抽出标题（首条用户消息）与正文（用户 + 助手）。
pub fn extract_text(path: &Path) -> Result<(String, String)> {
    use std::io::Read;
    let file = std::fs::File::open(path).context("无法读取会话文件")?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        bytes.truncate(MAX_FILE_BYTES as usize);
    }
    let mut title = String::new();
    let mut body = String::new();
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        // 坏行跳过：一个会话里有一行损坏，不该让整个文件失去检索价值
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if value["type"] == "session" {
            continue;
        }
        let role = value["message"]["role"].as_str().unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = crate::agent_history::message_text(&value["message"]["content"]);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if title.is_empty() && role == "user" {
            title = text.chars().take(80).collect();
        }
        body.push_str(text);
        body.push('\n');
        if body.len() >= BODY_LIMIT {
            break;
        }
    }
    if title.is_empty() {
        title = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
    }
    Ok((title, body))
}

/// 会话索引。
pub struct SessionIndex {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl SessionIndex {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("无法创建索引目录")?;
        }
        let connection = Connection::open(path).context("无法打开会话索引")?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .context("无法设置会话索引忙等待")?;
        // 结构版本不符就丢弃重来：索引是纯缓存，重建比迁移更可靠
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or_default();
        if version < SCHEMA_VERSION {
            connection
                .execute_batch(
                    "DROP TABLE IF EXISTS sessions_fts; DROP TABLE IF EXISTS session_files;",
                )
                .context("无法重置会话索引")?;
            connection
                .execute(&format!("PRAGMA user_version = {SCHEMA_VERSION}"), [])
                .context("无法写入会话索引版本")?;
        }
        connection
            .execute_batch(SCHEMA)
            .context("无法初始化会话索引结构（需要 FTS5 支持）")?;
        Ok(Self {
            path: path.to_path_buf(),
            connection: Mutex::new(connection),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn stats(&self) -> Value {
        let connection = self.connection.lock().unwrap();
        let files: i64 = connection
            .query_row("SELECT COUNT(*) FROM session_files", [], |row| row.get(0))
            .unwrap_or_default();
        let chars: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(chars), 0) FROM session_files",
                [],
                |row| row.get(0),
            )
            .unwrap_or_default();
        let last: Option<i64> = connection
            .query_row("SELECT MAX(indexed_at) FROM session_files", [], |row| {
                row.get(0)
            })
            .ok()
            .flatten();
        let bytes = std::fs::metadata(&self.path)
            .map(|meta| meta.len())
            .unwrap_or_default();
        json!({
            "path": self.path.to_string_lossy(),
            "files": files,
            "chars": chars,
            "bytes": bytes,
            "lastSyncAtMs": last.filter(|value| *value > 0),
        })
    }

    /// 同步一个会话目录：只重建变动过的文件，并清理已消失的文件。
    pub fn sync(&self, root: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<Value> {
        let started = now_ms();
        let mut files = Vec::new();
        collect(root, 0, &mut files);
        files.sort();
        let total = files.len() as u64;

        let mut connection = self.connection.lock().unwrap();
        let known: HashSet<String> = {
            let mut statement = connection.prepare("SELECT path FROM session_files")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.filter_map(|row| row.ok()).collect()
        };

        let mut indexed = 0_u64;
        let mut skipped = 0_u64;
        let mut failed = 0_u64;
        let mut seen: HashSet<String> = HashSet::new();
        let transaction = connection.transaction().context("无法开始会话索引事务")?;
        for (index, path) in files.iter().enumerate() {
            let key = path.to_string_lossy().to_string();
            seen.insert(key.clone());
            let size = std::fs::metadata(path)
                .map(|meta| meta.len())
                .unwrap_or_default() as i64;
            let mtime = modified_ms(path);
            let unchanged = transaction
                .query_row(
                    "SELECT mtime, size FROM session_files WHERE path = ?1",
                    params![key],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .ok()
                .is_some_and(|(old_mtime, old_size)| old_mtime == mtime && old_size == size);
            if unchanged {
                skipped += 1;
            } else {
                let cwd = header_cwd(path);
                match extract_text(path) {
                    Ok((title, body)) => {
                        transaction
                            .execute("DELETE FROM sessions_fts WHERE path = ?1", params![key])?;
                        transaction.execute(
                            "INSERT INTO sessions_fts (path, title, body) VALUES (?1, ?2, ?3)",
                            params![key, title, body],
                        )?;
                        transaction.execute(
                            "INSERT INTO session_files (path, mtime, size, indexed_at, chars, cwd)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                             ON CONFLICT(path) DO UPDATE SET
                               mtime = excluded.mtime, size = excluded.size,
                               indexed_at = excluded.indexed_at, chars = excluded.chars,
                               cwd = excluded.cwd",
                            params![key, mtime, size, now_ms(), body.chars().count() as i64, cwd],
                        )?;
                        indexed += 1;
                    }
                    Err(_) => failed += 1,
                }
            }
            if (index as u64).is_multiple_of(25) || index as u64 + 1 == total {
                progress(index as u64 + 1, total);
            }
        }
        // 文件被删掉后，索引行也要清掉，否则会搜到已经不存在的会话
        let mut removed = 0_u64;
        for path in known.difference(&seen) {
            transaction.execute("DELETE FROM sessions_fts WHERE path = ?1", params![path])?;
            transaction.execute("DELETE FROM session_files WHERE path = ?1", params![path])?;
            removed += 1;
        }
        transaction.commit().context("无法提交会话索引事务")?;
        Ok(json!({
            "root": root.to_string_lossy(),
            "files": total,
            "indexed": indexed,
            "skipped": skipped,
            "failed": failed,
            "removed": removed,
            "elapsedMs": (now_ms() - started).max(0),
        }))
    }

    /// 距上次同步超过 max_age_ms 就同步一次（只做 stat 扫描 + 变动文件重建，很便宜）。
    /// 返回 None 表示足够新、已跳过；Some 则是本次同步的摘要。
    pub fn sync_if_stale(
        &self,
        root: &Path,
        max_age_ms: i64,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<Option<Value>> {
        let last = self.stats()["lastSyncAtMs"].as_i64().unwrap_or_default();
        if last > 0 && now_ms().saturating_sub(last) < max_age_ms {
            return Ok(None);
        }
        Ok(Some(self.sync(root, progress)?))
    }

    /// 简单检索入口（向后兼容）：等价于只给查询词与条数。
    pub fn search(&self, query: &str, limit: usize) -> Result<Value> {
        self.search_filtered(&json!({ "query": query, "limit": limit }))
    }

    /// 带过滤条件的检索。
    ///
    /// · 多关键词：空格分隔，**全部命中才算**（AND）；
    /// · `sinceDays`：只搜最近 N 天的会话（0 表示不限）；
    /// · `workspace`：只搜该工作区的会话（Windows 路径大小写不敏感）；
    /// · 所有关键词都 ≥3 个字符时走 FTS5（trigram + 相关性排序），含更短的词时整条查询回退 LIKE。
    pub fn search_filtered(&self, options: &Value) -> Result<Value> {
        let query = options["query"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let limit = options["limit"].as_u64().unwrap_or(8).clamp(1, 50) as i64;
        let since_days = options["sinceDays"].as_u64().unwrap_or(0) as i64;
        let workspace = normalize_cwd(options["workspace"].as_str().unwrap_or_default());
        if query.is_empty() {
            return Ok(json!({ "items": [], "mode": "empty", "total": 0, "terms": [] }));
        }
        let terms: Vec<String> = query.split_whitespace().map(str::to_owned).collect();
        let use_fts = terms
            .iter()
            .all(|term| term.chars().count() >= MIN_TERM_CHARS);
        let since_at = if since_days > 0 {
            now_ms() - since_days * 86_400_000
        } else {
            0
        };
        let connection = self.connection.lock().unwrap();
        let mut items = Vec::new();
        if use_fts {
            let phrases = terms
                .iter()
                .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" ");
            let mut statement = connection.prepare(
                "SELECT sessions_fts.path, sessions_fts.title, snippet(sessions_fts, 2, '', '', '…', 16)
                 FROM sessions_fts JOIN session_files ON session_files.path = sessions_fts.path
                 WHERE sessions_fts MATCH ?1
                   AND (?2 = 0 OR session_files.mtime >= ?2)
                   AND (?3 = '' OR session_files.cwd = ?3)
                 ORDER BY bm25(sessions_fts, 0.0, 4.0, 1.0)
                 LIMIT ?4",
            )?;
            let rows =
                statement.query_map(params![phrases, since_at, workspace, limit], |row| {
                    Ok(json!({
                        "path": row.get::<_, String>(0)?,
                        "title": row.get::<_, String>(1)?,
                        "snippet": row.get::<_, String>(2)?,
                    }))
                })?;
            for row in rows.flatten() {
                items.push(row);
            }
            return Ok(
                json!({ "items": items, "mode": "fts", "total": items.len(), "terms": terms }),
            );
        }
        // 含短词（trigram 无法处理）：整条查询回退 LIKE，逐词 AND
        let mut clause: Vec<String> = Vec::new();
        let mut bound: Vec<String> = Vec::new();
        for term in &terms {
            clause.push("(sessions_fts.body LIKE ? OR sessions_fts.title LIKE ?)".to_owned());
            bound.push(format!("%{}%", term));
            bound.push(format!("%{}%", term));
        }
        if since_at > 0 {
            clause.push(format!("session_files.mtime >= {since_at}"));
        }
        if !workspace.is_empty() {
            clause.push("session_files.cwd = ?".to_owned());
            bound.push(workspace.clone());
        }
        let sql = format!(
            "SELECT sessions_fts.path, sessions_fts.title, substr(sessions_fts.body, 1, 160)
             FROM sessions_fts JOIN session_files ON session_files.path = sessions_fts.path
             WHERE {} LIMIT ?",
            clause.join(" AND ")
        );
        let mut statement = connection.prepare(&sql)?;
        let mut bound_refs: Vec<&dyn rusqlite::ToSql> = bound
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql)
            .collect();
        bound_refs.push(&limit);
        let rows = statement.query_map(bound_refs.as_slice(), |row| {
            Ok(json!({
                "path": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "snippet": row.get::<_, String>(2)?,
            }))
        })?;
        for row in rows.flatten() {
            items.push(row);
        }
        Ok(json!({ "items": items, "mode": "like", "total": items.len(), "terms": terms }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_file(path: &Path, lines: &[serde_json::Value]) {
        let mut text = String::from("{\"type\":\"session\"}\n");
        for line in lines {
            text.push_str(&line.to_string());
            text.push('\n');
        }
        std::fs::write(path, text).unwrap();
    }

    fn message(id: &str, role: &str, content: &str) -> serde_json::Value {
        json!({
            "type": "message",
            "id": id,
            "parentId": Value::Null,
            "message": { "role": role, "content": content }
        })
    }

    fn fixture() -> (tempfile::TempDir, SessionIndex, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        std::fs::create_dir_all(root.join("proj")).unwrap();
        let index = SessionIndex::open(&dir.path().join("sessions.sqlite")).unwrap();
        (dir, index, root)
    }

    #[test]
    fn session_file_detection_covers_both_extensions() {
        // 真实会话是 .jsonl；只认 .json 会让索引永远为空（曾经的线上问题）
        assert!(is_session_file(Path::new("a.jsonl")));
        assert!(is_session_file(Path::new("a.JSONL")));
        assert!(is_session_file(Path::new("a.json")));
        assert!(!is_session_file(Path::new("a.txt")));
        assert!(!is_session_file(Path::new("a")));
    }

    #[test]
    fn sync_indexes_jsonl_and_extracts_titles() {
        let (_dir, index, root) = fixture();
        session_file(
            &root.join("a.jsonl"),
            &[
                message("1", "user", "帮我检查登录流程是否有并发问题"),
                message(
                    "2",
                    "assistant",
                    "登录流程里有一个竞态：token 刷新与登出同时发生。",
                ),
            ],
        );
        session_file(
            &root.join("proj/b.json"),
            &[message("1", "user", "另一个会话")],
        );
        let mut calls = Vec::new();
        let summary = index
            .sync(&root, &mut |done, total| calls.push((done, total)))
            .unwrap();
        assert_eq!(summary["files"], 2);
        assert_eq!(summary["indexed"], 2);
        assert!(!calls.is_empty(), "应当汇报进度");

        let found = index.search("并发问题", 10).unwrap();
        assert_eq!(found["mode"], "fts");
        assert_eq!(found["total"], 1);
        assert_eq!(found["items"][0]["title"], "帮我检查登录流程是否有并发问题");
        // 片段是"命中处的上下文"，因此应当包含查询本身
        assert!(
            found["items"][0]["snippet"]
                .as_str()
                .unwrap()
                .contains("并发问题"),
            "片段应当包含命中的关键词：{}",
            found["items"][0]["snippet"]
        );

        // 助手消息也参与检索，片段来自助手那段
        let assistant = index.search("token 刷新", 10).unwrap();
        assert_eq!(assistant["total"], 1);
        assert!(assistant["items"][0]["snippet"]
            .as_str()
            .unwrap()
            .contains("刷新"));
        // 不存在的词返回空而不是报错
        assert_eq!(index.search("完全不存在的内容", 10).unwrap()["total"], 0);
    }

    #[test]
    fn short_queries_fall_back_to_like() {
        let (_dir, index, root) = fixture();
        session_file(
            &root.join("a.json"),
            &[message("1", "user", "并发问题排查")],
        );
        index.sync(&root, &mut |_, _| {}).unwrap();
        let short = index.search("并发", 10).unwrap();
        assert_eq!(short["mode"], "like", "两个字符走 LIKE 回退");
        assert_eq!(short["total"], 1);
        // 标题也参与回退匹配
        assert_eq!(index.search("并发", 10).unwrap()["total"], 1);
        assert_eq!(index.search("   ", 10).unwrap()["mode"], "empty");
    }

    #[test]
    fn unchanged_files_are_skipped_and_deleted_files_are_removed() {
        let (_dir, index, root) = fixture();
        let file = root.join("a.json");
        session_file(&file, &[message("1", "user", "第一次写入的内容")]);
        let first = index.sync(&root, &mut |_, _| {}).unwrap();
        assert_eq!(first["indexed"], 1);
        let second = index.sync(&root, &mut |_, _| {}).unwrap();
        assert_eq!(second["indexed"], 0, "未变动不应重复索引");
        assert_eq!(second["skipped"], 1);

        std::fs::remove_file(&file).unwrap();
        let third = index.sync(&root, &mut |_, _| {}).unwrap();
        assert_eq!(third["removed"], 1, "文件删除后索引行应当清理");
        assert_eq!(index.search("第一次写入", 10).unwrap()["total"], 0);
    }

    #[test]
    fn changed_files_are_reindexed_and_damaged_lines_are_skipped() {
        let (_dir, index, root) = fixture();
        let file = root.join("a.json");
        let mut text = String::from("{\"type\":\"session\"}\n");
        text.push_str("这一行不是 JSON\n");
        text.push_str(&message("1", "user", "可检索的中文内容").to_string());
        text.push('\n');
        std::fs::write(&file, text).unwrap();
        let summary = index.sync(&root, &mut |_, _| {}).unwrap();
        assert_eq!(summary["indexed"], 1, "坏行不应让整个文件失败");
        assert_eq!(index.search("可检索的中文内容", 10).unwrap()["total"], 1);

        // 同大小但 mtime 变化时要重新索引（内容改动）
        session_file(&file, &[message("1", "user", "改过之后的新内容")]);
        let again = index.sync(&root, &mut |_, _| {}).unwrap();
        assert_eq!(again["indexed"], 1);
        assert_eq!(index.search("改过之后", 10).unwrap()["total"], 1);
        assert_eq!(index.search("可检索的中文内容", 10).unwrap()["total"], 0);
    }

    #[test]
    fn sync_if_stale_skips_fresh_and_refreshes_appended_content() {
        let (_dir, index, root) = fixture();
        let file = root.join("a.jsonl");
        session_file(&file, &[message("1", "user", "第一轮的内容")]);
        // 首次：没有同步时间，必须同步
        let first = index.sync_if_stale(&root, 3000, &mut |_, _| {}).unwrap();
        assert!(first.is_some(), "没有同步时间时应当同步");
        assert_eq!(index.search("第一轮的内容", 10).unwrap()["total"], 1);

        // 紧接着再问：足够新，跳过
        let skip = index.sync_if_stale(&root, 3000, &mut |_, _| {}).unwrap();
        assert!(skip.is_none(), "刚刚同步过应当跳过");

        // 会话追加了内容：即使不强制刷新，下次同步也会把新内容带进来
        session_file(
            &file,
            &[
                message("1", "user", "第一轮的内容"),
                message("2", "assistant", "第二轮补充的结论"),
            ],
        );
        let refreshed = index
            .sync_if_stale(&root, 0, &mut |_, _| {})
            .unwrap()
            .expect("max_age 为 0 时必须同步");
        assert_eq!(refreshed["indexed"], 1);
        assert_eq!(index.search("第二轮补充的结论", 10).unwrap()["total"], 1);
    }

    #[test]
    fn multi_term_query_requires_all_terms() {
        let (_dir, index, root) = fixture();
        session_file(
            &root.join("a.jsonl"),
            &[message("1", "user", "登录流程存在竞态问题")],
        );
        session_file(
            &root.join("b.jsonl"),
            &[message("1", "user", "登录页面样式调整")],
        );
        index.sync(&root, &mut |_, _| {}).unwrap();

        // 两个词都命中才算命中
        let both = index
            .search_filtered(&json!({ "query": "登录 竞态", "limit": 10 }))
            .unwrap();
        assert_eq!(both["total"], 1);
        assert_eq!(both["terms"].as_array().unwrap().len(), 2);
        assert!(both["items"][0]["title"].as_str().unwrap().contains("竞态"));

        // 只命中一个词不算
        assert_eq!(
            index
                .search_filtered(&json!({ "query": "登录 不存在", "limit": 10 }))
                .unwrap()["total"],
            0
        );
        // 含短词的查询整条回退 LIKE，仍然要求全部命中
        let mixed = index
            .search_filtered(&json!({ "query": "登录 页面", "limit": 10 }))
            .unwrap();
        assert_eq!(mixed["mode"], "like");
        assert_eq!(mixed["total"], 1);
    }

    #[test]
    fn filters_narrow_by_workspace_and_age() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        std::fs::create_dir_all(root.join("one")).unwrap();
        std::fs::create_dir_all(root.join("two")).unwrap();
        let index = SessionIndex::open(&dir.path().join("sessions.sqlite")).unwrap();

        // 两个不同工作区的会话，内容都能被同一个词命中
        let mut first = String::from("{\"type\":\"session\",\"cwd\":\"C:\\\\Work\\\\Alpha\"}\n");
        first.push_str(&message("1", "user", "共同的检索词 甲").to_string());
        first.push('\n');
        std::fs::write(root.join("one/a.jsonl"), first).unwrap();

        let mut second = String::from("{\"type\":\"session\",\"cwd\":\"C:\\\\Work\\\\Beta\"}\n");
        second.push_str(&message("1", "user", "共同的检索词 乙").to_string());
        second.push('\n');
        std::fs::write(root.join("two/b.jsonl"), second).unwrap();

        index.sync(&root, &mut |_, _| {}).unwrap();
        let all = index
            .search_filtered(&json!({ "query": "共同的检索词", "limit": 10 }))
            .unwrap();
        assert_eq!(all["total"], 2, "不加过滤应当两个都在");

        let scoped = index
            .search_filtered(&json!({
                "query": "共同的检索词", "limit": 10,
                "workspace": "c:/work/alpha/"
            }))
            .unwrap();
        assert_eq!(scoped["total"], 1, "工作区过滤应当只留 Alpha");
        assert!(scoped["items"][0]["title"].as_str().unwrap().contains("甲"));

        // 时间过滤：把入口 a 的修改时间改到 10 天前，最近 1 天的窗口就只剩 b
        let ten_days_ago =
            std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 86_400);
        let handle = std::fs::File::options()
            .write(true)
            .open(root.join("one/a.jsonl"))
            .unwrap();
        handle.set_modified(ten_days_ago).unwrap();
        drop(handle);
        index.sync(&root, &mut |_, _| {}).unwrap();

        let recent = index
            .search_filtered(&json!({ "query": "共同的检索词", "limit": 10, "sinceDays": 1 }))
            .unwrap();
        assert_eq!(recent["total"], 1, "最近 1 天只应命中 b");
        assert!(recent["items"][0]["title"].as_str().unwrap().contains("乙"));
        assert_eq!(
            index
                .search_filtered(&json!({ "query": "共同的检索词", "limit": 10, "sinceDays": 30 }))
                .unwrap()["total"],
            2,
            "30 天窗口应当包含两者"
        );
        // 0 表示不限时间
        assert_eq!(
            index
                .search_filtered(&json!({ "query": "共同的检索词", "limit": 10, "sinceDays": 0 }))
                .unwrap()["total"],
            2
        );
        // 未知工作区不命中
        assert_eq!(
            index
                .search_filtered(&json!({
                    "query": "共同的检索词", "limit": 10, "workspace": "D:/none"
                }))
                .unwrap()["total"],
            0
        );
    }

    #[test]
    fn stats_reports_files_and_characters() {
        let (_dir, index, root) = fixture();
        session_file(&root.join("a.json"), &[message("1", "user", "一二三四五")]);
        index.sync(&root, &mut |_, _| {}).unwrap();
        let stats = index.stats();
        assert_eq!(stats["files"], 1);
        assert!(stats["chars"].as_i64().unwrap() >= 5);
        assert!(stats["lastSyncAtMs"].as_i64().unwrap_or_default() > 0);
        assert!(stats["bytes"].as_u64().unwrap() > 0);
    }
}
