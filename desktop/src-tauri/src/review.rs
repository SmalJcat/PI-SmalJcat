use crate::workspace::{canonical, git_bytes, git_changes, within_workspace};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::Read,
    path::{Component, Path},
    time::{Duration, Instant},
};

pub fn search_files(cwd: &Path, query: &str) -> Result<Value> {
    let root = canonical(cwd)?;
    let query = query.replace('\\', "/").to_lowercase();
    let started = Instant::now();
    let mut results = Vec::new();
    let mut scanned = 0;
    let mut truncated = false;
    let walker = ignore::WalkBuilder::new(&root)
        .hidden(false)
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|entry| {
            ![
                ".git",
                "node_modules",
                "target",
                "release",
                "dist",
                "artifacts",
            ]
            .contains(&entry.file_name().to_string_lossy().as_ref())
        })
        .build();
    for entry in walker {
        scanned += 1;
        if scanned > 50000 || started.elapsed() > Duration::from_secs(2) {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(path) = canonical(entry.path()) else {
            continue;
        };
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        let text = relative.to_string_lossy().replace('\\', "/");
        let lower = text.to_lowercase();
        if lower.contains(&query) {
            let name = relative
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let score = if name.to_lowercase().starts_with(&query) {
                0
            } else {
                1
            };
            results.push((score, text, name));
        }
    }
    results.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.len().cmp(&b.1.len()))
            .then_with(|| a.1.cmp(&b.1))
    });
    let more = results.len() > 30;
    results.truncate(30);
    Ok(
        json!({"files":results.into_iter().map(|(_,path,name)|json!({"path":path,"name":name,"directory":false})).collect::<Vec<_>>(),"truncated":truncated||more}),
    )
}
pub fn reference_content(cwd: &Path, paths: &[String]) -> Result<String> {
    if paths.len() > 8 {
        bail!("一次最多引用 8 个文件。");
    }
    let mut total = 0;
    let mut output = String::new();
    let mut seen = std::collections::HashSet::new();
    for relative in paths {
        let target = within_workspace(cwd, relative)?;
        if !seen.insert(target.clone()) {
            continue;
        }
        let file = File::open(&target)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            bail!("引用必须是文件");
        }
        if metadata.len() > 256 * 1024 {
            bail!(
                "引用文件 {} 超过 256 KB，请只引用路径或缩小文件。",
                relative
            );
        }
        let mut bytes = Vec::new();
        file.take(256 * 1024 + 1).read_to_end(&mut bytes)?;
        total += bytes.len();
        if bytes.len() > 256 * 1024 || total > 1024 * 1024 {
            bail!("引用文件总大小不能超过 1 MB");
        }
        if bytes.contains(&0) {
            bail!("{} 是二进制文件，请通过附件发送。", relative);
        }
        let text =
            String::from_utf8(bytes).with_context(|| format!("{} 不是 UTF-8 文本", relative))?;
        output.push_str(&format!(
            "\n\n--- 引用文件：{} ---\n{}\n--- 引用结束 ---",
            relative, text
        ));
    }
    Ok(output)
}
fn safe_relative(relative: &str) -> Result<()> {
    if relative.is_empty()
        || Path::new(relative)
            .components()
            .any(|p| !matches!(p, Component::Normal(_) | Component::CurDir))
    {
        bail!("无效文件路径");
    }
    Ok(())
}
fn view(bytes: Vec<u8>) -> Value {
    if bytes.contains(&0) {
        return json!({"content":"二进制文件，不支持文本差异","binary":true,"truncated":false});
    }
    let truncated = bytes.len() > 256 * 1024;
    let end = bytes.len().min(256 * 1024);
    json!({"content":String::from_utf8_lossy(&bytes[..end]),"truncated":truncated,"binary":false})
}
pub async fn file_review(cwd: &Path, relative: &str, stage: &str) -> Result<Value> {
    safe_relative(relative)?;
    if !["working", "staged"].contains(&stage) {
        bail!("无效差异类型");
    }
    let cwd = canonical(cwd)?;
    let changes = git_changes(&cwd).await?;
    let change = changes["files"]
        .as_array()
        .and_then(|files| {
            files.iter().find(|file| {
                file["path"]
                    .as_str()
                    .is_some_and(|p| p.replace('\\', "/") == relative.replace('\\', "/"))
            })
        })
        .context("文件已没有 Git 改动，请刷新列表。")?;
    let status = change["status"].as_str().unwrap_or("  ");
    let root_text = git_bytes(&cwd, &["rev-parse", "--show-toplevel"]).await?;
    let root = canonical(Path::new(String::from_utf8_lossy(&root_text).trim()))?;
    let repo_relative = cwd
        .join(relative)
        .strip_prefix(&root)?
        .to_string_lossy()
        .replace('\\', "/");
    let old_relative = change["previous"]
        .as_str()
        .map(|p| cwd.join(p))
        .unwrap_or_else(|| cwd.join(relative));
    let old_relative = old_relative
        .strip_prefix(&root)?
        .to_string_lossy()
        .replace('\\', "/");
    let code = status.as_bytes();
    let untracked = status == "??";
    let (old_label, new_label, old, new) = if stage == "staged" {
        if code.first().is_none_or(|c| *c == b' ' || *c == b'?') {
            bail!("该文件没有已暂存改动");
        }
        let old = if code[0] == b'A' {
            Vec::new()
        } else {
            git_bytes(&root, &["show", &format!("HEAD:{old_relative}")]).await?
        };
        let new = if code[0] == b'D' {
            Vec::new()
        } else {
            git_bytes(&root, &["show", &format!(":{repo_relative}")]).await?
        };
        ("HEAD", "暂存区", old, new)
    } else {
        if !untracked && code.get(1) == Some(&b' ') {
            bail!("该文件没有未暂存改动");
        }
        let old = if untracked {
            Vec::new()
        } else {
            git_bytes(&root, &["show", &format!(":{repo_relative}")]).await?
        };
        let new = if code.get(1) == Some(&b'D') {
            Vec::new()
        } else {
            let target = within_workspace(&cwd, relative)?;
            let file = File::open(target)?;
            let mut bytes = Vec::new();
            file.take(256 * 1024 + 1).read_to_end(&mut bytes)?;
            bytes
        };
        (
            if untracked { "新文件" } else { "暂存区" },
            "工作区",
            old,
            new,
        )
    };
    let patch = if untracked {
        String::new()
    } else {
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv"];
        if stage == "staged" {
            args.push("--cached");
        }
        args.extend(["--", relative]);
        String::from_utf8_lossy(&git_bytes(&cwd, &args).await?).into_owned()
    };
    Ok(
        json!({"path":relative,"stage":stage,"oldLabel":old_label,"newLabel":new_label,"old":view(old),"new":view(new),"patch":patch,"status":status}),
    )
}
