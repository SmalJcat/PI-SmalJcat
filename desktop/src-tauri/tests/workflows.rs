use anyhow::Result;
use pi_desktop::{review, session_guard};
use std::{fs, path::Path};
use tokio::process::Command;
async fn git(dir: &Path, args: &[&str]) -> Result<()> {
    let result = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .await?;
    anyhow::ensure!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(())
}
#[test]
fn references_read_current_content_and_reject_escape_or_binary() -> Result<()> {
    let dir = tempfile::tempdir()?;
    fs::create_dir(dir.path().join("work"))?;
    let work = dir.path().join("work");
    fs::write(work.join("a.txt"), "actual content")?;
    fs::write(work.join("binary"), [0, 1])?;
    fs::write(dir.path().join("outside"), "secret")?;
    assert!(review::reference_content(&work, &["a.txt".into()])?.contains("actual content"));
    assert!(review::reference_content(&work, &["../outside".into()]).is_err());
    assert!(review::reference_content(&work, &["binary".into()]).is_err());
    Ok(())
}
#[test]
fn search_respects_ignore_rules_and_skips_build_directories() -> Result<()> {
    let dir = tempfile::tempdir()?;
    fs::create_dir(dir.path().join("src"))?;
    fs::create_dir(dir.path().join("node_modules"))?;
    fs::write(dir.path().join("src/main.rs"), "fn main(){}")?;
    fs::write(dir.path().join("node_modules/main.js"), "dependency")?;
    fs::write(dir.path().join("ignored.txt"), "ignored")?;
    fs::write(dir.path().join(".gitignore"), "ignored.txt\n")?;
    let result = review::search_files(dir.path(), "main")?;
    assert_eq!(result["files"].as_array().unwrap().len(), 1);
    assert_eq!(result["files"][0]["path"], "src/main.rs");
    assert!(review::search_files(dir.path(), "ignored")?["files"]
        .as_array()
        .unwrap()
        .is_empty());
    Ok(())
}
#[tokio::test]
async fn review_compares_correct_staged_and_working_content() -> Result<()> {
    let dir = tempfile::tempdir()?;
    git(dir.path(), &["init"]).await?;
    fs::write(dir.path().join("a.txt"), "head\n")?;
    git(dir.path(), &["add", "."]).await?;
    git(
        dir.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "base",
        ],
    )
    .await?;
    fs::write(dir.path().join("a.txt"), "index\n")?;
    git(dir.path(), &["add", "."]).await?;
    fs::write(dir.path().join("a.txt"), "working\n")?;
    let staged = review::file_review(dir.path(), "a.txt", "staged").await?;
    assert_eq!(staged["old"]["content"], "head\n");
    assert_eq!(staged["new"]["content"], "index\n");
    let working = review::file_review(dir.path(), "a.txt", "working").await?;
    assert_eq!(working["old"]["content"], "index\n");
    assert_eq!(working["new"]["content"], "working\n");
    fs::write(dir.path().join("new.txt"), "new")?;
    assert_eq!(
        review::file_review(dir.path(), "new.txt", "working").await?["old"]["content"],
        ""
    );
    fs::remove_file(dir.path().join("a.txt"))?;
    assert_eq!(
        review::file_review(dir.path(), "a.txt", "working").await?["new"]["content"],
        ""
    );
    Ok(())
}
#[test]
fn guard_rejects_external_rewrite_before_mutation() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let file = dir.path().join("session.jsonl");
    fs::write(&file, "abc")?;
    let guard = session_guard::SessionGuard {
        path: file.clone(),
        lease: session_guard::acquire(&dir.path().join("locks"), &file)?,
        baseline: session_guard::stamp(&file)?,
        known_processes: session_guard::pi_processes()?,
        expecting_write: false,
    };
    guard.validate(0)?;
    fs::write(&file, "xyz")?;
    assert!(guard.validate(0).is_err());
    Ok(())
}

#[tokio::test]
async fn review_preserves_staged_renames_and_separates_working_edits() -> Result<()> {
    let dir = tempfile::tempdir()?;
    git(dir.path(), &["init"]).await?;
    // Spaces and brackets must remain literal Git pathspecs.
    let old = "old [draft].txt";
    let new = "new [ready].txt";
    let original = "first line\nsecond line\nthird line\n";
    fs::write(dir.path().join(old), original)?;
    git(dir.path(), &["add", "."]).await?;
    git(
        dir.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "base",
        ],
    )
    .await?;
    git(dir.path(), &["mv", old, new]).await?;
    // The patch must agree with status even when diff disables rename detection.
    git(dir.path(), &["config", "status.renames", "true"]).await?;
    git(dir.path(), &["config", "diff.renames", "false"]).await?;

    let renamed = review::file_review(dir.path(), new, "staged").await?;
    assert_eq!(renamed["old"]["content"], original);
    assert_eq!(renamed["new"]["content"], original);
    let patch = renamed["patch"].as_str().unwrap();
    assert!(patch.contains(&format!("rename from {old}")), "{patch}");
    assert!(patch.contains(&format!("rename to {new}")), "{patch}");
    assert!(!patch.contains("new file mode"), "{patch}");

    let staged = "first line\nsecond line\nstaged line\n";
    fs::write(dir.path().join(new), staged)?;
    git(dir.path(), &["add", "--", new]).await?;
    fs::write(dir.path().join(new), "working edit\n")?;
    let renamed = review::file_review(dir.path(), new, "staged").await?;
    assert_eq!(renamed["old"]["content"], original);
    assert_eq!(renamed["new"]["content"], staged);
    let patch = renamed["patch"].as_str().unwrap();
    assert!(patch.contains("rename from"), "{patch}");
    assert!(patch.contains("-third line"), "{patch}");
    assert!(patch.contains("+staged line"), "{patch}");
    assert!(!patch.contains("working edit"), "{patch}");

    let working = review::file_review(dir.path(), new, "working").await?;
    assert_eq!(working["old"]["content"], staged);
    assert_eq!(working["new"]["content"], "working edit\n");
    let patch = working["patch"].as_str().unwrap();
    assert!(patch.contains("+working edit"), "{patch}");
    assert!(!patch.contains("rename from"), "{patch}");
    Ok(())
}

#[tokio::test]
async fn review_rename_patch_is_relative_to_nested_workspace() -> Result<()> {
    let dir = tempfile::tempdir()?;
    git(dir.path(), &["init"]).await?;
    let work = dir.path().join("project");
    fs::create_dir(&work)?;
    fs::write(work.join("old.txt"), "original\n")?;
    fs::write(dir.path().join("unrelated.txt"), "outside workspace\n")?;
    git(dir.path(), &["add", "."]).await?;
    git(
        dir.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "base",
        ],
    )
    .await?;
    git(&work, &["mv", "old.txt", "new.txt"]).await?;
    fs::write(dir.path().join("unrelated.txt"), "unrelated staged edit\n")?;
    git(dir.path(), &["add", "unrelated.txt"]).await?;
    let renamed = review::file_review(&work, "new.txt", "staged").await?;
    assert_eq!(renamed["old"]["content"], "original\n");
    assert_eq!(renamed["new"]["content"], "original\n");
    let patch = renamed["patch"].as_str().unwrap();
    assert!(patch.contains("rename from project/old.txt"), "{patch}");
    assert!(patch.contains("rename to project/new.txt"), "{patch}");
    assert!(!patch.contains("unrelated"), "{patch}");
    Ok(())
}
