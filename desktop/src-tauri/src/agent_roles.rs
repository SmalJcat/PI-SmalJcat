//! 子代理角色（路线图 P3.2）：把只读探子扩成一条能力阶梯。
//!
//! 每个角色由三件事定义：**工具白名单**、**是否可写**、**是否需要独立 worktree**。
//! 工具名取自 Pi 官方文档（内置工具 read / bash / powershell / edit / write，默认启用 read,bash,edit,write）；
//! 只读角色沿用在用的 read,grep,find,ls 组合。
//!
//! 安全不变量：**可写角色必须在独立 worktree 里跑**，否则拒绝创建任务——
//! 并发写主工作区会与主代理冲突且无法回滚，宁可不支持。

use anyhow::{bail, Result};

/// 一个子代理角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Role {
    pub id: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
    /// 传给 Pi --tools 的白名单。
    pub tools: &'static [&'static str],
    /// 是否能修改文件（edit/write）。
    pub writable: bool,
    /// 是否必须跑在独立 worktree 里。
    pub worktree: bool,
    /// 追加给子代理的系统提示。
    pub prompt: &'static str,
}

const READ_ONLY: &[&str] = &["read", "grep", "find", "ls"];
const READ_AND_RUN: &[&str] = &["read", "grep", "find", "ls", "bash", "powershell"];
const READ_AND_WRITE: &[&str] = &["read", "grep", "find", "ls", "edit", "write"];
const FULL: &[&str] = &[
    "read",
    "grep",
    "find",
    "ls",
    "edit",
    "write",
    "bash",
    "powershell",
];

/// 内置角色，能力从低到高。
pub const ROLES: [Role; 4] = [
    Role {
        id: "scout",
        label: "只读探子",
        summary: "检索与核验，不改文件、不执行命令",
        tools: READ_ONLY,
        writable: false,
        worktree: false,
        prompt: "你只做只读检索与核验：不修改文件，不执行命令。",
    },
    Role {
        id: "verifier",
        label: "验证者",
        summary: "只读 + 跑测试/命令，不修改文件",
        tools: READ_AND_RUN,
        writable: false,
        worktree: false,
        prompt: "你负责独立验证：可以运行命令与测试，但不得修改任何文件；结论要给出实际命令与输出。",
    },
    Role {
        id: "editor",
        label: "编辑者（独立 worktree）",
        summary: "在独立 worktree 里改代码，产出分支待合并",
        tools: READ_AND_WRITE,
        writable: true,
        worktree: true,
        prompt: "你在独立 worktree 中工作：只改这个工作树里的文件，完成最小必要改动，并在结尾说明改了哪些文件、为什么。",
    },
    Role {
        id: "runner",
        label: "执行者（独立 worktree）",
        summary: "在独立 worktree 里改代码并运行命令验证",
        tools: FULL,
        writable: true,
        worktree: true,
        prompt: "你在独立 worktree 中工作：可以改文件并运行命令，改动后自行验证，并在结尾给出改动清单与验证命令。",
    },
];

/// 默认角色：与历史行为一致。
pub const DEFAULT_ROLE: &str = "scout";

/// 按 id 解析角色；未知 id 给出可选清单，而不是静默回退。
pub fn resolve(id: &str) -> Result<&'static Role> {
    let id = id.trim();
    let id = if id.is_empty() { DEFAULT_ROLE } else { id };
    ROLES
        .iter()
        .find(|role| role.id == id)
        .ok_or_else(|| anyhow::anyhow!("未知角色：{id}（可选 {}）", ids().join(" / ")))
}

pub fn ids() -> Vec<&'static str> {
    ROLES.iter().map(|role| role.id).collect()
}

/// 传给 Pi --tools 的值。
pub fn tools_argument(role: &Role) -> String {
    role.tools.join(",")
}

/// 角色是否要求 worktree。
pub fn needs_worktree(role: &Role) -> bool {
    role.worktree
}

/// 可写角色在没有 git 仓库的工作区里直接拒绝：没有 worktree 就无法安全回滚。
pub fn ensure_supported(role: &Role, is_git_repo: bool) -> Result<()> {
    if role.worktree && !is_git_repo {
        bail!(
            "角色「{}」会修改文件，需要 git 仓库才能创建独立 worktree；当前工作区不是 git 仓库",
            role.label
        );
    }
    Ok(())
}

