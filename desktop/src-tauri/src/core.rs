use crate::{
    rpc::{EventSink, Rpc},
    session_guard::{self, SessionGuard},
    workspace,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, RwLock as AsyncRwLock};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub executable: String,
    pub last_workspace: String,
    pub recent_workspaces: Vec<String>,
    /// 系统集成开关：需要在后端启动时读取，因此与其它偏好一起落地。
    pub launch_at_login: bool,
    pub close_to_tray: bool,
    pub notifications: bool,
    /// 归档任务的保留天数：0 表示永久保留（默认）。
    pub archived_retention_days: i64,
}
#[derive(Clone)]
pub struct Active {
    pub rpc: Arc<Rpc>,
    pub cwd: PathBuf,
    pub generation: u64,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectOptions {
    pub cwd: Option<String>,
    pub session_path: Option<String>,
    pub trust: bool,
    pub fork: bool,
}
pub struct Core {
    preferences: AsyncMutex<Preferences>,
    pub preference_path: PathBuf,
    pub agent_dir: PathBuf,
    active: AsyncRwLock<Option<Active>>,
    operation: AsyncMutex<()>,
    pub connecting: AtomicBool,
    pub closing: AtomicBool,
    generation: AtomicU64,
    sink: RwLock<Option<EventSink>>,
    dialogs: Mutex<HashMap<String, (u64, Value)>>,
    index: Arc<Mutex<workspace::SessionIndex>>,
    guard: Mutex<Option<SessionGuard>>,
    recovery: Mutex<Value>,
    mcp_query: AtomicBool,
    pub agents: Arc<crate::agents::Manager>,
    context_history: crate::context::History,
    context_settings: Mutex<Option<Value>>,
    context_usage_cache: Mutex<Option<Value>>,
    bridge_token: String,
    bridge_path: PathBuf,
    task_actions: AsyncMutex<()>,
    delegations: Mutex<HashSet<String>>,
}
struct ConnectingGuard<'a>(&'a AtomicBool);
impl Drop for ConnectingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Core {
    pub fn new(data_dir: &Path) -> Result<Arc<Self>> {
        let preference_path = data_dir.join("preferences.json");
        let mut preferences: Preferences =
            serde_json::from_value(workspace::read_json(&preference_path)?)?;
        // Read the prior Electron preferences once; never mutate the old profile.
        if !preference_path.exists() && std::env::var_os("PI_DESKTOP_USER_DATA").is_none() {
            if let Some(roaming) = dirs::config_dir() {
                let legacy = roaming.join("pi-desktop/preferences.json");
                if let Ok(value) = workspace::read_json(&legacy) {
                    if let Ok(old) = serde_json::from_value(value) {
                        preferences = old;
                    }
                }
            }
        }
        if preferences.executable.is_empty() {
            preferences.executable = find_executable()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
        }
        if preferences.last_workspace.is_empty() {
            preferences.last_workspace =
                std::env::var("PI_DESKTOP_WORKSPACE").unwrap_or_else(|_| {
                    Path::new(&preferences.executable)
                        .parent()
                        .filter(|p| !p.as_os_str().is_empty())
                        .map(Path::to_path_buf)
                        .unwrap_or_else(workspace::home)
                        .to_string_lossy()
                        .into_owned()
                });
        }
        fs::create_dir_all(data_dir)?;
        let recovery = workspace::read_json(&data_dir.join("recovery.json"))?;
        let bridge_path = data_dir.join("desktop-context.mjs");
        fs::write(
            &bridge_path,
            include_str!("../../extensions/desktop-context.mjs"),
        )?;
        fs::write(
            data_dir.join("desktop-permissions.mjs"),
            include_str!("../../extensions/desktop-permissions.mjs"),
        )?;
        let agents = crate::agents::Manager::new(
            data_dir.join("agents"),
            workspace::agent_dir().join("desktop-session-locks"),
        )?;
        let context_history = crate::context::History::new(data_dir.join("context-attempts.json"))?;
        agents.permissions.protect(data_dir)?;
        let agent_dir = workspace::agent_dir();
        fs::create_dir_all(&agent_dir)?;
        agents.permissions.protect(&agent_dir)?;
        Ok(Arc::new(Self {
            preferences: AsyncMutex::new(preferences),
            preference_path,
            agent_dir: workspace::agent_dir(),
            active: AsyncRwLock::new(None),
            operation: AsyncMutex::new(()),
            connecting: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            sink: RwLock::new(None),
            dialogs: Mutex::new(HashMap::new()),
            index: Arc::new(Mutex::new(workspace::SessionIndex::default())),
            guard: Mutex::new(None),
            recovery: Mutex::new(recovery),
            mcp_query: AtomicBool::new(false),
            agents,
            context_history,
            context_settings: Mutex::new(None),
            context_usage_cache: Mutex::new(None),
            bridge_token: uuid::Uuid::new_v4().to_string(),
            bridge_path,
            task_actions: AsyncMutex::new(()),
            delegations: Mutex::new(HashSet::new()),
        }))
    }
    pub fn subscribe(&self, sink: EventSink) {
        *self.sink.write().unwrap() = Some(sink);
    }
    fn emit(&self, generation: u64, event: Value) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        if let Some(sink) = self.sink.read().unwrap().as_ref() {
            sink(json!({"generation":generation,"event":event}));
        }
    }
    pub async fn bootstrap(&self) -> Value {
        let recovery = self.recovery.lock().unwrap().clone();
        let recovery = if recovery["sessionPath"]
            .as_str()
            .is_some_and(|p| Path::new(p).is_file())
        {
            recovery
        } else {
            Value::Null
        };
        json!({"preferences":*self.preferences.lock().await,"agentDir":self.agent_dir,"version":env!("CARGO_PKG_VERSION"),"runtime":"tauri","recovery":recovery})
    }
    /// 更新归档保留期（天）。只接受固定档位，非法值直接拒绝而不是悄悄取默认。
    pub async fn set_retention(&self, days: i64) -> Result<Preferences> {
        if !crate::retention::is_valid_retention(days) {
            anyhow::bail!("保留期只支持 0 / 90 / 180 / 365 天");
        }
        let mut next = self.preferences().await;
        next.archived_retention_days = days;
        self.save_preferences(next.clone()).await?;
        Ok(next)
    }

    /// 更新系统集成开关，其余偏好保持不变。
    pub async fn set_system_preferences(
        &self,
        launch_at_login: Option<bool>,
        close_to_tray: Option<bool>,
        notifications: Option<bool>,
    ) -> Result<Preferences> {
        let mut next = self.preferences().await;
        if let Some(value) = launch_at_login {
            next.launch_at_login = value;
        }
        if let Some(value) = close_to_tray {
            next.close_to_tray = value;
        }
        if let Some(value) = notifications {
            next.notifications = value;
        }
        self.save_preferences(next.clone()).await?;
        Ok(next)
    }
    pub async fn preferences(&self) -> Preferences {
        self.preferences.lock().await.clone()
    }
    async fn save_preferences(&self, next: Preferences) -> Result<()> {
        let mut prefs = self.preferences.lock().await;
        let bytes = serde_json::to_vec_pretty(&next)?;
        let temp = self.preference_path.with_extension("json.tmp");
        tokio::fs::write(&temp, bytes).await?;
        tokio::fs::rename(&temp, &self.preference_path).await?;
        *prefs = next;
        Ok(())
    }
    pub async fn set_executable(&self, file: &Path) -> Result<Value> {
        let _gate = self.operation.try_lock().context("请等待当前操作完成")?;
        if self.busy().await {
            bail!("请先停止当前任务。");
        }
        let path = workspace::canonical(file)?;
        if !path.is_file()
            || (cfg!(windows)
                && path
                    .extension()
                    .is_none_or(|ext| !ext.eq_ignore_ascii_case("exe")))
        {
            bail!("请选择 Pi 可执行文件。");
        }
        let mut next = self.preferences().await;
        next.executable = path.to_string_lossy().into_owned();
        self.save_preferences(next.clone()).await?;
        Ok(serde_json::to_value(next)?)
    }
    pub async fn current(&self) -> Result<Active> {
        let active = self
            .active
            .read()
            .await
            .clone()
            .context("Pi 未连接，请重新连接。")?;
        if active.rpc.closed.load(Ordering::SeqCst) {
            bail!("Pi 未连接，请重新连接。");
        }
        Ok(active)
    }
    pub async fn cwd(&self) -> PathBuf {
        self.active
            .read()
            .await
            .as_ref()
            .map(|a| a.cwd.clone())
            .unwrap_or_default()
    }
    pub fn operation_pending(&self) -> bool {
        self.operation.try_lock().is_err()
    }
    pub async fn busy(&self) -> bool {
        self.connecting.load(Ordering::SeqCst)
            || self
                .active
                .read()
                .await
                .as_ref()
                .is_some_and(|a| a.rpc.busy.load(Ordering::SeqCst))
    }
    pub async fn connect(self: &Arc<Self>, options: ConnectOptions) -> Result<Value> {
        let _gate = self.operation.try_lock().context("请等待当前操作完成")?;
        if self.busy().await || self.closing.load(Ordering::SeqCst) {
            bail!("请先停止当前任务，再切换会话或工作区。");
        }
        self.connecting.store(true, Ordering::SeqCst);
        let _connecting = ConnectingGuard(&self.connecting);
        let preferences = self.preferences().await;
        let target = if let Some(file) = &options.session_path {
            let file = file.clone();
            let metadata =
                tokio::task::spawn_blocking(move || workspace::session_metadata(Path::new(&file)))
                    .await??;
            PathBuf::from(metadata["cwd"].as_str().context("会话缺少工作区")?)
        } else {
            PathBuf::from(
                options
                    .cwd
                    .as_deref()
                    .unwrap_or(&preferences.last_workspace),
            )
        };
        let target = workspace::canonical(&target)?;
        if !target.is_dir() {
            bail!("工作区不存在或不是文件夹。");
        }
        let (executable, prefix) = executable_for_connection(&preferences);
        if prefix.is_empty() && !executable.is_file() {
            bail!("请在设置中选择本机 pi.exe。");
        }
        if let Some(file) = &options.session_path {
            if !options.fork {
                let access = self.session_access(file).await?;
                if access["available"] != true {
                    bail!(
                        "SESSION_BUSY: {}",
                        access["reason"].as_str().unwrap_or("会话已占用")
                    );
                }
            }
        }
        // Validate destination before stopping the prior connection.
        {
            let _tasks = self.task_actions.lock().await;
            for owner in self.delegations.lock().unwrap().drain() {
                self.agents.cancel_owner(&owner, true);
            }
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(previous) = self.active.write().await.take() {
            previous.rpc.stop().await;
        }
        self.guard.lock().unwrap().take();
        let pending_lease = if !options.fork {
            options
                .session_path
                .as_ref()
                .map(|file| session_guard::acquire(&self.lease_root(), Path::new(file)))
                .transpose()?
        } else {
            None
        };
        self.dialogs.lock().unwrap().clear();
        let mut args = Vec::new();
        if let Some(file) = options.session_path {
            args.extend([
                if options.fork { "--fork" } else { "--session" }.into(),
                file,
            ]);
        }
        if options.trust {
            args.push("--approve".into());
        }
        args.extend(["-e".into(), self.bridge_path.to_string_lossy().into_owned(), "--append-system-prompt".into(), "派发只读探索和独立核验时，优先使用 desktop_scout 工具和 default 探子。主代理负责修改代码、方案取舍和最终验证。".into()]);
        let weak = Arc::downgrade(self);
        let sink: EventSink = Arc::new(move |event| {
            if let Some(core) = weak.upgrade() {
                core.handle_event(generation, event);
            }
        });
        let rpc = Rpc::spawn(&executable, &target, &prefix, &args, sink, &{
            let mut environment = self.agents.permissions.environment();
            environment.push(("PI_DESKTOP_BRIDGE_TOKEN".into(), self.bridge_token.clone()));
            environment
        })
        .await?;
        let active = Active {
            rpc: rpc.clone(),
            cwd: target.clone(),
            generation,
        };
        *self.active.write().await = Some(active.clone());
        let result = async {
            self.agents
                .permissions
                .verify(&rpc, &self.bridge_path)
                .await?;
            self.snapshot_active(&active).await
        }
        .await;
        match result {
            Ok(value) => {
                if let Some(file) = value["state"]["sessionFile"].as_str() {
                    let lease = match pending_lease {
                        Some(lease) => Ok(lease),
                        None => session_guard::acquire(&self.lease_root(), Path::new(file)),
                    };
                    let lease = match lease {
                        Ok(lease) => lease,
                        Err(error) => {
                            rpc.stop().await;
                            *self.active.write().await = None;
                            return Err(error);
                        }
                    };
                    *self.guard.lock().unwrap() = Some(SessionGuard {
                        path: PathBuf::from(file),
                        lease,
                        baseline: session_guard::stamp(Path::new(file))?,
                        known_processes: session_guard::pi_processes()?,
                        expecting_write: false,
                    });
                    self.save_recovery(
                        json!({"sessionPath":file,"cwd":target,"interrupted":false}),
                    );
                }
                let mut next = preferences;
                next.last_workspace = target.to_string_lossy().into_owned();
                next.recent_workspaces
                    .retain(|p| !p.eq_ignore_ascii_case(&next.last_workspace));
                next.recent_workspaces
                    .insert(0, next.last_workspace.clone());
                next.recent_workspaces.truncate(12);
                if let Err(error) = self.save_preferences(next).await {
                    self.emit(generation, json!({"type":"transport_warning","message":format!("偏好未能保存：{error}")}));
                }
                *self.context_settings.lock().unwrap() = None;
                if let Ok(settings) = self.query_context_settings(&active, "get").await {
                    *self.context_settings.lock().unwrap() = Some(settings);
                }
                Ok(value)
            }
            Err(error) => {
                rpc.stop().await;
                *self.active.write().await = None;
                Err(error)
            }
        }
    }
    fn handle_event(self: &Arc<Self>, generation: u64, event: Value) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        if matches!(
            event["type"].as_str(),
            Some("compaction_start" | "compaction_end")
        ) {
            *self.context_usage_cache.lock().unwrap() = None;
        }
        if event["type"] == "extension_ui_request" && event["method"] == "notify" {
            if let Some(raw) = event["message"]
                .as_str()
                .and_then(|s| s.strip_prefix("PI_DESKTOP_USAGE:"))
            {
                if raw.len() < 65536 {
                    if let Ok(mut usage) = serde_json::from_str::<Value>(raw) {
                        if !usage.is_object() {
                            return;
                        }
                        usage["generation"] = json!(generation);
                        *self.context_usage_cache.lock().unwrap() = Some(usage.clone());
                        self.emit(generation, json!({"type":"context_usage","data":usage}));
                    }
                }
                return;
            }
        }
        if event["type"] == "extension_ui_request"
            && event["method"] == "input"
            && event["title"] == "PI_DESKTOP_PERMISSION_QUERY"
        {
            let core = self.clone();
            tokio::spawn(async move {
                if let Ok(active) = core.current().await {
                    if active.generation == generation {
                        core.agents
                            .permissions
                            .answer_query(&active.rpc, &event)
                            .await;
                    }
                }
            });
            return;
        }
        if event["type"] == "extension_ui_request"
            && event["method"] == "input"
            && event["title"] == "PI_DESKTOP_PERMISSION"
        {
            let core = self.clone();
            let ticket = self.agents.permissions.ticket("Pi");
            tokio::spawn(async move {
                if let Ok(active) = core.current().await {
                    if active.generation == generation {
                        core.agents.permissions.enqueue(
                            active.rpc,
                            "Pi",
                            &active.cwd,
                            &event,
                            ticket,
                        );
                    }
                }
            });
            return;
        }
        if event["type"] == "tool_execution_start" && event["toolName"] == "desktop_scout" {
            if let Some(id) = event["toolCallId"].as_str() {
                self.delegations.lock().unwrap().insert(id.into());
            }
        }
        let owners =
            if event["type"] == "tool_execution_end" && event["toolName"] == "desktop_scout" {
                event["toolCallId"]
                    .as_str()
                    .and_then(|id| self.delegations.lock().unwrap().take(id))
                    .into_iter()
                    .collect::<Vec<_>>()
            } else if event["type"] == "transport_exit"
                || event["type"] == "agent_settled" && event["aborted"] == true
            {
                self.delegations.lock().unwrap().drain().collect()
            } else {
                Vec::new()
            };
        if !owners.is_empty() {
            let core = self.clone();
            let interrupted = event["type"] == "transport_exit";
            tokio::spawn(async move {
                let _gate = core.task_actions.lock().await;
                for owner in owners {
                    core.agents.cancel_owner(&owner, interrupted);
                }
            });
        }
        if event["type"] == "extension_ui_request"
            && event["method"] == "input"
            && event["title"] == "PI_DESKTOP_AGENT_RPC"
        {
            if let Ok(mut request) =
                serde_json::from_str::<Value>(event["placeholder"].as_str().unwrap_or_default())
            {
                if request["token"] == self.bridge_token {
                    request.as_object_mut().unwrap().remove("token");
                    let core = self.clone();
                    let id = event["id"].clone();
                    tokio::spawn(async move {
                        if let Ok(active) = core.current().await {
                            if active.generation != generation {
                                return;
                            }
                            let response = match core.agent_action(request).await {
                                Ok(data) => json!({"ok":true,"data":data}),
                                Err(error) => json!({"ok":false,"error":format!("{error:#}")}),
                            };
                            let _=active.rpc.write(json!({"type":"extension_ui_response","id":id,"value":response.to_string()})).await;
                        }
                    });
                    return;
                }
            }
        }
        if event["type"] == "extension_ui_request"
            && event["method"] == "notify"
            && event["message"]
                .as_str()
                .is_some_and(|text| text.starts_with("PI_DESKTOP_CONTEXT:"))
        {
            return;
        }
        if let Some(path) = self
            .guard
            .lock()
            .unwrap()
            .as_ref()
            .map(|guard| guard.path.to_string_lossy().into_owned())
        {
            self.context_history.event(&path, &event);
        }
        if event["type"] == "agent_start" {
            self.update_recovery(true);
        }
        if event["type"] == "agent_settled" {
            self.update_recovery(false);
        }
        if event["type"] == "transport_exit" {
            self.guard.lock().unwrap().take();
        }
        if self.mcp_query.load(Ordering::SeqCst)
            && event["type"] == "extension_ui_request"
            && event["method"] == "notify"
        {
            return;
        }
        if event["type"] == "extension_ui_request"
            && matches!(
                event["method"].as_str(),
                Some("select" | "confirm" | "input" | "editor")
            )
        {
            if let Some(id) = event["id"].as_str() {
                self.dialogs
                    .lock()
                    .unwrap()
                    .insert(id.into(), (generation, event.clone()));
                if let Some(ms) = event["timeout"].as_u64() {
                    let weak = Arc::downgrade(self);
                    let id = id.to_owned();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(ms.min(24 * 60 * 60 * 1000)))
                            .await;
                        if let Some(core) = weak.upgrade() {
                            let removed = {
                                let mut dialogs = core.dialogs.lock().unwrap();
                                if dialogs.get(&id).is_some_and(|(g, _)| *g == generation) {
                                    dialogs.remove(&id);
                                    true
                                } else {
                                    false
                                }
                            };
                            if removed {
                                core.emit(generation, json!({"type":"dialog_expired","id":id}));
                            }
                        }
                    });
                }
            }
        }
        self.emit(generation, event);
    }
    async fn snapshot_active(&self, active: &Active) -> Result<Value> {
        let rpc = &active.rpc;
        let (state, history, models, levels, commands, stats) = tokio::try_join!(
            rpc.call("get_state", json!({})),
            rpc.call("get_entries", json!({})),
            rpc.call("get_available_models", json!({})),
            rpc.call("get_available_thinking_levels", json!({})),
            rpc.call("get_commands", json!({})),
            rpc.call("get_session_stats", json!({}))
        )?;
        if let Some(guard) = self.guard.lock().unwrap().as_mut() {
            if guard.expecting_write
                && state["isStreaming"] != true
                && state["isCompacting"] != true
            {
                guard.baseline = session_guard::stamp(&guard.path)?;
                guard.expecting_write = false;
            }
        }
        let mut state = state;
        state["model"] = public_model(&state["model"]);
        let model_list = models["models"]
            .as_array()
            .context("Pi 返回无效模型列表")?
            .iter()
            .map(public_model)
            .collect::<Vec<_>>();
        let entries = history["entries"]
            .as_array()
            .context("Pi 返回无效会话历史")?;
        Ok(
            json!({"generation":active.generation,"cwd":active.cwd,"state":state,"messages":workspace::branch_messages(entries, history["leafId"].as_str()),"models":model_list,"levels":levels["levels"],"commands":commands["commands"],"stats":stats}),
        )
    }
    pub async fn snapshot(&self) -> Result<Value> {
        let _gate = self.operation.lock().await;
        self.snapshot_active(&self.current().await?).await
    }
    pub async fn prepare_message_edit(&self, session_id: &str, entry_id: &str) -> Result<Value> {
        let _operation = self.operation.try_lock().context("上一个操作仍在处理中")?;
        let active = self.current().await?;
        let state = active.rpc.call("get_state", json!({})).await?;
        if state["sessionId"] != session_id {
            bail!("会话已切换，请重新选择要编辑的消息");
        }
        if active.rpc.busy.load(Ordering::SeqCst)
            || state["isStreaming"] == true
            || state["isCompacting"] == true
            || state["pendingMessageCount"].as_u64().unwrap_or_default() > 0
        {
            bail!("请先停止当前任务再编辑消息");
        }
        {
            let _launch = self.agents.launch_lock.lock().await;
            let guard = self.guard.lock().unwrap();
            guard
                .as_ref()
                .context("当前会话未保存，无法编辑历史消息")?
                .validate_with_managed(active.rpc.pid, &self.agents.pids())?;
        }
        let candidates = active.rpc.call("get_fork_messages", json!({})).await?;
        if !candidates["messages"].as_array().is_some_and(|messages| {
            messages
                .iter()
                .any(|message| message["entryId"] == entry_id)
        }) {
            // A previous preparation may have persisted before its response was lost.
            // Only the latest non-metadata entry on the active branch authorizes a retry.
            let history = active.rpc.call("get_entries", json!({})).await?;
            let prepared = history["entries"].as_array().is_some_and(|entries| {
                let by_id: HashMap<_, _> = entries
                    .iter()
                    .filter_map(|entry| entry["id"].as_str().map(|id| (id, entry)))
                    .collect();
                let mut current = history["leafId"].as_str();
                let mut seen = HashSet::new();
                while let Some(id) = current {
                    if !seen.insert(id) {
                        break;
                    }
                    let Some(entry) = by_id.get(id) else {
                        break;
                    };
                    if !["model_change", "thinking_level_change", "session_info"]
                        .contains(&entry["type"].as_str().unwrap_or_default())
                    {
                        return entry["type"] == "custom"
                            && entry["customType"] == "desktop-message-edit"
                            && entry["data"]["entryId"] == entry_id;
                    }
                    current = entry["parentId"].as_str();
                }
                false
            });
            if !prepared {
                bail!("该消息已不在当前会话分支中，请刷新后重新选择");
            }
        }
        self.verify_context_bridge(&active).await?;
        let result = async {
            let nonce = uuid::Uuid::new_v4().to_string();
            let prefix = format!("PI_DESKTOP_CONTEXT:{nonce}:");
            let cursor = active.rpc.notification_cursor();
            let payload = json!({"sessionId":session_id,"entryId":entry_id});
            active
                .rpc
                .call(
                    "prompt",
                    json!({"message":format!("/desktop-context edit {nonce} {payload}")}),
                )
                .await?;
            let response = active
                .rpc
                .notifications_after(cursor)
                .iter()
                .filter_map(|event| event["message"].as_str())
                .find_map(|text| text.strip_prefix(&prefix))
                .map(str::to_owned)
                .context("Pi 未返回消息编辑结果")?;
            let edited: Value = serde_json::from_str(&response)?;
            if edited["ok"] != true {
                bail!("{}", edited["error"].as_str().unwrap_or("无法准备消息编辑"));
            }
            if edited["cancelled"] == true {
                return Ok(json!({"cancelled":true}));
            }
            *self.context_usage_cache.lock().unwrap() = None;
            let snapshot = self.snapshot_active(&active).await?;
            let file = PathBuf::from(
                snapshot["state"]["sessionFile"]
                    .as_str()
                    .context("Pi 未返回当前会话路径")?,
            );
            if snapshot["state"]["sessionId"] != session_id
                || snapshot["state"]["sessionFile"] != state["sessionFile"]
            {
                bail!("编辑消息时会话意外切换，请重新连接原会话");
            }
            if let Some(guard) = self.guard.lock().unwrap().as_mut() {
                guard.baseline = session_guard::stamp(&file)?;
                guard.expecting_write = false;
            }
            self.save_recovery(json!({"sessionPath":file,"cwd":active.cwd,"interrupted":false}));
            Ok::<Value, anyhow::Error>(json!({"cancelled":false,"snapshot":snapshot}))
        }
        .await;
        if result.is_err() {
            active.rpc.stop().await;
            self.active.write().await.take();
            self.guard.lock().unwrap().take();
            self.emit(
                active.generation,
                json!({"type":"transport_exit","message":"消息编辑准备失败，请重新连接原会话"}),
            );
        }
        result
    }
    pub async fn command(&self, kind: &str, mut data: Value) -> Result<Value> {
        if ![
            "prompt",
            "abort",
            "clear_queue",
            "set_model",
            "set_thinking_level",
            "set_session_name",
            "compact",
            "set_auto_compaction",
        ]
        .contains(&kind)
        {
            bail!("不支持的命令");
        }
        if self.connecting.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst) {
            bail!("Pi 正在连接或关闭");
        }
        let _gate = if ["abort", "clear_queue"].contains(&kind) {
            None
        } else {
            Some(self.operation.try_lock().context("上一个操作仍在处理中")?)
        };
        let active = self.current().await?;
        if let Some(expected) = data
            .as_object_mut()
            .and_then(|data| data.remove("expectedSessionId"))
        {
            let state = active.rpc.call("get_state", json!({})).await?;
            if expected != state["sessionId"] {
                bail!("会话已切换，消息保留在编辑框中");
            }
        }
        if kind != "prompt"
            && !["abort", "clear_queue"].contains(&kind)
            && active.rpc.busy.load(Ordering::SeqCst)
        {
            bail!("请等待当前任务完成。");
        }
        if !["abort", "clear_queue"].contains(&kind) {
            let _launch = self.agents.launch_lock.lock().await;
            if let Some(guard) = self.guard.lock().unwrap().as_mut() {
                guard.validate_with_managed(active.rpc.pid, &self.agents.pids())?;
            }
        }
        if kind == "prompt" {
            if !active.rpc.busy.load(Ordering::SeqCst) {
                self.agents.permissions.begin_owner("Pi");
            }
            if let Some(paths) = data.get("references") {
                let paths: Vec<String> = serde_json::from_value(paths.clone())?;
                let cwd = active.cwd.clone();
                let content = tokio::task::spawn_blocking(move || {
                    crate::review::reference_content(&cwd, &paths)
                })
                .await??;
                data["message"] = format!(
                    "{}{}",
                    data["message"].as_str().unwrap_or_default(),
                    content
                )
                .into();
                data.as_object_mut().unwrap().remove("references");
            }
            validate_prompt(&data)?;
        }
        if !["abort", "clear_queue"].contains(&kind) {
            if let Some(guard) = self.guard.lock().unwrap().as_mut() {
                guard.expecting_write = true;
            }
        }
        let duration = if ["prompt", "compact"].contains(&kind) {
            Duration::from_secs(600)
        } else {
            Duration::from_secs(120)
        };
        if kind == "abort" {
            self.agents.permissions.cancel_owner("Pi").await;
        }
        let result = active.rpc.request(kind, data, duration).await;
        if result.is_ok() && kind == "set_model" {
            if let Ok(settings) = self.query_context_settings(&active, "get").await {
                *self.context_settings.lock().unwrap() = Some(settings);
            }
        }
        if ["abort", "compact"].contains(&kind) {
            if let Ok(state) = active.rpc.call("get_state", json!({})).await {
                active.rpc.busy.store(
                    state["isStreaming"] == true || state["isCompacting"] == true,
                    Ordering::SeqCst,
                );
            }
        }
        if result.is_err() {
            if let Some(guard) = self.guard.lock().unwrap().as_mut() {
                guard.expecting_write = false;
            }
        }
        result
    }
    pub async fn stop(&self) -> Result<Value> {
        let active = self.current().await?;
        self.agents.permissions.cancel_owner("Pi").await;
        {
            let _gate = self.task_actions.lock().await;
            for owner in self.delegations.lock().unwrap().drain() {
                self.agents.cancel_owner(&owner, false);
            }
        }
        let ids: Vec<String> = {
            let mut dialogs = self.dialogs.lock().unwrap();
            let ids = dialogs.keys().cloned().collect();
            dialogs.clear();
            ids
        };
        for id in ids {
            active
                .rpc
                .write(json!({"type":"extension_ui_response","id":id,"cancelled":true}))
                .await?;
        }
        self.emit(active.generation, json!({"type":"dialogs_cleared"}));
        let queue = active.rpc.call("clear_queue", json!({})).await?;
        active.rpc.call("abort", json!({})).await?;
        active.rpc.busy.store(false, Ordering::SeqCst);
        Ok(queue)
    }
    pub async fn respond(&self, response: Value) -> Result<()> {
        let active = self.current().await?;
        let id = response["id"].as_str().context("请求缺少 ID")?;
        let request = self
            .dialogs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("这个请求已经过期。")?;
        if request.0 != active.generation {
            bail!("请求不属于当前会话。");
        }
        let mut record = json!({"type":"extension_ui_response","id":id});
        if response["cancelled"] == true {
            record["cancelled"] = true.into();
        } else if request.1["method"] == "confirm" {
            record["confirmed"] = response["confirmed"]
                .as_bool()
                .context("确认值无效")?
                .into();
        } else {
            let value = response["value"].as_str().context("输入值无效")?;
            if request.1["method"] == "select"
                && !request.1["options"]
                    .as_array()
                    .is_some_and(|options| options.contains(&Value::String(value.into())))
            {
                bail!("无效的选项");
            }
            record["value"] = value.into();
        }
        active.rpc.write(record).await?;
        self.dialogs.lock().unwrap().remove(id);
        Ok(())
    }
    pub async fn sessions(&self, cwd: Option<String>) -> Result<Value> {
        let cwd = cwd.map(PathBuf::from).unwrap_or_default();
        let cwd = if cwd.as_os_str().is_empty() {
            PathBuf::from(self.preferences().await.last_workspace)
        } else {
            cwd
        };
        let config = self.agent_dir.clone();
        let index = self.index.clone();
        tokio::task::spawn_blocking(move || index.lock().unwrap().list(&cwd, &config)).await?
    }
    pub async fn diagnostics(&self) -> Value {
        let prefs = self.preferences().await;
        let active = self.active.read().await.clone();
        let mut state = Value::Null;
        if let Some(active) = &active {
            state = active
                .rpc
                .call("get_state", json!({}))
                .await
                .unwrap_or(Value::Null);
        }
        let protection=self.guard.lock().unwrap().as_ref().map(|g|json!({"path":g.path,"expectingWrite":g.expecting_write,"changed":session_guard::stamp(&g.path).ok()!=Some(g.baseline.clone())}));
        json!({"sessionProtection":protection,"runtime":"Rust + Tauri","version":env!("CARGO_PKG_VERSION"),"executable":prefs.executable,"workspace":active.as_ref().map(|a| &a.cwd),"connected":active.as_ref().is_some_and(|a| !a.rpc.closed.load(Ordering::SeqCst)),"stderr":active.as_ref().map(|a| a.rpc.stderr()).unwrap_or_default(),"sessionFile":state["sessionFile"],"pid":active.as_ref().map(|a|a.rpc.pid),"preferencesPath":self.preference_path,"agentPids":self.agents.pids(),"backgroundTasks":self.agents.list()["active"]})
    }
    pub async fn export(&self, output: &str) -> Result<Value> {
        let _gate = self.operation.try_lock().context("请等待当前操作完成")?;
        if self.busy().await {
            bail!("请等待任务完成再导出。");
        }
        self.current()
            .await?
            .rpc
            .call("export_html", json!({"outputPath":output}))
            .await
    }
    pub async fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.agents.shutdown().await;
        if let Some(active) = self.active.read().await.clone() {
            active.rpc.stop().await;
        }
        self.guard.lock().unwrap().take();
    }
    fn lease_root(&self) -> PathBuf {
        self.agent_dir.join("desktop-session-locks")
    }
    fn save_recovery(&self, value: Value) {
        let path = self.preference_path.with_file_name("recovery.json");
        let mut recovery = self.recovery.lock().unwrap();
        let should_persist = value["interrupted"] == true
            || value["sessionPath"]
                .as_str()
                .is_some_and(|p| Path::new(p).is_file());
        if let Some(bytes) = serde_json::to_vec(&value).ok().filter(|_| should_persist) {
            let temp = path.with_extension("json.tmp");
            if fs::write(&temp, bytes).is_ok() {
                let _ = fs::rename(temp, path);
            }
        }
        *recovery = value;
    }
    fn update_recovery(&self, interrupted: bool) {
        let mut value = self.recovery.lock().unwrap().clone();
        if value.is_object() {
            value["interrupted"] = interrupted.into();
            self.save_recovery(value);
        }
    }
    pub async fn session_access(&self, file: &str) -> Result<Value> {
        let active = self.active.read().await.clone();
        let own = self.guard.lock().unwrap().as_ref().map(|g| g.path.clone());
        session_guard::check(
            &self.lease_root(),
            Path::new(file),
            own.as_deref(),
            active.as_ref().map(|a| a.rpc.pid),
        )
    }
    async fn verify_context_bridge(&self, active: &Active) -> Result<()> {
        let commands = active.rpc.call("get_commands", json!({})).await?;
        let expected = session_guard::key(&self.bridge_path)?;
        if !commands["commands"].as_array().is_some_and(|commands| {
            commands.iter().any(|command| {
                command["name"] == "desktop-context"
                    && command["sourceInfo"]["path"].as_str().is_some_and(|p| {
                        session_guard::key(Path::new(p)).ok().as_ref() == Some(&expected)
                    })
            })
        }) {
            bail!("上下文配置扩展未加载，请重新连接 Pi。未发送模型请求。");
        }
        Ok(())
    }
    async fn query_context_settings(&self, active: &Active, operation: &str) -> Result<Value> {
        self.verify_context_bridge(active).await?;
        if operation == "reload" {
            let nonce = uuid::Uuid::new_v4().to_string();
            active
                .rpc
                .call(
                    "prompt",
                    json!({"message":format!("/desktop-context reload {nonce}")}),
                )
                .await?;
            self.verify_context_bridge(active).await?;
        }
        let nonce = uuid::Uuid::new_v4().to_string();
        let prefix = format!("PI_DESKTOP_CONTEXT:{nonce}:");
        let cursor = active.rpc.notification_cursor();
        active
            .rpc
            .call(
                "prompt",
                json!({"message":format!("/desktop-context get {nonce}")}),
            )
            .await?;
        let response = active
            .rpc
            .notifications_after(cursor)
            .iter()
            .filter_map(|event| event["message"].as_str())
            .find_map(|text| text.strip_prefix(&prefix))
            .map(str::to_owned)
            .context("Pi 未返回上下文配置")?;
        let result: Value = serde_json::from_str(&response).context("Pi 上下文配置响应无效")?;
        if result["ok"] != true {
            bail!("{}", result["error"].as_str().unwrap_or("无法读取配置"));
        }
        Ok(result)
    }
    pub async fn context_status(&self) -> Result<Value> {
        let active = self.current().await?;
        let (state, stats, history) = tokio::try_join!(
            active.rpc.call("get_state", json!({})),
            active.rpc.call("get_session_stats", json!({})),
            active.rpc.call("get_entries", json!({}))
        )?;
        let model_key = format!(
            "{}/{}",
            state["model"]["provider"].as_str().unwrap_or_default(),
            state["model"]["id"].as_str().unwrap_or_default()
        );
        let cached = self.context_settings.lock().unwrap().clone();
        if cached.as_ref().is_none_or(|s| s["modelKey"] != model_key)
            && !active.rpc.busy.load(Ordering::SeqCst)
        {
            if let Ok(_gate) = self.operation.try_lock() {
                let settings = self.query_context_settings(&active, "get").await?;
                *self.context_settings.lock().unwrap() = Some(settings);
            }
        }
        let settings = self
            .context_settings
            .lock()
            .unwrap()
            .clone()
            .filter(|s| s["modelKey"] == model_key);
        let window = state["model"]["contextWindow"].as_u64().unwrap_or_default();
        let trigger = settings
            .as_ref()
            .and_then(|s| s["reserveTokens"].as_u64())
            .map(|reserve| window.saturating_sub(reserve));
        let entries = history["entries"].as_array().context("会话历史无效")?;
        let session = state["sessionFile"].as_str().unwrap_or_default();
        let reported_usage = self
            .context_usage_cache
            .lock()
            .unwrap()
            .as_ref()
            .filter(|u| u["generation"] == active.generation && u["modelKey"] == model_key)
            .map(|u| u["usage"].clone())
            .filter(Value::is_object)
            .unwrap_or_else(|| stats["contextUsage"].clone());
        let usage = stats
            .get("contextUsage")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or(reported_usage);
        Ok(
            json!({"generation":active.generation,"model":public_model(&state["model"]),"modelKey":model_key,"enabled":state["autoCompactionEnabled"],"isCompacting":state["isCompacting"],"busy":active.rpc.busy.load(Ordering::SeqCst),"settings":settings,"triggerTokens":trigger,"usage":usage,"estimated":true,"totals":stats,"history":self.context_history.list(session,entries,history["leafId"].as_str()),"storageError":self.context_history.error()}),
        )
    }
    pub async fn permission_action(&self, payload: Value) -> Result<Value> {
        match payload["action"].as_str().unwrap_or("status") {
            "status" => Ok(self.agents.permissions.status()),
            "reply" => {
                if self.closing.load(Ordering::SeqCst) || self.connecting.load(Ordering::SeqCst) {
                    bail!("Pi 正在连接或关闭，未批准工具操作");
                }
                self.agents
                    .permissions
                    .reply(
                        payload["id"].as_str().context("缺少授权请求")?,
                        payload["allow"].as_bool().context("缺少授权选择")?,
                    )
                    .await
            }
            "set" => {
                let _gate = self.operation.lock().await;
                if self.connecting.load(Ordering::SeqCst) || self.agents.busy() {
                    bail!("请先结束当前任务再修改权限");
                }
                if let Ok(active) = self.current().await {
                    let state = active.rpc.call("get_state", json!({})).await?;
                    if active.rpc.busy.load(Ordering::SeqCst)
                        || state["isStreaming"] == true
                        || state["isCompacting"] == true
                    {
                        bail!("任务运行中不能修改权限");
                    }
                }
                let mode = crate::permissions::Mode::parse(
                    payload["mode"].as_str().context("缺少权限模式")?,
                )?;
                let rules = payload
                    .get("rules")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?;
                self.agents.permissions.set(mode, rules)
            }
            _ => bail!("未知权限操作"),
        }
    }
    pub async fn context_usage(&self) -> Result<Value> {
        let active = self.current().await?;
        let (state, stats) = tokio::try_join!(
            active.rpc.call("get_state", json!({})),
            active.rpc.call("get_session_stats", json!({}))
        )?;
        let model_key = format!(
            "{}/{}",
            state["model"]["provider"].as_str().unwrap_or_default(),
            state["model"]["id"].as_str().unwrap_or_default()
        );
        let settings = self
            .context_settings
            .lock()
            .unwrap()
            .clone()
            .filter(|s| s["modelKey"] == model_key);
        let report = self
            .context_usage_cache
            .lock()
            .unwrap()
            .clone()
            .filter(|u| u["generation"] == active.generation && u["modelKey"] == model_key);
        let usage = stats
            .get("contextUsage")
            .filter(|value| value.is_object())
            .cloned()
            .or_else(|| {
                report
                    .as_ref()
                    .map(|report| report["usage"].clone())
                    .filter(Value::is_object)
            })
            .unwrap_or(Value::Null);
        Ok(
            json!({"generation":active.generation,"modelKey":model_key,"usage":usage,"window":state["model"]["contextWindow"],"estimated":true,"compacting":state["isCompacting"],"busy":active.rpc.busy.load(Ordering::SeqCst),"autoCompact":state["autoCompactionEnabled"],"reserveTokens":settings.and_then(|settings|settings["reserveTokens"].as_u64()),"cost":stats["cost"]}),
        )
    }
    pub async fn configure_context(&self, patch: Value) -> Result<Value> {
        let _gate = self.operation.try_lock().context("请等待当前操作完成")?;
        let active = self.current().await?;
        if active.rpc.busy.load(Ordering::SeqCst) {
            bail!("请等待主任务完成或停止后保存压缩设置");
        }
        let state = active.rpc.call("get_state", json!({})).await?;
        let model_key = format!(
            "{}/{}",
            state["model"]["provider"].as_str().unwrap_or_default(),
            state["model"]["id"].as_str().unwrap_or_default()
        );
        if patch["modelKey"] != model_key || patch["generation"].as_u64() != Some(active.generation)
        {
            bail!("当前模型或会话已改变，请刷新后再保存");
        }
        let settings = self.query_context_settings(&active, "get").await?;
        {
            let _launch = self.agents.launch_lock.lock().await;
            if let Some(guard) = self.guard.lock().unwrap().as_ref() {
                guard.validate_with_managed(active.rpc.pid, &self.agents.pids())?;
            }
        }
        let scope = patch["scope"].as_str().unwrap_or("global");
        let file = match scope {
            "global" => {
                if settings["projectOverride"] == true {
                    bail!("当前项目已覆盖压缩设置，请保存到当前项目");
                }
                self.agent_dir.join("settings.json")
            }
            "project" => {
                if settings["projectTrusted"] != true {
                    bail!("当前项目未受信任，请选择所有项目");
                }
                let parent = active.cwd.join(".pi");
                fs::create_dir_all(&parent)?;
                if !workspace::canonical(&parent)?.starts_with(workspace::canonical(&active.cwd)?) {
                    bail!("项目配置目录位于工作区之外");
                }
                parent.join("settings.json")
            }
            _ => bail!("设置范围无效"),
        };
        let window = state["model"]["contextWindow"]
            .as_u64()
            .context("模型上下文窗口未知")?;
        let values = patch.clone();
        tokio::task::spawn_blocking(move || {
            crate::context::patch_settings(&file, &model_key, &values, window)
        })
        .await??;
        {
            let _launch = self.agents.launch_lock.lock().await;
            if let Some(guard) = self.guard.lock().unwrap().as_mut() {
                guard
                    .validate_with_managed(active.rpc.pid, &self.agents.pids())
                    .context("设置已保存，但会话已改变；请恢复或复制会话后重新加载配置")?;
                guard.expecting_write = true;
            }
        }
        let reloaded = self
            .query_context_settings(&active, "reload")
            .await
            .context("设置已保存，但 Pi 重载失败；请重新连接后检查");
        if let Ok(state) = active.rpc.call("get_state", json!({})).await {
            if state["isStreaming"] != true && state["isCompacting"] != true {
                if let Some(guard) = self.guard.lock().unwrap().as_mut() {
                    guard.baseline = session_guard::stamp(&guard.path)?;
                    guard.expecting_write = false;
                }
            }
        }
        let next = reloaded?;
        *self.context_settings.lock().unwrap() = Some(next.clone());
        Ok(next)
    }
    pub async fn agent_action(&self, data: Value) -> Result<Value> {
        let _gate = self.task_actions.lock().await;
        let operation = data["action"].as_str().unwrap_or("list");
        let id = data["id"].as_str().unwrap_or_default();
        let preferences = self.preferences().await;
        let (executable, prefix) = executable_for_connection(&preferences);
        let runner = crate::agents::Runner { executable, prefix };
        match operation {
            "list" => self.agents.query(&data),
            "archive" | "restore" => self.agents.archive(id, operation == "archive"),
            "output" => {
                let offset = match data.get("offset") {
                    None => 0,
                    Some(value) => usize::try_from(value.as_u64().context("结果分页位置无效")?)?,
                };
                let version = data
                    .get("version")
                    .map(|v| v.as_str().context("结果版本无效"))
                    .transpose()?
                    .map(String::from);
                let agents = self.agents.clone();
                let id = id.to_owned();
                tokio::task::spawn_blocking(move || agents.output(&id, offset, version.as_deref()))
                    .await?
            }
            "detail" => self.agents.detail(id),
            "definition" => {
                let mut agent = crate::agents::definition(&self.agent_dir)?;
                agent.as_object_mut().unwrap().remove("systemPrompt");
                Ok(agent)
            }
            "cancel" => self.agents.cancel(id, false),
            "retry" | "resume" => self.agents.retry(id, runner, operation == "resume"),
            "start" => {
                if self.closing.load(Ordering::SeqCst) || self.connecting.load(Ordering::SeqCst) {
                    bail!("Pi 正在连接或关闭");
                }
                let active = self.current().await?;
                let state = active.rpc.call("get_state", json!({})).await?;
                let definition = crate::agents::definition(&self.agent_dir)?;
                let inherited = format!(
                    "{}/{}",
                    state["model"]["provider"].as_str().unwrap_or_default(),
                    state["model"]["id"].as_str().unwrap_or_default()
                );
                let source = data["modelSource"].as_str().unwrap_or("parent");
                if !["parent", "definition"].contains(&source) {
                    bail!("模型来源无效");
                }
                let configured = if source == "definition" {
                    definition["model"].as_str().filter(|m| !m.is_empty())
                } else {
                    None
                };
                let model = data["model"]
                    .as_str()
                    .filter(|m| !m.is_empty())
                    .or(configured)
                    .unwrap_or(&inherited)
                    .to_owned();
                if model == "/" {
                    bail!("主会话尚未选择模型，请为探子指定模型");
                }
                let thinking = data["thinking"]
                    .as_str()
                    .or_else(|| definition["thinking"].as_str())
                    .unwrap_or("medium")
                    .to_owned();
                let tasks = data["tasks"].as_array().context("任务列表无效")?;
                if tasks.is_empty() || tasks.len() > 8 {
                    bail!("一次可添加 1–8 个任务");
                }
                let tasks = tasks
                    .iter()
                    .map(|task| {
                        task.as_str()
                            .filter(|text| !text.trim().is_empty() && text.len() <= 32 * 1024)
                            .map(String::from)
                            .context("任务不能为空且最多 32 KB")
                    })
                    .collect::<Result<Vec<_>>>()?;
                if self.agents.list()["active"].as_u64().unwrap_or_default() + tasks.len() as u64
                    > 32
                {
                    bail!("最多同时保留 32 个运行或排队任务");
                }
                let mut created = Vec::new();
                let owner = data["owner"].as_str().unwrap_or_default();
                if !owner.is_empty() && !self.delegations.lock().unwrap().contains(owner) {
                    bail!("派发任务的父工具调用已结束");
                }
                let project_trusted = self
                    .context_settings
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|settings| settings["projectTrusted"] == true);
                for task in tasks {
                    created.push(
                        self.agents.start(
                            crate::agents::NewTask {
                                task,
                                cwd: active.cwd.clone(),
                                role: data["role"].as_str().map(str::to_owned),
                                parent_session: state["sessionFile"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .into(),
                                model: model.clone(),
                                thinking: thinking.clone(),
                                system_prompt: definition["systemPrompt"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .into(),
                                owner: owner.into(),
                                project_trusted,
                            },
                            runner.clone(),
                            None,
                        )?,
                    );
                }
                Ok(json!({"tasks":created}))
            }
            _ => bail!("不支持的任务操作"),
        }
    }
    pub async fn mcp_status(&self, reconnect: Option<String>) -> Result<Value> {
        let _gate = self.operation.try_lock().context("请等待当前操作完成")?;
        let active = self.current().await?;
        if active.rpc.busy.load(Ordering::SeqCst) {
            bail!("请等待当前任务完成后检查 MCP。");
        }
        let commands = active.rpc.call("get_commands", json!({})).await?;
        if !commands["commands"].as_array().is_some_and(|commands| {
            commands
                .iter()
                .any(|c| c["name"] == "mcp" && c["sourceInfo"]["path"] == "builtin:mcp")
        }) {
            bail!("当前会话未提供 Pi 内置 MCP 管理命令；替代扩展请使用其自身界面。");
        }
        self.mcp_query.store(true, Ordering::SeqCst);
        let _reset = ConnectingGuard(&self.mcp_query);
        let mut operation_errors = Vec::new();
        if let Some(name) = reconnect {
            if !crate::mcp::valid_server(&name) {
                bail!("无效 MCP 服务器名称");
            }
            let cursor = active.rpc.notification_cursor();
            active
                .rpc
                .call(
                    "prompt",
                    json!({"message":format!("/mcp reconnect {name}")}),
                )
                .await?;
            for event in active.rpc.notifications_after(cursor) {
                if event["notifyType"] == "error" {
                    operation_errors.push(event["message"].clone());
                }
            }
        }
        let cursor = active.rpc.notification_cursor();
        active.rpc.call("prompt", json!({"message":"/mcp"})).await?;
        let text = active
            .rpc
            .notifications_after(cursor)
            .iter()
            .filter_map(|e| e["message"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let mut result = crate::mcp::parse_status(&text);
        result["operationErrors"] = json!(operation_errors);
        Ok(result)
    }
}
fn executable_for_connection(preferences: &Preferences) -> (PathBuf, Vec<String>) {
    #[cfg(feature = "test-fixture")]
    if std::env::var("PI_DESKTOP_TEST").as_deref() == Ok("1") {
        return (
            PathBuf::from("node"),
            vec![Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixture-pi.mjs")
                .to_string_lossy()
                .into_owned()],
        );
    }
    (PathBuf::from(&preferences.executable), Vec::new())
}
fn public_model(model: &Value) -> Value {
    if !model.is_object() {
        return Value::Null;
    }
    let mut object = serde_json::Map::new();
    for key in [
        "id",
        "name",
        "provider",
        "reasoning",
        "input",
        "contextWindow",
    ] {
        if let Some(value) = model.get(key) {
            object.insert(key.into(), value.clone());
        }
    }
    Value::Object(object)
}
fn find_executable() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("PI_DESKTOP_EXECUTABLE") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    let bases = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf)),
        cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
    ];
    for base in bases.into_iter().flatten() {
        for parent in base.ancestors().take(7) {
            let candidate = parent.join(if cfg!(windows) { "pi.exe" } else { "pi" });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = directory.join(if cfg!(windows) { "pi.exe" } else { "pi" });
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
fn validate_prompt(data: &Value) -> Result<()> {
    let message = data["message"].as_str().context("消息必须是文本")?;
    if message.trim().is_empty() || message.len() > 2 * 1024 * 1024 {
        bail!("消息为空或过长。");
    }
    if let Some(images) = data.get("images") {
        let images = images.as_array().context("图片格式无效")?;
        if images.len() > 8 {
            bail!("一次最多 8 张图片。");
        }
        let mut total = 0;
        for image in images {
            if image["type"] != "image"
                || !["image/png", "image/jpeg", "image/gif", "image/webp"]
                    .contains(&image["mimeType"].as_str().unwrap_or_default())
            {
                bail!("不支持的图片类型");
            }
            total += image["data"].as_str().context("图片数据无效")?.len();
        }
        if total > 28 * 1024 * 1024 {
            bail!("图片总大小超过限制。");
        }
    }
    if let Some(behavior) = data.get("streamingBehavior") {
        if behavior != "steer" && behavior != "followUp" {
            bail!("无效发送方式");
        }
    }
    Ok(())
}
