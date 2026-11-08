//! 本地任务索引（路线图 P3.3）：把"每次读全部任务记录"变成一次 SQL 查询。
//!
//! 索引是**缓存**，不是事实来源：任务记录文件仍然是权威数据，索引可以随时重建。
//! 因此这里的策略是"可损坏、可丢弃、可重建"——文件坏了就改名挪走并重建，绝不阻塞启动。
//!
//! 只在索引里放检索需要的字段与一小段可搜索文本；任务正文不落索引，避免重复存储。

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, ErrorCode};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// 索引结构版本；变更时重建。
pub const SCHEMA_VERSION: i64 = 1;
/// 可搜索文本上限（每个任务）。
pub const SEARCHABLE_LIMIT: usize = 4096;
/// 单页上限。
pub const MAX_PAGE_SIZE: i64 = 100;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  searchable TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks (created_at DESC, id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_role ON tasks (role);
";

/// 索引里的一条任务投影：id / status / role / cwd / title / model / created / updated / archived / 可搜索文本。
type Projected = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    Option<i64>,
    String,
);

/// 从任务记录里抽取索引字段。
fn project(record: &Value) -> Option<Projected> {
    let id = record["id"].as_str()?.trim().to_owned();
    if id.is_empty() {
        return None;
    }
    let status = record["status"].as_str().unwrap_or_default().to_owned();
    let role = record["role"].as_str().unwrap_or("scout").to_owned();
    let cwd = record["cwd"].as_str().unwrap_or_default().to_owned();
    let title = record["task"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect::<String>();
    let model = record["model"].as_str().unwrap_or_default().to_owned();
    let created_at = record["createdAt"].as_u64().unwrap_or_default() as i64;
    let updated_at = record["updatedAt"].as_u64().unwrap_or(created_at as u64) as i64;
    let archived_at = record["archivedAt"].as_u64().map(|value| value as i64);
    let mut searchable = format!("{id}\n{title}\n{cwd}\n{model}\n{role}\n{status}").to_lowercase();
    if let Some(output) = record["output"].as_str() {
        searchable.push('\n');
        searchable.push_str(&output.to_lowercase());
    }
    if searchable.len() > SEARCHABLE_LIMIT {
        let mut cut = SEARCHABLE_LIMIT;
        while cut > 0 && !searchable.is_char_boundary(cut) {
            cut -= 1;
        }
        searchable.truncate(cut);
    }
    Some((
        id,
        status,
        role,
        cwd,
        title,
        model,
        created_at,
        updated_at,
        archived_at,
        searchable,
    ))
}

/// 任务索引。
pub struct IndexStore {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl IndexStore {
    /// 打开（必要时创建）索引。损坏的文件会被改名挪走并重建，而不是让调用方失败。
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("无法创建索引目录")?;
        }
        match Self::prepare(path) {
            Ok(connection) => Ok(Self {
                path: path.to_path_buf(),
                connection: Mutex::new(connection),
            }),
            Err(error) => {
                let quarantine = path.with_extension(format!("corrupt-{}", now_ms()));
                let _ = std::fs::rename(path, &quarantine);
                let connection = Self::prepare(path).with_context(|| {
                    format!(
                        "索引无法重建（原文件已挪到 {}）：{error:#}",
                        quarantine.display()
                    )
                })?;
                Ok(Self {
                    path: path.to_path_buf(),
                    connection: Mutex::new(connection),
                })
            }
        }
    }

    fn prepare(path: &Path) -> Result<Connection> {
        let connection = Connection::open(path).context("无法打开索引数据库")?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .context("无法设置索引忙等待")?;
        connection
            .execute_batch(SCHEMA)
            .context("无法初始化索引结构")?;
        // 触发一次真实读取，把"文件不是数据库"这类错误在打开阶段就暴露出来。
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .context("索引文件不可读")?;
        if version != SCHEMA_VERSION {
            connection
                .execute_batch("DELETE FROM tasks;")
                .context("无法重置旧版本索引")?;
            connection
                .execute(&format!("PRAGMA user_version = {SCHEMA_VERSION}"), [])
                .context("无法写入索引版本")?;
        }
        connection
            .execute(
                "INSERT INTO meta (key, value) VALUES ('schemaVersion', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![SCHEMA_VERSION.to_string()],
            )
            .context("无法写入索引元数据")?;
        Ok(connection)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 索引概况。
    pub fn stats(&self) -> Value {
        let connection = self.connection.lock().unwrap();
        let tasks: i64 = connection
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap_or_default();
        let last_rebuild: Option<String> = connection
            .query_row(
                "SELECT value FROM meta WHERE key = 'lastRebuildAtMs'",
                [],
                |row| row.get(0),
            )
            .ok();
        let bytes = std::fs::metadata(&self.path)
            .map(|meta| meta.len())
            .unwrap_or_default();
        let archived: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE archived_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or_default();
        json!({
            "path": self.path.to_string_lossy(),
            "schemaVersion": SCHEMA_VERSION,
            "tasks": tasks,
            "archived": archived,
            "bytes": bytes,
            "lastRebuildAtMs": last_rebuild.and_then(|value| value.parse::<u64>().ok()),
        })
    }

    /// 索引里的全部任务 id（用于清理记录已不存在的孤儿）。
    pub fn ids(&self) -> Result<Vec<String>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare("SELECT id FROM tasks")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|row| row.ok()).collect())
    }

    pub fn count(&self) -> i64 {
        self.connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap_or_default()
    }

    /// 清空索引内容（保留数据库文件）。正在使用的连接下删文件不安全，因此只清数据。
    pub fn reset(&self) -> Result<()> {
        let connection = self.connection.lock().unwrap();
        connection
            .execute_batch("DELETE FROM tasks; DELETE FROM meta WHERE key = 'lastRebuildAtMs';")
            .context("无法清空索引")?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        self.connection
            .lock()
            .unwrap()
            .execute("DELETE FROM tasks WHERE id = ?1", params![id])
            .context("无法从索引删除任务")?;
        Ok(())
    }

    /// 写入或替换一条任务。无法抽取 id 的记录会被跳过（返回 false）。
    pub fn upsert(&self, record: &Value) -> Result<bool> {
        let Some((
            id,
            status,
            role,
            cwd,
            title,
            model,
            created_at,
            updated_at,
            archived_at,
            searchable,
        )) = project(record)
        else {
            return Ok(false);
        };
        self.connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO tasks (id, status, role, cwd, title, model, created_at, updated_at, archived_at, searchable)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                   status = excluded.status, role = excluded.role, cwd = excluded.cwd,
                   title = excluded.title, model = excluded.model, created_at = excluded.created_at,
                   updated_at = excluded.updated_at, archived_at = excluded.archived_at,
                   searchable = excluded.searchable",
                params![id, status, role, cwd, title, model, created_at, updated_at, archived_at, searchable],
            )
            .context("无法写入索引")?;
        Ok(true)
    }

    /// 用给定的任务记录重建索引。progress 会在每批之后回调一次，便于界面显示进度。
    pub fn rebuild<F>(&self, records: &[Value], mut progress: F) -> Result<Value>
    where
        F: FnMut(u64, u64),
    {
        let started = now_ms();
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction().context("无法开始索引事务")?;
        transaction
            .execute("DELETE FROM tasks", [])
            .context("无法清空索引")?;
        let total = records.len() as u64;
        let mut indexed = 0_u64;
        let mut skipped = 0_u64;
        for (index, record) in records.iter().enumerate() {
            let Some((
                id,
                status,
                role,
                cwd,
                title,
                model,
                created_at,
                updated_at,
                archived_at,
                searchable,
            )) = project(record)
            else {
                skipped += 1;
                continue;
            };
            transaction
                .execute(
                    "INSERT OR REPLACE INTO tasks (id, status, role, cwd, title, model, created_at, updated_at, archived_at, searchable)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![id, status, role, cwd, title, model, created_at, updated_at, archived_at, searchable],
                )
                .context("无法写入索引")?;
            indexed += 1;
            if indexed.is_multiple_of(50) || index + 1 == records.len() {
                progress(indexed, total);
            }
        }
        transaction
            .execute(
                "INSERT INTO meta (key, value) VALUES ('lastRebuildAtMs', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![now_ms().to_string()],
            )
            .context("无法写入重建时间")?;
        transaction.commit().context("无法提交索引事务")?;
        Ok(json!({
            "indexed": indexed,
            "skipped": skipped,
            "total": total,
            "elapsedMs": now_ms().saturating_sub(started),
        }))
    }

    /// 检索任务。筛选先于分页，排序稳定（created_at 降序 + id 升序）。
    pub fn search(&self, options: &Value) -> Result<Value> {
        let query = options["query"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let status = options["status"].as_str().unwrap_or("all");
        let role = options["role"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let cwd = options["cwd"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let archive = options["archive"].as_str().unwrap_or("current");
        let page = options["page"].as_i64().unwrap_or(1).max(1);
        let page_size = options["pageSize"]
            .as_i64()
            .unwrap_or(20)
            .clamp(1, MAX_PAGE_SIZE);

        let mut clauses: Vec<String> = Vec::new();
        let mut bound: Vec<String> = Vec::new();
        if !query.is_empty() {
            clauses.push("searchable LIKE ?".into());
            bound.push(format!("%{}%", query.replace('%', "").replace('_', " ")));
        }
        match status {
            "all" => {}
            "active" => {
                clauses.push("status IN ('queued','starting','running','cancelling')".into())
            }
            "completed" => clauses.push("status = 'completed'".into()),
            "attention" => clauses.push("status IN ('failed','cancelled','interrupted')".into()),
            other => {
                if !other.is_empty()
                    && other
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
                {
                    clauses.push("status = ?".into());
                    bound.push(other.to_owned());
                } else {
                    bail!("状态筛选非法：{other}");
                }
            }
        }
        if !role.is_empty() {
            clauses.push("role = ?".into());
            bound.push(role);
        }
        if !cwd.is_empty() {
            clauses.push("cwd = ?".into());
            bound.push(cwd);
        }
        match archive {
            "all" => {}
            "archived" => clauses.push("archived_at IS NOT NULL".into()),
            "current" => clauses.push("archived_at IS NULL".into()),
            other => bail!("归档筛选非法：{other}"),
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };

        let connection = self.connection.lock().unwrap();
        let total: i64 = {
            let sql = format!("SELECT COUNT(*) FROM tasks{where_clause}");
            let mut statement = connection.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = bound
                .iter()
                .map(|value| value as &dyn rusqlite::ToSql)
                .collect();
            statement.query_row(params.as_slice(), |row| row.get(0))?
        };
        let sql = format!(
            "SELECT id, status, role, cwd, title, model, created_at, updated_at, archived_at
             FROM tasks{where_clause} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?"
        );
        let mut statement = connection.prepare(&sql)?;
        let mut params: Vec<&dyn rusqlite::ToSql> = bound
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql)
            .collect();
        let limit = page_size;
        let offset = (page - 1) * page_size;
        params.push(&limit);
        params.push(&offset);
        let items: Vec<Value> = statement
            .query_map(params.as_slice(), |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "status": row.get::<_, String>(1)?,
                    "role": row.get::<_, String>(2)?,
                    "cwd": row.get::<_, String>(3)?,
                    "title": row.get::<_, String>(4)?,
                    "model": row.get::<_, String>(5)?,
                    "createdAt": row.get::<_, i64>(6)?,
                    "updatedAt": row.get::<_, i64>(7)?,
                    "archivedAt": row.get::<_, Option<i64>>(8)?,
                }))
            })?
            .filter_map(|row| row.ok())
            .collect();
        Ok(json!({
            "items": items,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "totalPages": if page_size > 0 { (total + page_size - 1) / page_size } else { 0 },
        }))
    }
}

