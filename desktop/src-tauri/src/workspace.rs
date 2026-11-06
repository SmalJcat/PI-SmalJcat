use crate::rpc::hide_console;
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{timeout, Duration},
};

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}
pub fn expand_path(value: &str, cwd: &Path) -> PathBuf {
    let path = if value == "~" {
        home()
    } else if value.starts_with("~/") || value.starts_with("~\\") {
        home().join(&value[2..])
    } else {
        PathBuf::from(value)
    };
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}
pub fn canonical(path: &Path) -> Result<PathBuf> {
    dunce::canonicalize(path).with_context(|| format!("无法访问 {}", path.display()))
}
pub fn agent_dir() -> PathBuf {
    std::env::var("PI_CODING_AGENT_DIR")
        .map(|p| expand_path(&p, &std::env::current_dir().unwrap_or_else(|_| home())))
        .unwrap_or_else(|_| home().join(".pi/agent"))
}
pub fn read_json(file: &Path) -> Result<Value> {
    match fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("配置 JSON 无效：{}", file.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error).with_context(|| format!("无法读取 {}", file.display())),
    }
}
pub fn session_root(cwd: &Path, config: &Path) -> Result<PathBuf> {
    let global = read_json(&config.join("settings.json"))?;
    let project = read_json(&cwd.join(".pi/settings.json"))?;
    let custom = std::env::var("PI_CODING_AGENT_SESSION_DIR")
        .ok()
        .or_else(|| project["sessionDir"].as_str().map(String::from))
        .or_else(|| global["sessionDir"].as_str().map(String::from));
    Ok(custom
        .map(|p| expand_path(&p, cwd))
        .unwrap_or_else(|| config.join("sessions")))
}
fn text_content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| {
                    if b["type"] == "text" {
                        b["text"].as_str()
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}
pub fn session_metadata(file: &Path) -> Result<Value> {
    let metadata = fs::metadata(file)?;
    let mut reader = BufReader::new(File::open(file)?);
    let mut header = Value::Null;
    let mut name = None;
    let mut first = String::new();
    loop {
        let mut line = Vec::new();
        let count = reader
            .by_ref()
            .take(64 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if count > 64 * 1024 * 1024 {
            bail!("会话中存在过大的单条记录");
        }
        let Ok(entry) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        match entry["type"].as_str().unwrap_or_default() {
            "session" => header = entry,
            "session_info" => name = entry["name"].as_str().map(String::from),
            "message" if first.is_empty() && entry["message"]["role"] == "user" => {
                first = text_content(&entry["message"]["content"])
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(90)
                    .collect();
            }
            _ => {}
        }
    }
    if !header["cwd"].is_string() || !header["id"].is_string() {
        bail!("无效 Pi 会话文件：{}", file.display());
    }
    let title = name.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if first.is_empty() {
            "未命名会话".into()
        } else {
            first
        }
    });
    Ok(
        json!({"path":file,"id":header["id"],"cwd":header["cwd"],"name":title,"updatedAt":metadata.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}),
    )
}
#[derive(Default)]
pub struct SessionIndex {
    cache: HashMap<PathBuf, (std::time::SystemTime, u64, Value)>,
}
impl SessionIndex {
    pub fn list(&mut self, cwd: &Path, config: &Path) -> Result<Value> {
        let root = session_root(cwd, config)?;
        let mut paths = Vec::new();
        collect_sessions(&root, 0, &mut paths)?;
        let mut result = Vec::new();
        for path in paths {
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            if let Some((previous, length, value)) = self.cache.get(&path) {
                if *previous == modified && *length == metadata.len() {
                    result.push(value.clone());
                    continue;
                }
            }
            if let Ok(value) = session_metadata(&path) {
                if self.cache.len() > 1000 {
                    self.cache.clear();
                }
                self.cache
                    .insert(path, (modified, metadata.len(), value.clone()));
                result.push(value);
            }
        }
        result.sort_by_key(|v| std::cmp::Reverse(v["updatedAt"].as_u64().unwrap_or_default()));
        result.truncate(300);
        Ok(json!(result))
    }
}
fn collect_sessions(directory: &Path, depth: usize, paths: &mut Vec<PathBuf>) -> Result<()> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries.flatten() {
        let kind = entry.file_type()?;
        if kind.is_dir() && depth < 1 {
            collect_sessions(&entry.path(), depth + 1, paths)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            paths.push(entry.path());
        }
    }
    Ok(())
}
pub fn branch_messages(entries: &[Value], leaf: Option<&str>) -> Vec<Value> {
    let by_id: HashMap<_, _> = entries
        .iter()
        .filter_map(|entry| entry["id"].as_str().map(|id| (id, entry)))
        .collect();
    let mut seen = HashSet::new();
    let mut branch = Vec::new();
    let mut current = leaf;
    while let Some(id) = current {
        if !seen.insert(id) {
            break;
        }
        let Some(entry) = by_id.get(id) else {
            break;
        };
        branch.push(*entry);
        current = entry["parentId"].as_str();
    }
    branch.reverse();
    branch.iter().filter_map(|entry| match entry["type"].as_str().unwrap_or_default() {
        "message" => Some(entry["message"].clone()),
        "custom_message" => { let mut result = (*entry).clone(); result["role"] = "custom".into(); Some(result) },
        "compaction" | "branch_summary" => Some(json!({"role": if entry["type"] == "compaction" {"compactionSummary"} else {"branchSummary"}, "summary":entry["summary"], "timestamp": entry["timestamp"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp_millis())})),
        _ => None,
    }).collect()
}
pub fn within_workspace(cwd: &Path, relative: &str) -> Result<PathBuf> {
    let root = canonical(cwd)?;
    let target = canonical(&root.join(relative))?;
    if !target.starts_with(&root) {
        bail!("该路径位于当前工作区之外。");
    }
    Ok(target)
}
pub fn list_files(cwd: &Path, relative: &str) -> Result<Value> {
    let root = canonical(cwd)?;
    let directory = within_workspace(&root, relative)?;
    let mut values = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_symlink() || [".git", "node_modules", "target"].contains(&name.as_str()) {
            continue;
        }
        let target = canonical(&entry.path())?;
        if !target.starts_with(&root) {
            continue;
        }
        values.push(
            json!({"name":name,"path":target.strip_prefix(&root)?,"directory":kind.is_dir()}),
        );
    }
    values.sort_by(|a, b| {
        b["directory"]
            .as_bool()
            .cmp(&a["directory"].as_bool())
            .then_with(|| {
                a["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .cmp(&b["name"].as_str().unwrap_or_default().to_lowercase())
            })
    });
    Ok(json!(values))
}
pub fn preview_file(cwd: &Path, relative: &str) -> Result<Value> {
    let target = within_workspace(cwd, relative)?;
    let file = File::open(&target)?;
    let info = file.metadata()?;
    if !info.is_file() {
        bail!("请选择文件。");
    }
    let mut bytes = Vec::new();
    file.take(256 * 1024).read_to_end(&mut bytes)?;
    if bytes.contains(&0) {
        return Ok(
            json!({"path":relative,"content":"二进制文件，暂不支持文本预览。","truncated":false}),
        );
    }
    Ok(
        json!({"path":relative,"content":String::from_utf8_lossy(&bytes),"truncated":info.len()>bytes.len() as u64}),
    )
}
pub fn attachments(paths: &[String]) -> Result<Value> {
    if paths.len() > 8 {
        bail!("一次最多添加 8 个附件。");
    }
    let mut result = Vec::new();
    let mut total = 0;
    for name in paths {
        let path = Path::new(name);
        let file = File::open(path)?;
        let info = file.metadata()?;
        if !info.is_file() {
            bail!("附件必须是文件。");
        }
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let mime = match extension.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            _ => None,
        };
        let limit = if mime.is_some() {
            20 * 1024 * 1024
        } else {
            256 * 1024
        };
        if info.len() > limit {
            bail!(
                "附件过大：{}（图片总计最多 20 MB，单个文本最多 256 KB）",
                path.display()
            );
        }
        let mut bytes = Vec::new();
        file.take(limit + 1).read_to_end(&mut bytes)?;
        total += bytes.len();
        if bytes.len() as u64 > limit || total > 20 * 1024 * 1024 {
            bail!("附件超过大小限制。");
        }
        let mut value = json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"path":path,"size":bytes.len()});
        if let Some(mime) = mime {
            value["mimeType"] = mime.into();
            value["data"] = STANDARD.encode(bytes).into();
        } else {
            if bytes.contains(&0) {
                bail!("不支持的二进制附件：{}", path.display());
            }
            value["text"] = String::from_utf8_lossy(&bytes).into_owned().into();
        }
        result.push(value);
    }
    Ok(json!(result))
}
async fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let bytes = git_bytes(cwd, args).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
pub(crate) async fn git_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut command);
    let mut child = command.spawn().context("未找到 Git 或无法启动 Git")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let operation = async {
        let out = async {
            let mut bytes = Vec::new();
            stdout
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let err = async {
            let mut bytes = Vec::new();
            stderr.take(64 * 1024).read_to_end(&mut bytes).await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let (out, err) = tokio::try_join!(out, err)?;
        if out.len() > 4 * 1024 * 1024 {
            bail!("Git 输出超过 4 MB，请缩小工作区范围。");
        }
        let status = child.wait().await?;
        if !status.success() {
            bail!("{}", String::from_utf8_lossy(&err));
        }
        Ok(out)
    };
    timeout(Duration::from_secs(15), operation)
        .await
        .context("Git 查询超时")?
}
pub async fn git_changes(cwd: &Path) -> Result<Value> {
    let probe = tokio::try_join!(
        git(
            cwd,
            &[
                "-c",
                "core.quotepath=false",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                "."
            ]
        ),
        git(cwd, &["branch", "--show-current"]),
        git(cwd, &["rev-parse", "--show-toplevel"])
    );
    let (status, branch, root) = match probe {
        Ok(values) => values,
        Err(error) => {
            return Ok(
                json!({"available":false,"branch":"","files":[],"reason":format!("当前文件夹的 Git 状态不可用：{error}")}),
            )
        }
    };
    let cwd = canonical(cwd)?;
    let root = canonical(Path::new(root.trim()))?;
    let mut records = status.split('\0');
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 3 {
            continue;
        }
        let status = &record[..2];
        let file = root.join(&record[3..]);
        let previous = if status.contains(['R', 'C']) {
            records.next()
        } else {
            None
        };
        let Ok(relative) = file.strip_prefix(&cwd) else {
            continue;
        };
        files.push(json!({"path":relative,"status":status,"previous":previous.and_then(|p| root.join(p).strip_prefix(&cwd).ok().map(Path::to_path_buf))}));
    }
    Ok(
        json!({"available":true,"branch":if branch.trim().is_empty() {"detached HEAD"} else {branch.trim()},"files":files}),
    )
}
pub async fn git_diff(cwd: &Path, relative: &str) -> Result<Value> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        bail!("无效文件路径");
    }
    let unstaged_args = ["diff", "--no-ext-diff", "--no-textconv", "--", relative];
    let staged_args = [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        relative,
    ];
    let (unstaged, staged) = tokio::try_join!(git(cwd, &unstaged_args), git(cwd, &staged_args))?;
    let mut content = String::new();
    if !unstaged.is_empty() {
        content.push_str(&format!("未暂存\n{unstaged}"));
    }
    if !staged.is_empty() {
        content.push_str(&format!("\n已暂存\n{staged}"));
    }
    if !content.is_empty() {
        return Ok(json!({"path":relative,"content":content,"diff":true}));
    }
    let cwd = cwd.to_owned();
    let relative = relative.to_owned();
    tokio::task::spawn_blocking(move || preview_file(&cwd, &relative)).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_branch_and_compaction_history() {
        let entries = vec![
            json!({"id":"a","parentId":null,"type":"message","message":{"role":"user","content":"root"}}),
            json!({"id":"b","parentId":"a","type":"message","message":{"role":"assistant","content":"abandoned"}}),
            json!({"id":"c","parentId":"a","type":"compaction","summary":"summary"}),
            json!({"id":"d","parentId":"c","type":"message","message":{"role":"user","content":"selected"}}),
        ];
        let messages = branch_messages(&entries, Some("d"));
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"], "root");
        assert_eq!(messages[2]["content"], "selected");
        assert!(branch_messages(&entries, None).is_empty());
    }
    #[test]
    fn metadata_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("session.jsonl");
        fs::write(
            &file,
            format!(
                "{}\n{}\n{}\n{{partial",
                json!({"type":"session","id":"one","cwd":dir.path()}),
                json!({"type":"message","message":{"role":"user","content":"first"}}),
                json!({"type":"session_info","name":"新名称"})
            ),
        )
        .unwrap();
        assert_eq!(session_metadata(&file).unwrap()["name"], "新名称");
        fs::write(dir.path().join("large.txt"), "x".repeat(300000)).unwrap();
        let preview = preview_file(dir.path(), "large.txt").unwrap();
        assert_eq!(preview["truncated"], true);
        assert_eq!(preview["content"].as_str().unwrap().len(), 256 * 1024);
        assert!(attachments(&[dir.path().join("large.txt").to_string_lossy().into()]).is_err());
        fs::write(dir.path().join("binary"), [0, 1, 2]).unwrap();
        assert!(attachments(&[dir.path().join("binary").to_string_lossy().into()]).is_err());
    }
    #[test]
    fn traversal_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("work")).unwrap();
        fs::write(dir.path().join("outside"), "secret").unwrap();
        assert!(within_workspace(&dir.path().join("work"), "../outside").is_err());
    }
}
