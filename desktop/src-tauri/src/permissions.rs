//! Per-desktop Pi tool approval policy and a correlated approval queue.
use crate::{context::atomic_json, rpc::Rpc};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    #[default]
    Ask,
    Smart,
    FullAccess,
    Custom,
}
impl Mode {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "ask" => Ok(Self::Ask),
            "smart" => Ok(Self::Smart),
            "full-access" => Ok(Self::FullAccess),
            "custom" => Ok(Self::Custom),
            _ => bail!("无效权限模式"),
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    pub allow_tools: Vec<String>,
    pub deny_tools: Vec<String>,
    pub allow_workspace_edits: bool,
    pub allow_external_reads: bool,
}
impl Rules {
    pub fn validate(&self) -> Result<()> {
        for patterns in [&self.allow_tools, &self.deny_tools] {
            if patterns.len() > 64 {
                bail!("最多配置 64 项工具规则");
            }
            for pattern in patterns {
                if pattern.is_empty()
                    || pattern.len() > 160
                    || !pattern
                        .trim_end_matches('*')
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_-.:".contains(c))
                    || pattern.matches('*').count() > 1
                    || pattern.contains('*') && !pattern.ends_with('*')
                {
                    bail!("工具规则只支持名称及末尾 * 通配符");
                }
            }
        }
        Ok(())
    }
    pub fn decision(&self, names: &[&str]) -> Option<bool> {
        let matches = |patterns: &[String]| {
            patterns.iter().any(|pattern| {
                names.iter().any(|name| {
                    pattern
                        .strip_suffix('*')
                        .map_or(*name == pattern, |prefix| name.starts_with(prefix))
                })
            })
        };
        if matches(&self.deny_tools) {
            Some(false)
        } else if matches(&self.allow_tools) {
            Some(true)
        } else {
            None
        }
    }
}
#[derive(Clone, Default, Serialize)]
pub struct Policy {
    pub mode: Mode,
    pub rules: Rules,
    #[serde(rename = "protectedPaths")]
    pub protected_paths: Vec<PathBuf>,
}
struct Pending {
    rpc: Arc<Rpc>,
    rpc_id: Value,
    owner: String,
    details: Value,
    created: Instant,
    cwd: PathBuf,
    ticket: String,
}
pub struct Manager {
    pub token: String,
    pub extension_path: PathBuf,
    file: PathBuf,
    policy: Mutex<Policy>,
    error: Mutex<String>,
    pending: Mutex<BTreeMap<String, Pending>>,
    owners: Mutex<HashMap<String, Option<String>>>,
}
impl Manager {
    pub async fn verify(&self, rpc: &Arc<Rpc>, entry: &Path) -> Result<()> {
        let commands = rpc.call("get_commands", json!({})).await?;
        let expected = crate::session_guard::key(entry)?;
        if !commands["commands"].as_array().is_some_and(|commands| {
            commands.iter().any(|command| {
                command["name"] == "desktop-permissions"
                    && command["sourceInfo"]["path"].as_str().is_some_and(|path| {
                        crate::session_guard::key(Path::new(path)).ok().as_ref() == Some(&expected)
                    })
            })
        }) {
            bail!("桌面工具权限扩展未加载，已停止连接；未发送模型请求");
        }
        Ok(())
    }
    pub fn new(root: PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&root)?;
        let file = root.join("permissions.json");
        let loaded = load_rules(&file);
        let error = loaded
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default();
        let policy = Policy {
            mode: Mode::Ask,
            rules: loaded.unwrap_or_default(),
            protected_paths: vec![root.clone()],
        };
        let extension_path = root.join("desktop-permissions.mjs");
        std::fs::write(
            &extension_path,
            include_str!("../../extensions/desktop-permissions.mjs"),
        )?;
        Ok(Arc::new(Self {
            token: Uuid::new_v4().to_string(),
            extension_path,
            file,
            policy: Mutex::new(policy),
            error: Mutex::new(error),
            pending: Mutex::new(BTreeMap::new()),
            owners: Mutex::new(HashMap::new()),
        }))
    }
    pub fn status(&self) -> Value {
        self.pending
            .lock()
            .unwrap()
            .retain(|_, request| request.rpc.accepting_input());
        let policy = self.policy.lock().unwrap().clone();
        let pending = self.pending.lock().unwrap();
        let mut pending = pending.iter().collect::<Vec<_>>();
        pending.sort_by_key(|(_, p)| p.created);
        json!({"mode":policy.mode,"rules":policy.rules,"configFile":self.file,"configError":*self.error.lock().unwrap(),"requests":pending.iter().map(|(id,p)|json!({"id":id,"owner":p.owner,"cwd":p.cwd,"tool":p.details["tool"],"input":p.details["input"]})).collect::<Vec<_>>()})
    }
    pub fn set(&self, mode: Mode, rules: Option<Rules>) -> Result<Value> {
        self.pending
            .lock()
            .unwrap()
            .retain(|_, request| request.rpc.accepting_input());
        if !self.pending.lock().unwrap().is_empty() {
            bail!("请先处理当前授权请求");
        }
        let mut next = self.policy.lock().unwrap().clone();
        if let Some(rules) = rules {
            rules.validate()?;
            atomic_json(&self.file, &json!(rules))?;
            next.rules = rules;
            self.error.lock().unwrap().clear();
        }
        if mode == Mode::Custom && !self.error.lock().unwrap().is_empty() {
            bail!("自定义权限配置无效，请先保存有效规则");
        }
        next.mode = mode;
        *self.policy.lock().unwrap() = next;
        Ok(self.status())
    }
    pub fn protect(&self, path: &Path) -> Result<()> {
        let mut policy = self.policy.lock().unwrap();
        let path = dunce::canonicalize(path)?;
        if !policy.protected_paths.contains(&path) {
            policy.protected_paths.push(path);
        }
        Ok(())
    }
    pub fn environment(&self) -> Vec<(String, String)> {
        vec![("PI_DESKTOP_PERMISSION_TOKEN".into(), self.token.clone())]
    }
    pub async fn answer_query(&self, rpc: &Rpc, event: &Value) {
        let valid = event["placeholder"]
            .as_str()
            .filter(|raw| raw.len() < 4096)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .is_some_and(|value| value["token"] == self.token);
        let policy = self.policy.lock().unwrap().clone();
        let response = if valid {
            json!({"type":"extension_ui_response","id":event["id"],"value":json!({"mode":policy.mode,"rules":policy.rules}).to_string()})
        } else {
            json!({"type":"extension_ui_response","id":event["id"],"cancelled":true})
        };
        let _ = tokio::time::timeout(Duration::from_secs(3), rpc.write(response)).await;
    }
    pub fn ticket(&self, owner: &str) -> Option<String> {
        self.owners
            .lock()
            .unwrap()
            .entry(owner.into())
            .or_insert_with(|| Some(Uuid::new_v4().to_string()))
            .clone()
    }
    pub fn begin_owner(&self, owner: &str) {
        let mut owners = self.owners.lock().unwrap();
        owners.insert(owner.into(), Some(Uuid::new_v4().to_string()));
        let requests = self.remove_owner(owner);
        drop(owners);
        if !requests.is_empty() {
            tokio::spawn(async move {
                Self::cancel_requests(requests).await;
            });
        }
    }
    pub fn enqueue(
        self: &Arc<Self>,
        rpc: Arc<Rpc>,
        owner: &str,
        cwd: &Path,
        event: &Value,
        ticket: Option<String>,
    ) {
        let payload = event["placeholder"]
            .as_str()
            .filter(|s| s.len() <= 1_048_576)
            .and_then(|s| serde_json::from_str::<Value>(s).ok());
        let valid = payload.as_ref().is_some_and(|p| {
            p["token"] == self.token
                && p["tool"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 160)
        });
        let owners = self.owners.lock().unwrap();
        let current = owners.get(owner).and_then(Clone::clone);
        if !valid
            || !rpc.accepting_input()
            || ticket.is_none()
            || current != ticket
            || self.pending.lock().unwrap().len() >= 64
        {
            drop(owners);
            let id = event["id"].clone();
            tokio::spawn(async move {
                let _ = rpc
                    .write(json!({"type":"extension_ui_response","id":id,"cancelled":true}))
                    .await;
            });
            return;
        }
        let payload = payload.unwrap();
        let decision = decide_pi(
            &self.policy.lock().unwrap(),
            payload["tool"].as_str().unwrap(),
            &payload["input"],
            cwd,
        );
        if let Some(allow) = decision {
            drop(owners);
            let manager = self.clone();
            let owner = owner.to_owned();
            let rpc_id = event["id"].clone();
            tokio::spawn(async move {
                let record = json!({"type":"extension_ui_response","id":rpc_id,"value":if allow{"allow"}else{"deny"}});
                let result = tokio::time::timeout(
                    Duration::from_secs(3),
                    rpc.write_guarded(record, || manager.ticket(&owner) == ticket),
                )
                .await;
                if matches!(result, Ok(Ok(false))) {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(3),
                        rpc.write(
                            json!({"type":"extension_ui_response","id":rpc_id,"cancelled":true}),
                        ),
                    )
                    .await;
                } else if !matches!(result, Ok(Ok(true))) {
                    rpc.stop().await;
                }
            });
            return;
        }
        let id = Uuid::new_v4().to_string();
        self.pending.lock().unwrap().insert(
            id.clone(),
            Pending {
                rpc,
                rpc_id: event["id"].clone(),
                owner: owner.into(),
                details: payload,
                created: Instant::now(),
                cwd: cwd.into(),
                ticket: ticket.unwrap(),
            },
        );
        drop(owners);
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(300)).await;
            if let Some(manager) = weak.upgrade() {
                let _ = manager.reply(&id, false).await;
            }
        });
    }
    pub async fn reply(&self, id: &str, allow: bool) -> Result<Value> {
        let request = self
            .pending
            .lock()
            .unwrap()
            .remove(id)
            .context("授权请求已结束")?;
        if !request.rpc.accepting_input() {
            bail!("授权请求已过期");
        }
        if self.ticket(&request.owner).as_deref() != Some(request.ticket.as_str()) {
            Self::cancel_requests(vec![request]).await;
            bail!("授权请求已取消");
        }
        let expired = request.created.elapsed() >= Duration::from_secs(300);
        let result=tokio::time::timeout(Duration::from_secs(3),request.rpc.write_guarded(json!({"type":"extension_ui_response","id":request.rpc_id,"value":if allow && !expired {"allow"}else{"deny"}}),||self.ticket(&request.owner).as_deref()==Some(request.ticket.as_str()) && (!allow || request.created.elapsed()<Duration::from_secs(300)))).await;
        if matches!(result, Ok(Ok(false))) {
            Self::cancel_requests(vec![request]).await;
            bail!("授权请求已取消");
        }
        if !matches!(result, Ok(Ok(true))) {
            request.rpc.stop().await;
            bail!("授权响应未能送达，已断开该 Pi 进程");
        }
        if allow && expired {
            bail!("授权请求已过期");
        }
        Ok(self.status())
    }
    fn remove_owner(&self, owner: &str) -> Vec<Pending> {
        let mut pending = self.pending.lock().unwrap();
        let ids = pending
            .iter()
            .filter(|(_, p)| p.owner == owner)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| pending.remove(&id))
            .collect::<Vec<_>>()
    }
    pub fn cancel_owner_now(&self, owner: &str) {
        let mut owners = self.owners.lock().unwrap();
        owners.insert(owner.into(), None);
        let requests = self.remove_owner(owner);
        drop(owners);
        tokio::spawn(async move {
            Self::cancel_requests(requests).await;
        });
    }
    pub async fn cancel_owner(&self, owner: &str) {
        let requests = {
            let mut owners = self.owners.lock().unwrap();
            owners.insert(owner.into(), None);
            self.remove_owner(owner)
        };
        Self::cancel_requests(requests).await;
    }
    async fn cancel_requests(requests: Vec<Pending>) {
        for request in requests {
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                request.rpc.write(
                    json!({"type":"extension_ui_response","id":request.rpc_id,"cancelled":true}),
                ),
            )
            .await;
            if !matches!(result, Ok(Ok(()))) {
                request.rpc.stop().await;
            }
        }
    }
}
/// A host-side decision, never a value supplied by the agent or a live JSON file.
pub fn decide_pi(policy: &Policy, tool: &str, input: &Value, cwd: &Path) -> Option<bool> {
    if policy.mode == Mode::FullAccess {
        return Some(true);
    }
    let custom = if policy.mode == Mode::Custom {
        policy.rules.decision(&[tool])
    } else {
        None
    };
    if custom == Some(false) {
        return custom;
    }
    let reading = matches!(tool, "read" | "grep" | "find" | "ls");
    let writing = matches!(tool, "write" | "edit");
    let target = input["path"]
        .as_str()
        .or(if reading { Some(".") } else { None });
    let absolute = target.map(|target| {
        let path = Path::new(target);
        if path.is_absolute() {
            path.to_owned()
        } else {
            cwd.join(path)
        }
    });
    let protected = writing
        && (target.is_some_and(|path| {
            path.split(['/', '\\']).any(|part| {
                matches!(
                    part.to_ascii_lowercase().as_str(),
                    ".git" | ".pi" | ".codex"
                )
            })
        }) || absolute.as_ref().is_some_and(|target| {
            policy
                .protected_paths
                .iter()
                .any(|root| within(root, &target.to_string_lossy()))
        }));
    if protected {
        return None;
    }
    if custom.is_some() {
        return custom;
    }
    if reading && policy.mode == Mode::Custom && policy.rules.allow_external_reads {
        return Some(true);
    }
    let local = target.is_some_and(|target| within(cwd, target));
    if reading && local
        || writing
            && local
            && (policy.mode == Mode::Smart
                || policy.mode == Mode::Custom && policy.rules.allow_workspace_edits)
    {
        Some(true)
    } else {
        None
    }
}
pub fn load_rules(file: &Path) -> Result<Rules> {
    if !file.exists() {
        return Ok(Rules::default());
    }
    if std::fs::metadata(file)?.len() > 64 * 1024 {
        bail!("权限配置超过 64 KB");
    }
    let rules: Rules =
        serde_json::from_slice(&std::fs::read(file)?).context("权限配置 JSON 无效")?;
    rules.validate()?;
    Ok(rules)
}
pub fn within(cwd: &Path, target: &str) -> bool {
    if target.starts_with(['~', '@']) || target.contains("://") || target.contains(['%', '$', '\0'])
    {
        return false;
    }
    let Ok(root) = dunce::canonicalize(cwd) else {
        return false;
    };
    let candidate = Path::new(target);
    if !candidate.is_absolute()
        && candidate
            .components()
            .any(|c| matches!(c, std::path::Component::Prefix(_)))
    {
        return false;
    }
    let mut candidate = if candidate.is_absolute() {
        candidate.to_owned()
    } else {
        root.join(candidate)
    };
    let mut lexical = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::ParentDir => {
                lexical.pop();
            }
            std::path::Component::CurDir => {}
            _ => lexical.push(component),
        }
    }
    let in_scope = if cfg!(windows) {
        PathBuf::from(lexical.to_string_lossy().to_lowercase())
            .starts_with(PathBuf::from(root.to_string_lossy().to_lowercase()))
    } else {
        lexical.starts_with(&root)
    };
    if !in_scope {
        return false;
    }
    let mut tail = Vec::new();
    while !candidate.exists() {
        let Some(name) = candidate.file_name().map(|n| n.to_owned()) else {
            return false;
        };
        tail.push(name);
        if !candidate.pop() {
            return false;
        }
    }
    let Ok(mut actual) = dunce::canonicalize(candidate) else {
        return false;
    };
    for name in tail.into_iter().rev() {
        actual.push(name);
    }
    // A .. component must be resolved before the containment check.
    let mut normalized = PathBuf::new();
    for component in actual.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            _ => normalized.push(component),
        }
    }
    normalized.starts_with(root)
}
