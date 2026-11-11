//! git worktree 隔离（路线图 P3.2）：可写子代理在独立工作树里改代码，
//! 主工作区不受影响，产出的分支由使用者决定是否合并。
//!
//! 只做三件事：判断仓库、创建或移除工作树、列出工作树。不自动合并、不删分支——
//! 合并是需要人来决定的操作。

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

/// 一个工作树。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    /// 是否是主工作树（仓库本身）。
    pub main: bool,
}

fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let mut command = std::process::Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .with_context(|| format!("无法运行 git（{}）", args.join(" ")))?;
    if !output.status.success() {
        bail!(
            "git {} 失败：{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(300)
                .collect::<String>()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 工作区是否是 git 仓库（工作树内也算）。
pub fn is_repo(repo: &Path) -> bool {
    git(repo, &["rev-parse", "--is-inside-work-tree"])
        .map(|out| out.trim() == "true")
        .unwrap_or(false)
}

/// 仓库根目录（用于把工作树挂在同一仓库下）。
pub fn repo_root(repo: &Path) -> Result<PathBuf> {
    let out = git(repo, &["rev-parse", "--show-toplevel"]).context("不在 git 仓库内")?;
    let path = PathBuf::from(out.trim());
    if path.as_os_str().is_empty() {
        bail!("无法确定仓库根目录");
    }
    Ok(path)
}

/// 当前分支名（可能为空，例如游离头指针）。
pub fn current_branch(repo: &Path) -> String {
    git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|out| out.trim().to_owned())
        .unwrap_or_default()
}

/// 以当前 HEAD 为起点，创建分支 branch 的独立工作树到 path。
pub fn create(repo: &Path, path: &Path, branch: &str) -> Result<Worktree> {
    if !is_repo(repo) {
        bail!("工作区不是 git 仓库，无法创建工作树");
    }
    if branch.trim().is_empty()
        || !branch
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
    {
        bail!("分支名非法：{branch}");
    }
    if path.exists() {
        bail!("工作树目录已存在：{}", path.display());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("无法创建工作树父目录")?;
    }
    git(
        repo,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            &path.to_string_lossy(),
            "HEAD",
        ],
    )?;
    Ok(Worktree {
        path: path.to_string_lossy().into_owned(),
        branch: branch.to_owned(),
        main: false,
    })
}

/// 移除工作树（保留分支，方便事后审阅或合并）。
/// 拒绝移除主工作树：那是工作区本身，删掉等于删用户的仓库目录。
pub fn remove(repo: &Path, path: &Path) -> Result<()> {
    if let Ok(root) = repo_root(repo) {
        let target = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let root = root.canonicalize().unwrap_or(root);
        if target == root {
            bail!("拒绝移除主工作树（那是工作区本身）");
        }
    }
    git(
        repo,
        &["worktree", "remove", "--force", &path.to_string_lossy()],
    )
    .context("移除工作树失败（可能仍有进程占用该目录）")?;
    Ok(())
}

/// 列出仓库的所有工作树。
pub fn list(repo: &Path) -> Result<Vec<Worktree>> {
    let out = git(repo, &["worktree", "list", "--porcelain"])?;
    let mut items: Vec<Worktree> = Vec::new();
    for block in out.split("\n\n") {
        let mut path = String::new();
        let mut branch = String::new();
        let mut detached = false;
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = value.trim().to_owned();
            } else if let Some(value) = line.strip_prefix("branch ") {
                branch = value.trim().trim_start_matches("refs/heads/").to_owned();
            } else if line.trim() == "detached" {
                detached = true;
            }
        }
        if path.is_empty() {
            continue;
        }
        let main = items.is_empty();
        items.push(Worktree {
            path,
            branch: if detached { String::new() } else { branch },
            main,
        });
    }
    Ok(items)
}

/// 生成给子代理用的分支名：带前缀 + 任务短 id，避免与人工分支混淆。
pub fn branch_for(task_id: &str) -> String {
    let short: String = task_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!("pi-desktop/{short}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q"]).unwrap();
        git(dir, &["config", "user.email", "test@example.com"]).unwrap();
        git(dir, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(dir.join("readme.md"), "hello\n").unwrap();
        git(dir, &["add", "."]).unwrap();
        git(
            dir,
            &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
        )
        .unwrap();
    }

    #[test]
    fn non_repo_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_repo(dir.path()));
        assert!(create(dir.path(), &dir.path().join("wt"), "pi-desktop/x").is_err());
        assert!(repo_root(dir.path()).is_err());
    }

    #[test]
    fn creates_lists_and_removes_a_worktree() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        assert!(is_repo(dir.path()));
        let branch = branch_for("f47ac10b-58cc-4372-a567-0e02b2c3d479");
        assert_eq!(branch, "pi-desktop/f47ac10b58cc");

        let target = dir.path().join("worktrees").join("t1");
        let created = create(dir.path(), &target, &branch).unwrap();
        assert_eq!(created.branch, branch);
        assert!(target.is_dir());
        assert!(
            target.join("readme.md").is_file(),
            "工作树应当检出 HEAD 内容"
        );

        let listed = list(dir.path()).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].main, "第一项是主工作树");
        assert_eq!(listed[1].branch, branch);

        // 在 worktree 里改文件不会影响主工作区
        std::fs::write(target.join("readme.md"), "changed in worktree\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("readme.md")).unwrap(),
            "hello\n"
        );

        assert!(
            remove(dir.path(), dir.path()).is_err(),
            "主工作树不能被移除"
        );
        remove(dir.path(), &target).unwrap();
        assert!(!target.exists());
        assert_eq!(list(dir.path()).unwrap().len(), 1);
        // 创建到已存在的目录要拒绝
        std::fs::create_dir_all(&target).unwrap();
        assert!(create(dir.path(), &target, "pi-desktop/again").is_err());
    }

    #[test]
    fn branch_names_are_restricted() {
        assert_eq!(branch_for("abc"), "pi-desktop/abc");
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        assert!(create(dir.path(), &dir.path().join("wt2"), "bad branch name").is_err());
        assert!(create(dir.path(), &dir.path().join("wt2"), "").is_err());
    }
}