/// 该角色实际运行的工作目录：可写角色必须用 worktree，只读角色用原工作区。
pub fn effective_cwd(role: &Role, workspace: &str, worktree: Option<&str>) -> Result<String> {
    if !role.worktree {
        return Ok(workspace.to_owned());
    }
    match worktree {
        Some(path) if !path.trim().is_empty() => Ok(path.to_owned()),
        _ => bail!(
            "角色「{}」必须在独立 worktree 中运行，但没有可用的 worktree",
            role.label
        ),
    }
}

/// 给界面用的角色目录。
pub fn catalog() -> Vec<serde_json::Value> {
    ROLES
        .iter()
        .map(|role| {
            serde_json::json!({
                "id": role.id,
                "label": role.label,
                "summary": role.summary,
                "tools": role.tools,
                "writable": role.writable,
                "worktree": role.worktree,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_ladder_is_consistent() {
        assert_eq!(ids(), vec!["scout", "verifier", "editor", "runner"]);
        for role in ROLES.iter() {
            assert!(!role.label.is_empty(), "{}", role.id);
            assert!(!role.summary.is_empty(), "{}", role.id);
            assert!(!role.tools.is_empty(), "{}", role.id);
            // 可写角色必须有 edit/write，否则名字会骗人
            if role.writable {
                assert!(
                    role.tools.contains(&"edit") && role.tools.contains(&"write"),
                    "{}",
                    role.id
                );
            } else {
                assert!(
                    !role.tools.contains(&"edit") && !role.tools.contains(&"write"),
                    "{}",
                    role.id
                );
            }
            // 必须 worktree 的正是可写角色
            assert_eq!(role.worktree, role.writable, "{}", role.id);
        }
    }

    #[test]
    fn read_only_roles_keep_the_proven_tool_set() {
        let scout = resolve("scout").unwrap();
        assert_eq!(tools_argument(scout), "read,grep,find,ls");
        let verifier = resolve("verifier").unwrap();
        assert!(verifier.tools.contains(&"bash"));
        assert!(!verifier.writable);
        let runner = resolve("runner").unwrap();
        for tool in ["read", "edit", "write", "bash", "powershell"] {
            assert!(runner.tools.contains(&tool), "runner 缺少 {tool}");
        }
    }

    #[test]
    fn unknown_role_fails_with_the_option_list() {
        let error = resolve("admin").unwrap_err();
        assert!(error.to_string().contains("未知角色"));
        assert!(error.to_string().contains("scout"));
        // 空值回退到默认角色，保持历史行为
        assert_eq!(resolve("").unwrap().id, DEFAULT_ROLE);
        assert_eq!(resolve("  ").unwrap().id, DEFAULT_ROLE);
    }

    #[test]
    fn writable_roles_require_a_git_repository() {
        let editor = resolve("editor").unwrap();
        let error = ensure_supported(editor, false).unwrap_err();
        assert!(error.to_string().contains("需要 git 仓库"));
        assert!(ensure_supported(editor, true).is_ok());
        assert!(ensure_supported(resolve("scout").unwrap(), false).is_ok());
        assert!(!needs_worktree(resolve("scout").unwrap()));
        assert!(needs_worktree(editor));
    }

    #[test]
    fn effective_cwd_never_lets_a_writable_role_touch_the_workspace() {
        let editor = resolve("editor").unwrap();
        assert_eq!(
            effective_cwd(editor, "C:/work", Some("C:/worktrees/t1")).unwrap(),
            "C:/worktrees/t1"
        );
        assert!(effective_cwd(editor, "C:/work", None).is_err());
        assert!(effective_cwd(editor, "C:/work", Some("   ")).is_err());
        let scout = resolve("scout").unwrap();
        assert_eq!(effective_cwd(scout, "C:/work", None).unwrap(), "C:/work");
        assert_eq!(
            effective_cwd(scout, "C:/work", Some("C:/wt")).unwrap(),
            "C:/work"
        );
    }

    #[test]
    fn catalog_exposes_every_field_the_ui_needs() {
        let catalog = catalog();
        assert_eq!(catalog.len(), 4);
        assert!(catalog[0]["tools"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("read")));
        assert_eq!(catalog[0]["writable"], false);
        assert_eq!(catalog[3]["worktree"], true);
    }
}