/// 供调用方判断的错误：索引文件不是数据库。
pub fn is_not_a_database(error: &rusqlite::Error) -> bool {
    matches!(error, rusqlite::Error::SqliteFailure(failure, _) if failure.code == ErrorCode::NotADatabase)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, status: &str, role: &str, task: &str, created: u64) -> Value {
        json!({
            "id": id,
            "status": status,
            "role": role,
            "cwd": "C:/work",
            "task": task,
            "model": "fixture/model",
            "createdAt": created,
            "updatedAt": created + 1,
            "output": format!("输出 {task}"),
        })
    }

    fn store(dir: &Path) -> IndexStore {
        IndexStore::open(&dir.join("index.sqlite")).unwrap()
    }

    #[test]
    fn opens_creates_schema_and_reports_stats() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        assert_eq!(store.count(), 0);
        let stats = store.stats();
        assert_eq!(stats["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(stats["tasks"], 0);
        assert_eq!(stats["archived"], 0);
        assert!(stats["bytes"].as_u64().unwrap() > 0);
    }

    #[test]
    fn upsert_replaces_and_projects_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        assert!(store
            .upsert(&record("a", "completed", "scout", "检查登录", 10))
            .unwrap());
        assert!(store
            .upsert(&record("a", "failed", "scout", "检查登录", 10))
            .unwrap());
        assert_eq!(store.count(), 1, "同一 id 应当替换而不是重复插入");
        let found = store.search(&json!({"query": "检查登录"})).unwrap();
        assert_eq!(found["items"][0]["status"], "failed");
        assert_eq!(found["items"][0]["role"], "scout");
        // 缺 id 的记录被跳过
        assert!(!store.upsert(&json!({"status": "completed"})).unwrap());
        assert_eq!(store.count(), 1);
    }

    #[test]
    fn search_filters_before_paging_and_sorts_stably() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        for index in 0..25 {
            let role = if index % 2 == 0 { "scout" } else { "editor" };
            store
                .upsert(&record(
                    &format!("t{index:02}"),
                    "completed",
                    role,
                    if index == 3 {
                        "特殊关键词"
                    } else {
                        "常规任务"
                    },
                    index as u64,
                ))
                .unwrap();
        }
        let page1 = store.search(&json!({"page": 1, "pageSize": 10})).unwrap();
        assert_eq!(page1["total"], 25);
        assert_eq!(page1["totalPages"], 3);
        assert_eq!(page1["items"].as_array().unwrap().len(), 10);
        assert_eq!(page1["items"][0]["id"], "t24", "最新的排最前");
        let page3 = store.search(&json!({"page": 3, "pageSize": 10})).unwrap();
        assert_eq!(page3["items"].as_array().unwrap().len(), 5);

        let by_role = store.search(&json!({"role": "editor"})).unwrap();
        assert_eq!(by_role["total"], 12);
        let by_query = store.search(&json!({"query": "特殊关键词"})).unwrap();
        assert_eq!(by_query["total"], 1);
        assert_eq!(by_query["items"][0]["id"], "t03");
        // 输出也参与检索
        assert_eq!(
            store.search(&json!({"query": "输出 常规任务"})).unwrap()["total"],
            24
        );
        assert_eq!(
            store.search(&json!({"status": "active"})).unwrap()["total"],
            0
        );
        assert_eq!(
            store.search(&json!({"status": "completed"})).unwrap()["total"],
            25
        );
        assert!(store
            .search(&json!({"status": "'; DROP TABLE tasks; --"}))
            .is_err());
        assert!(store.search(&json!({"archive": "nonsense"})).is_err());
    }

    #[test]
    fn archive_filter_and_remove_work() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let mut archived = record("old", "completed", "scout", "旧任务", 5);
        archived["archivedAt"] = json!(99);
        store.upsert(&archived).unwrap();
        store
            .upsert(&record("new", "completed", "scout", "新任务", 6))
            .unwrap();
        assert_eq!(
            store.search(&json!({})).unwrap()["total"],
            1,
            "默认只看未归档"
        );
        assert_eq!(
            store.search(&json!({"archive": "archived"})).unwrap()["total"],
            1
        );
        assert_eq!(
            store.search(&json!({"archive": "all"})).unwrap()["total"],
            2
        );
        assert_eq!(store.stats()["archived"], 1);
        store.remove("old").unwrap();
        assert_eq!(store.count(), 1);
    }

    #[test]
    fn rebuild_reports_progress_and_is_transactional() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store
            .upsert(&record("stale", "completed", "scout", "应当被清掉", 1))
            .unwrap();

        let mut records: Vec<Value> = (0..120)
            .map(|index| {
                record(
                    &format!("r{index}"),
                    "completed",
                    "verifier",
                    "重建任务",
                    index,
                )
            })
            .collect();
        records.push(json!({"status": "completed"})); // 缺 id：应计入 skipped
        let mut progress_calls = Vec::new();
        let summary = store
            .rebuild(&records, |done, total| progress_calls.push((done, total)))
            .unwrap();
        assert_eq!(summary["indexed"], 120);
        assert_eq!(summary["skipped"], 1);
        assert_eq!(store.count(), 120);
        assert!(progress_calls.len() >= 2, "应当分批汇报进度");
        assert_eq!(progress_calls.last().unwrap().1, 121);
        assert!(store.search(&json!({"query": "应当被清掉"})).unwrap()["total"] == 0);
        assert!(store.stats()["lastRebuildAtMs"].as_u64().unwrap() > 0);
    }

    #[test]
    fn data_survives_reopen_and_a_corrupt_file_is_quarantined() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.sqlite");
        {
            let store = IndexStore::open(&path).unwrap();
            store
                .upsert(&record("keep", "completed", "scout", "持久化", 7))
                .unwrap();
        }
        let reopened = IndexStore::open(&path).unwrap();
        assert_eq!(reopened.count(), 1, "重开后数据仍在");

        // 用一个真正的垃圾文件替换索引：应当被挪走并重建，而不是让调用方失败
        drop(reopened);
        std::fs::write(&path, b"this is not a sqlite database at all").unwrap();
        let recovered = IndexStore::open(&path).unwrap();
        assert_eq!(recovered.count(), 0, "重建后是空索引");
        let quarantined: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains("corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1, "损坏文件应当被改名保留");
        // 重建后可以继续写入
        assert!(recovered
            .upsert(&record("after", "completed", "scout", "恢复后写入", 8))
            .unwrap());
        assert_eq!(recovered.count(), 1);
    }

    #[test]
    fn searchable_text_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let mut huge = record("big", "completed", "scout", "大输出", 1);
        huge["output"] = json!("x".repeat(SEARCHABLE_LIMIT * 2));
        store.upsert(&huge).unwrap();
        let length: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT length(searchable) FROM tasks WHERE id = 'big'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            length as usize <= SEARCHABLE_LIMIT + 200,
            "可搜索文本应当被截断：{length}"
        );
    }
}
