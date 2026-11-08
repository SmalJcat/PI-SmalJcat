//! Read-only history queries and bounded, branch-aware output pages.
use crate::agents::Task;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    path::Path,
};

const PAGE_BYTES: usize = 64 * 1024;
const SESSION_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub query: String,
    pub status: String,
    pub cwd: Option<String>,
    pub archive: String,
    pub page: Option<usize>,
    pub page_size: Option<usize>,
}
impl Query {
    pub fn page_size(&self) -> Result<usize> {
        if self.query.len() > 1024
            || self.page == Some(0)
            || self
                .page_size
                .is_some_and(|size| !(1..=100).contains(&size))
            || !["", "all", "active", "completed", "attention"].contains(&self.status.as_str())
            || !["", "current", "archived", "all"].contains(&self.archive.as_str())
        {
            bail!("任务筛选或分页参数无效");
        }
        Ok(self
            .page_size
            .unwrap_or(if self.page.is_some() { 20 } else { 300 }))
    }
    pub fn matches(&self, task: &Task) -> bool {
        let query = self.query.trim().to_lowercase();
        let matches_text = query.is_empty()
            || [
                task.id.as_str(),
                task.task.as_str(),
                task.model.as_str(),
                &task.cwd.to_string_lossy(),
            ]
            .iter()
            .any(|value| value.to_lowercase().contains(&query));
        let matches_status = match self.status.as_str() {
            "active" => task.active(),
            "completed" => task.status == "completed",
            "attention" => ["failed", "interrupted", "cancelled"].contains(&task.status.as_str()),
            _ => true,
        };
        let matches_archive = match self.archive.as_str() {
            "all" => true,
            "archived" => task.archived_at.is_some(),
            _ => task.archived_at.is_none(),
        };
        matches_text
            && matches_status
            && matches_archive
            && self
                .cwd
                .as_ref()
                .is_none_or(|cwd| normalize(cwd) == normalize(&task.cwd.to_string_lossy()))
    }
}
fn normalize(path: &str) -> String {
    let path = path.replace('\\', "/").trim_end_matches('/').to_owned();
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

pub fn session_output(path: &Path) -> Result<(String, String)> {
    let file = File::open(path).context("无法读取子会话，完整结果不可用")?;
    if !file.metadata()?.is_file() {
        bail!("子会话不是文件");
    }
    let mut bytes = Vec::new();
    file.take(SESSION_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > SESSION_BYTES {
        bail!("子会话超过 64 MiB，请使用 Pi CLI 查看完整历史");
    }
    let version = format!("{:x}", Sha256::digest(&bytes));
    struct Entry {
        parent: Option<String>,
        text: String,
    }
    let mut entries = HashMap::new();
    let mut leaf = None;
    let mut header = false;
    for line in bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        let value: Value =
            serde_json::from_slice(line).context("子会话记录不完整或损坏，完整结果不可用")?;
        if !header {
            if value["type"] != "session" {
                bail!("子会话缺少有效文件头");
            }
            header = true;
            continue;
        }
        let Some(id) = value["id"].as_str() else {
            continue;
        };
        let text = if value["type"] == "message" && value["message"]["role"] == "assistant" {
            message_text(&value["message"]["content"])
        } else {
            String::new()
        };
        let entry = Entry {
            parent: value["parentId"].as_str().map(String::from),
            text,
        };
        if entries.insert(id.to_owned(), entry).is_some() {
            bail!("子会话记录 ID 重复");
        }
        leaf = Some(id.to_owned());
    }
    if !header {
        bail!("子会话为空，完整结果不可用");
    }
    let mut seen = HashSet::new();
    let mut texts = Vec::new();
    while let Some(id) = leaf {
        if !seen.insert(id.clone()) {
            bail!("子会话分支存在循环");
        }
        let entry = entries.get(&id).context("子会话分支记录缺失")?;
        if !entry.text.is_empty() {
            texts.push(entry.text.as_str());
        }
        leaf = entry.parent.clone();
    }
    texts.reverse();
    Ok((texts.join("\n\n"), version))
}
pub(crate) fn message_text(content: &Value) -> String {
    content.as_str().map(String::from).unwrap_or_else(|| {
        content
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| block["type"] == "text")
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    })
}
pub fn output_page(
    text: &str,
    version: &str,
    source: &str,
    offset: usize,
    expected: Option<&str>,
) -> Result<Value> {
    if (offset > 0 && expected.is_none()) || expected.is_some_and(|value| value != version) {
        bail!("结果已变化或分页版本缺失，请重新加载完整结果");
    }
    if offset > text.len() || !text.is_char_boundary(offset) {
        bail!("结果分页位置无效");
    }
    let mut end = offset.saturating_add(PAGE_BYTES).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(
        json!({"text":&text[offset..end],"offset":offset,"nextOffset":if end < text.len() {Some(end)} else {None},"totalBytes":text.len(),"version":version,"source":source}),
    )
}
pub fn record_output(task: &Task) -> Result<(String, String)> {
    if task.truncated {
        bail!("记录已截断且没有保存的子会话，无法恢复完整结果");
    }
    let text = [&task.output, &task.partial]
        .into_iter()
        .filter(|text| !text.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n\n");
    let version = format!("{:x}", Sha256::digest(text.as_bytes()));
    Ok((text, version))
}
