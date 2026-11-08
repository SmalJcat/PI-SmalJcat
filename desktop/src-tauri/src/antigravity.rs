//! Official Antigravity ACP v1 client. Credentials remain owned by agy.
use crate::permissions::{Mode as PermissionMode, Rules};
use crate::rpc::{hide_console, EventSink, JsonLines};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot, watch, Mutex as AsyncMutex},
};
use uuid::Uuid;

type Reply = oneshot::Sender<std::result::Result<Value, RequestFailure>>;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CACHE: usize = 16 * 1024 * 1024;

#[derive(Debug)]
enum RequestFailure {
    Agent(String),
    Transport(String),
    Timeout,
}
impl std::fmt::Display for RequestFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Agent(message) | Self::Transport(message) => message,
            Self::Timeout => "ACP 请求超时，结果未确认",
        })
    }
}
impl std::error::Error for RequestFailure {}

#[derive(Clone)]
pub struct LaunchSpec {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

struct Transport {
    writer: mpsc::Sender<Value>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
    closed: AtomicBool,
    stop: watch::Sender<bool>,
    exited: watch::Receiver<bool>,
    pid: u32,
}
impl Transport {
    async fn spawn(
        spec: &LaunchSpec,
        cwd: &Path,
        owner: std::sync::Weak<Antigravity>,
        epoch: u64,
    ) -> Result<Arc<Self>> {
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        apply_proxy(&mut command).await;
        hide_console(&mut command);
        let mut child = command
            .spawn()
            .context("无法启动 Antigravity CLI，请检查安装路径")?;
        #[cfg(windows)]
        let job = match crate::rpc::ProcessJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                return Err(error);
            }
        };
        let pid = child.id().context("Antigravity 未返回进程 ID")?;
        let mut stdin = child.stdin.take().context("ACP stdin 不可用")?;
        let mut stdout = child.stdout.take().context("ACP stdout 不可用")?;
        let mut stderr = child.stderr.take().context("ACP stderr 不可用")?;
        let (writer, mut queue) = mpsc::channel::<Value>(64);
        let (stop, mut stopped) = watch::channel(false);
        let (exited_sender, exited) = watch::channel(false);
        let connection = Arc::new(Self {
            writer,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            stop,
            exited,
            pid,
        });
        let weak = Arc::downgrade(&connection);
        let mut write_stop = connection.stop.subscribe();
        tokio::spawn(async move {
            loop {
                let value = tokio::select! { _ = write_stop.changed() => break, value = queue.recv() => match value {Some(value) => value, None => break} };
                let Ok(mut bytes) = serde_json::to_vec(&value) else {
                    continue;
                };
                bytes.push(b'\n');
                let result = tokio::time::timeout(Duration::from_secs(5), async {
                    stdin.write_all(&bytes).await?;
                    stdin.flush().await
                })
                .await;
                if !matches!(result, Ok(Ok(()))) {
                    if let Some(connection) = weak.upgrade() {
                        connection.fail("Antigravity 输入通道已关闭");
                    }
                    break;
                }
            }
        });
        // Drain stderr without exposing OAuth URLs, credentials, or personal account data.
        tokio::spawn(async move {
            let mut bytes = [0u8; 4096];
            while let Ok(count) = stderr.read(&mut bytes).await {
                if count == 0 {
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&connection);
        let read_owner = owner.clone();
        tokio::spawn(async move {
            let mut bytes = [0u8; 16384];
            let mut parser = JsonLines::default();
            loop {
                let (messages, eof) = match stdout.read(&mut bytes).await {
                    Ok(0) => (parser.finish(), true),
                    Ok(count) => (parser.push(&bytes[..count]), false),
                    Err(_) => break,
                };
                let Ok(messages) = messages else { break };
                for message in messages {
                    let Some(connection) = weak.upgrade() else {
                        return;
                    };
                    if message.get("method").is_some() {
                        if let Some(owner) = read_owner.upgrade() {
                            owner.receive(epoch, &connection, message).await;
                        }
                    } else if let Some(id) = message["id"].as_u64() {
                        if let Some(waiter) = connection.pending.lock().unwrap().remove(&id) {
                            let result = if message.get("error").is_some() {
                                Err(RequestFailure::Agent(
                                    message["error"]["message"]
                                        .as_str()
                                        .unwrap_or("ACP 请求失败")
                                        .chars()
                                        .take(2000)
                                        .collect(),
                                ))
                            } else {
                                Ok(message["result"].clone())
                            };
                            let _ = waiter.send(result);
                        }
                    }
                }
                // EOF is signalled through the process monitor even with no trailing record.
                if eof
                    || weak
                        .upgrade()
                        .is_none_or(|connection| connection.closed.load(Ordering::SeqCst))
                {
                    break;
                }
            }
            if let Some(connection) = weak.upgrade() {
                connection.fail("Antigravity 连接已断开");
            }
        });
        let weak = Arc::downgrade(&connection);
        tokio::spawn(async move {
            tokio::select! { _ = child.wait() => {}, _ = stopped.changed() => { let _ = child.kill().await; } }
            #[cfg(windows)]
            drop(job);
            if let Some(connection) = weak.upgrade() {
                connection.fail("Antigravity 进程已退出");
            }
            if let Some(owner) = owner.upgrade() {
                owner.exited(epoch);
            }
            let _ = exited_sender.send(true);
        });
        Ok(connection)
    }
    fn fail(&self, message: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.stop.send(true);
        for (_, waiter) in self.pending.lock().unwrap().drain() {
            let _ = waiter.send(Err(RequestFailure::Transport(message.to_owned())));
        }
    }
    async fn send(&self, value: Value) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            bail!("Antigravity 连接已关闭");
        }
        tokio::time::timeout(Duration::from_secs(5), self.writer.send(value))
            .await
            .context("ACP 写入超时")?
            .context("ACP 输入通道已关闭")
    }
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(error) = self
            .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let result = tokio::time::timeout(timeout, rx).await;
        self.pending.lock().unwrap().remove(&id);
        match result {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(anyhow::Error::new(error).context(method.to_owned())),
            Ok(Err(_)) => Err(RequestFailure::Transport("ACP 请求已中断".into()).into()),
            Err(_) => Err(anyhow::Error::new(RequestFailure::Timeout).context(method.to_owned())),
        }
    }
    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Conversation {
    session_id: String,
    cwd: String,
    messages: Vec<Value>,
    tools: BTreeMap<String, Value>,
    config_options: Vec<Value>,
    commands: Vec<Value>,
    interrupted: bool,
    context_usage: Option<Value>,
}
#[derive(Clone)]
struct Permission {
    rpc_id: Value,
    params: Value,
}
#[derive(Default)]
struct State {
    epoch: u64,
    revision: u64,
    turn: u64,
    connected: bool,
    connecting: bool,
    busy: bool,
    cancelling: bool,
    error: String,
    warning: String,
    pid: Option<u32>,
    capabilities: Value,
    agent_info: Value,
    permission_mode: PermissionMode,
    permission_rules: Rules,
    permission_error: String,
    protected_root: PathBuf,
    conversation: Conversation,
    permissions: BTreeMap<String, Permission>,
}

pub struct Antigravity {
    data_dir: PathBuf,
    state: Mutex<State>,
    connection: AsyncMutex<Option<Arc<Transport>>>,
    operation: AsyncMutex<()>,
    cache_gate: AsyncMutex<()>,
    sink: Mutex<Option<EventSink>>,
    launcher: Option<LaunchSpec>,
}
impl Antigravity {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Self::with_launcher(data_dir, None)
    }
    pub fn with_launcher(data_dir: PathBuf, launcher: Option<LaunchSpec>) -> Arc<Self> {
        let rules = crate::permissions::load_rules(&data_dir.join("permission-rules.json"));
        let state = State {
            permission_error: rules
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_default(),
            permission_rules: rules.unwrap_or_default(),
            protected_root: data_dir.parent().unwrap_or(&data_dir).to_owned(),
            ..Default::default()
        };
        Arc::new(Self {
            data_dir,
            state: Mutex::new(state),
            connection: AsyncMutex::new(None),
            operation: AsyncMutex::new(()),
            cache_gate: AsyncMutex::new(()),
            sink: Mutex::new(None),
            launcher,
        })
    }
    pub fn subscribe(&self, sink: EventSink) {
        *self.sink.lock().unwrap() = Some(sink);
    }
    pub fn busy(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.busy || state.connecting
    }
    fn summary(state: &State) -> Value {
        json!({"revision":state.revision,"connected":state.connected,"connecting":state.connecting,"busy":state.busy,"cancelling":state.cancelling,"capabilities":state.capabilities,"error":state.error,"warning":state.warning,"pid":state.pid,"sessionId":state.conversation.session_id,"cwd":state.conversation.cwd,"configOptions":state.conversation.config_options,"agentInfo":state.agent_info,"permissionMode":state.permission_mode,"permissionRules":state.permission_rules,"permissionConfigError":state.permission_error,"contextUsage":state.conversation.context_usage,"permissions":state.permissions.iter().map(|(id,request)|json!({"id":id,"toolCall":request.params["toolCall"],"options":request.params["options"]})).collect::<Vec<_>>()})
    }
    pub fn status(&self) -> Value {
        let state = self.state.lock().unwrap();
        let mut value = Self::summary(&state);
        value["messages"] = json!(state.conversation.messages);
        value["tools"] = json!(state.conversation.tools);
        value["executable"] = json!(self.saved_executable().to_string_lossy());
        value["permissionConfigFile"] = json!(self.data_dir.join("permission-rules.json"));
        value
    }
    fn change(&self, update: impl FnOnce(&mut State) -> Value) {
        let value = {
            let mut state = self.state.lock().unwrap();
            let patch = update(&mut state);
            state.revision += 1;
            let mut value = Self::summary(&state);
            if let Some(patch) = patch.as_object() {
                for (key, value2) in patch {
                    value[key] = value2.clone();
                }
            }
            value
        };
        if let Some(sink) = self.sink.lock().unwrap().clone() {
            sink(value);
        }
    }
    fn saved_executable(&self) -> PathBuf {
        if let Some(spec) = &self.launcher {
            return spec.executable.clone();
        }
        if let Some(path) = std::env::var_os("PI_DESKTOP_ANTIGRAVITY_EXECUTABLE") {
            return path.into();
        }
        if let Ok(value) = std::fs::read(self.data_dir.join("settings.json")) {
            if let Ok(value) = serde_json::from_slice::<Value>(&value) {
                if let Some(path) = value["executable"].as_str() {
                    return path.into();
                }
            }
        }
        dirs::data_local_dir()
            .unwrap_or_default()
            .join("agy/bin/agy.exe")
    }
    async fn transport(&self) -> Result<Arc<Transport>> {
        self.connection
            .lock()
            .await
            .clone()
            .filter(|connection| !connection.closed.load(Ordering::SeqCst))
            .context("请先连接 Antigravity CLI")
    }
    fn cache_path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty()
            || id.len() > 120
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            bail!("无效 Antigravity 会话 ID");
        }
        Ok(self.data_dir.join("history").join(format!("{id}.json")))
    }
    async fn save(&self) {
        let _cache = self.cache_gate.lock().await;
        let conversation = self.state.lock().unwrap().conversation.clone();
        let Ok(path) = self.cache_path(&conversation.session_id) else {
            return;
        };
        let result = tokio::task::spawn_blocking(move || -> Result<()> {
            let bytes = serde_json::to_vec(&conversation)?;
            if bytes.len() > MAX_CACHE {
                bail!("Antigravity 显示缓存超过 16 MB，完整历史仍由 CLI 保存");
            }
            std::fs::create_dir_all(path.parent().unwrap())?;
            let temporary = path.with_extension("tmp");
            std::fs::write(&temporary, bytes)?;
            std::fs::rename(temporary, path)?;
            Ok(())
        })
        .await;
        if let Ok(Err(error)) = result {
            self.change(|state| {
                state.error = format!("无法保存显示缓存：{error}");
                json!({})
            });
        }
    }
    fn exited(&self, epoch: u64) {
        if self.state.lock().unwrap().epoch != epoch {
            return;
        }
        self.change(|state| {
            state.connected = false;
            state.connecting = false;
            state.pid = None;
            if state.busy {
                state.error = "Antigravity 已断开；任务未自动重试".into();
            }
            state.busy = false;
            state.cancelling = false;
            state.permissions.clear();
            json!({})
        });
    }
    pub async fn connect(self: &Arc<Self>, cwd: &Path, executable: Option<&str>) -> Result<Value> {
        let _operation = self.operation.lock().await;
        let permission_mode = self.state.lock().unwrap().permission_mode;
        self.connect_inner(cwd, executable, permission_mode, true)
            .await
    }
    pub async fn connect_new(
        self: &Arc<Self>,
        cwd: &Path,
        executable: Option<&str>,
    ) -> Result<Value> {
        let _operation = self.operation.lock().await;
        let permission_mode = self.state.lock().unwrap().permission_mode;
        self.connect_inner(cwd, executable, permission_mode, false)
            .await
    }
    pub async fn set_permission_mode(self: &Arc<Self>, mode: &str) -> Result<Value> {
        self.set_permission_policy(mode, None).await
    }
    pub async fn set_permission_policy(
        self: &Arc<Self>,
        mode: &str,
        rules: Option<Rules>,
    ) -> Result<Value> {
        let mode = PermissionMode::parse(mode)?;
        let _operation = self.operation.lock().await;
        if self.busy() {
            bail!("请先停止当前 Antigravity 任务");
        }
        if let Some(rules) = rules {
            rules.validate()?;
            crate::context::atomic_json(
                &self.data_dir.join("permission-rules.json"),
                &json!(rules),
            )?;
            self.change(|state| {
                state.permission_rules = rules;
                state.permission_error.clear();
                json!({})
            });
        }
        if mode == PermissionMode::Custom && !self.state.lock().unwrap().permission_error.is_empty()
        {
            bail!("自定义权限配置无效，请先保存有效规则");
        }
        let (current, connected, cwd) = {
            let state = self.state.lock().unwrap();
            (
                state.permission_mode,
                state.connected,
                state.conversation.cwd.clone(),
            )
        };
        if mode == current {
            return Ok(self.status());
        }
        if connected
            && (current == PermissionMode::FullAccess || mode == PermissionMode::FullAccess)
        {
            // ACP has no runtime approval selector. The official flag applies to a
            // process, so reopen the same session with an explicitly selected policy.
            self.connect_inner(Path::new(&cwd), None, mode, true).await
        } else {
            self.change(|state| {
                state.permission_mode = mode;
                json!({})
            });
            Ok(self.status())
        }
    }
    async fn connect_inner(
        self: &Arc<Self>,
        cwd: &Path,
        executable: Option<&str>,
        permission_mode: PermissionMode,
        restore_session: bool,
    ) -> Result<Value> {
        if self.busy() {
            bail!("请先停止当前 Antigravity 任务");
        }
        let cwd = dunce::canonicalize(cwd).context("工作区不存在")?;
        if !cwd.is_dir() {
            bail!("工作区必须是文件夹");
        }
        let mut spec = if let Some(spec) = &self.launcher {
            spec.clone()
        } else if cfg!(feature = "test-fixture")
            && std::env::var("PI_DESKTOP_TEST").as_deref() == Ok("1")
        {
            LaunchSpec {
                executable: std::env::current_exe()?
                    .parent()
                    .context("测试程序目录不可用")?
                    .join(if cfg!(windows) {
                        "acp-fixture.exe"
                    } else {
                        "acp-fixture"
                    }),
                args: vec![],
            }
        } else {
            let executable = executable
                .map(PathBuf::from)
                .unwrap_or_else(|| self.saved_executable());
            if !executable.is_absolute() || !executable.is_file() {
                bail!("未找到 Antigravity CLI，请在连接设置中选择 agy.exe");
            }
            std::fs::create_dir_all(&self.data_dir)?;
            std::fs::write(
                self.data_dir.join("settings.json"),
                serde_json::to_vec(&json!({"executable":executable}))?,
            )?;
            LaunchSpec {
                executable,
                args: vec!["acp".into()],
            }
        };
        if permission_mode == PermissionMode::FullAccess {
            spec.args.push("--dangerously-skip-permissions".into());
        }
        let (previous, previous_mode) = {
            let state = self.state.lock().unwrap();
            (state.conversation.clone(), state.permission_mode)
        };
        let restore =
            (restore_session && !previous.session_id.is_empty() && Path::new(&previous.cwd) == cwd)
                .then(|| previous.clone());
        self.shutdown_inner().await;
        self.change(|state| {
            state.epoch += 1;
            state.connecting = true;
            state.error.clear();
            state.warning.clear();
            state.permission_mode = permission_mode;
            state.conversation = restore.clone().unwrap_or_else(|| Conversation {
                cwd: cwd.to_string_lossy().into_owned(),
                ..Default::default()
            });
            json!({"reset":true,"messages":state.conversation.messages,"tools":state.conversation.tools})
        });
        let epoch = self.state.lock().unwrap().epoch;
        let result = async {
            let connection = Transport::spawn(&spec, &cwd, Arc::downgrade(self), epoch).await?;
            if self.state.lock().unwrap().epoch != epoch { connection.fail("连接已取消"); bail!("连接已取消"); }
            *self.connection.lock().await = Some(connection.clone());
            let init = connection.request("initialize", json!({"protocolVersion":1,"clientInfo":{"name":"pi-desktop","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}), CONTROL_TIMEOUT).await?;
            if init["protocolVersion"] != 1 { bail!("Antigravity 返回不支持的 ACP 协议版本"); }
            self.change(|state| { state.capabilities = init["agentCapabilities"].clone(); state.agent_info = init["agentInfo"].clone(); state.connected = true; state.pid = Some(connection.pid); json!({}) });
            self.setup_session(&connection, restore.as_ref().map(|conversation| conversation.session_id.as_str()), restore.as_ref()).await?;
            self.save().await;
            Ok::<_, anyhow::Error>(())
        }.await;
        if let Err(error) = result {
            self.change(|state| {
                state.epoch += 1;
                state.error = format!("{error:#}");
                state.conversation = previous;
                // A failed attempt to restrict access must never make the next
                // ordinary reconnect silently enable the previous full access.
                state.permission_mode = if permission_mode != PermissionMode::FullAccess {
                    permission_mode
                } else {
                    previous_mode
                };
                json!({"reset":true,"messages":state.conversation.messages,"tools":state.conversation.tools})
            });
            self.shutdown_inner().await;
            return Err(error);
        }
        self.change(|state| {
            state.connecting = false;
            json!({})
        });
        Ok(self.status())
    }
    async fn setup_session(
        &self,
        connection: &Transport,
        id: Option<&str>,
        preferred: Option<&Conversation>,
    ) -> Result<()> {
        let cwd = self.state.lock().unwrap().conversation.cwd.clone();
        let mut cached = preferred
            .filter(|value| Some(value.session_id.as_str()) == id && value.cwd == cwd)
            .cloned();
        if let Some(id) = id {
            let path = self.cache_path(id)?;
            if let Ok(bytes) = std::fs::read(path) {
                if cached.is_none() && bytes.len() <= MAX_CACHE {
                    if let Ok(value) = serde_json::from_slice::<Conversation>(&bytes) {
                        if value.session_id == id && value.cwd == cwd {
                            cached = Some(value);
                        }
                    }
                }
            }
        }
        if let Some(usage) = cached
            .as_mut()
            .and_then(|cached| cached.context_usage.as_mut())
        {
            usage["stale"] = json!(true);
        }
        let resumable =
            self.state.lock().unwrap().capabilities["sessionCapabilities"]["resume"].is_object();
        let method = if id.is_none() {
            "session/new"
        } else if cached.as_ref().is_some_and(|cache| !cache.interrupted) && resumable {
            "session/resume"
        } else {
            "session/load"
        };
        self.change(|state| { state.conversation = if method == "session/resume" { cached.clone().unwrap() } else { Conversation { cwd: cwd.clone(), session_id: id.unwrap_or_default().into(), ..Default::default() } }; json!({"reset":true,"messages":state.conversation.messages,"tools":state.conversation.tools}) });
        let mut params = json!({"cwd":cwd,"mcpServers":[]});
        if let Some(id) = id {
            params["sessionId"] = json!(id);
        }
        let response = connection.request(method, params, CONTROL_TIMEOUT).await?;
        let session_id = id
            .map(str::to_owned)
            .or_else(|| response["sessionId"].as_str().map(str::to_owned))
            .context("ACP 未返回会话 ID")?;
        self.cache_path(&session_id)?;
        self.change(|state| {
            state.conversation.session_id = session_id;
            if let Some(options) = response["configOptions"].as_array() {
                state.conversation.config_options = options.clone();
            }
            if method == "session/load" && state.conversation.messages.is_empty() {
                if let Some(cache) = cached.as_ref() {
                    state.conversation.messages = cache.messages.clone(); state.conversation.tools = cache.tools.clone(); state.conversation.interrupted = cache.interrupted;
                    if cache.interrupted { state.error = "上次任务中断；CLI 未重放历史，当前显示已保存片段".into(); }
                } else { state.error = "CLI 未重放历史；后续对话仍使用所选官方会话".into(); }
            }
            json!({"reset":true,"messages":state.conversation.messages,"tools":state.conversation.tools})
        });
        if let Some(previous) = &cached {
            self.restore_configuration(connection, previous).await?;
            self.change(|state| {
                if state.conversation.context_usage.is_none() {
                    if let Some(usage) = previous
                        .context_usage
                        .as_ref()
                        .filter(|u| u["modelId"] == model_id(&state.conversation))
                    {
                        let mut usage = usage.clone();
                        usage["stale"] = json!(true);
                        state.conversation.context_usage = Some(usage);
                    }
                }
                json!({})
            });
        }
        self.save().await;
        Ok(())
    }
    async fn restore_configuration(
        &self,
        connection: &Transport,
        previous: &Conversation,
    ) -> Result<()> {
        let mut options = previous.config_options.clone();
        let mut rejected = Vec::new();
        options.sort_by_key(|option| option["category"] != "model");
        for option in options {
            let (Some(id), Some(value)) = (option["id"].as_str(), option["currentValue"].as_str())
            else {
                continue;
            };
            let supported = self
                .state
                .lock()
                .unwrap()
                .conversation
                .config_options
                .iter()
                .any(|current| {
                    current["id"] == id
                        && current["currentValue"] != value
                        && has_option(&current["options"], value)
                });
            if supported {
                let result = connection
                    .request(
                        "session/set_config_option",
                        json!({"sessionId":previous.session_id,"configId":id,"value":value}),
                        CONTROL_TIMEOUT,
                    )
                    .await;
                match result {
                    Ok(response) => self.apply_config_response(id, value, &response),
                    Err(error)
                        if matches!(
                            error.downcast_ref::<RequestFailure>(),
                            Some(RequestFailure::Agent(_))
                        ) => {}
                    Err(error) => {
                        connection.fail("配置恢复未确认，已断开 Antigravity");
                        return Err(error);
                    }
                }
                let restored = self
                    .state
                    .lock()
                    .unwrap()
                    .conversation
                    .config_options
                    .iter()
                    .any(|current| current["id"] == id && current["currentValue"] == value);
                if !restored {
                    rejected.push(
                        match option["category"].as_str().unwrap_or(id) {
                            "model" => "模型",
                            "thought_level" => "推理档位",
                            "mode" => "模式",
                            _ => id,
                        }
                        .to_owned(),
                    );
                }
            }
        }
        if !rejected.is_empty() {
            self.change(|state| {
                state.warning = format!("未恢复{}，已保留 CLI 当前配置", rejected.join("、"));
                json!({})
            });
        }
        Ok(())
    }
    pub async fn session(self: &Arc<Self>, id: Option<&str>) -> Result<Value> {
        let _operation = self.operation.lock().await;
        if self.busy() {
            bail!("请先停止当前 Antigravity 任务");
        }
        let connection = self.transport().await?;
        self.save().await;
        let previous = self.state.lock().unwrap().conversation.clone();
        self.change(|state| {
            state.connecting = true;
            state.error.clear();
            state.warning.clear();
            json!({})
        });
        let result = self.setup_session(&connection, id, None).await;
        self.change(|state| { state.connecting = false; if result.is_err() { state.conversation = previous; } json!({"reset":true,"messages":state.conversation.messages,"tools":state.conversation.tools}) });
        if result.is_err() && connection.closed.load(Ordering::SeqCst) {
            self.shutdown_inner().await;
        }
        result?;
        Ok(self.status())
    }
    pub async fn list(&self) -> Result<Value> {
        let connection = self.transport().await?;
        let cwd = self.state.lock().unwrap().conversation.cwd.clone();
        connection
            .request("session/list", json!({"cwd":cwd}), CONTROL_TIMEOUT)
            .await
    }
    pub async fn configure(&self, id: &str, value: &str) -> Result<Value> {
        let _operation = self.operation.lock().await;
        if self.busy() {
            bail!("任务运行时不能修改配置");
        }
        let session = {
            let state = self.state.lock().unwrap();
            let option = state
                .conversation
                .config_options
                .iter()
                .find(|item| item["id"] == id)
                .context("未知 Antigravity 配置项")?;
            if !has_option(&option["options"], value) {
                bail!("不支持的 Antigravity 配置值");
            }
            state.conversation.session_id.clone()
        };
        let response = self
            .transport()
            .await?
            .request(
                "session/set_config_option",
                json!({"sessionId":session,"configId":id,"value":value}),
                CONTROL_TIMEOUT,
            )
            .await?;
        self.apply_config_response(id, value, &response);
        self.change(|state| {
            state.warning.clear();
            json!({})
        });
        self.save().await;
        Ok(self.status())
    }
    fn apply_config_response(&self, id: &str, value: &str, response: &Value) {
        self.change(|state| {
            let previous = model_id(&state.conversation).to_owned();
            if let Some(options) = response["configOptions"].as_array() {
                state.conversation.config_options = options.clone();
            } else if let Some(option) = state
                .conversation
                .config_options
                .iter_mut()
                .find(|item| item["id"] == id)
            {
                option["currentValue"] = json!(value);
            }
            if previous != model_id(&state.conversation) {
                state.conversation.context_usage = None;
            }
            json!({})
        });
    }
    pub async fn prompt(self: &Arc<Self>, text: &str, images: &[Value]) -> Result<Value> {
        let _operation = self.operation.lock().await;
        if self.busy() {
            bail!("Antigravity 正在运行，请等待或停止后再发送");
        }
        if text.trim().is_empty() && images.is_empty() {
            bail!("消息不能为空");
        }
        if text.len() > 4 * 1024 * 1024 || images.len() > 8 {
            bail!("消息或附件过大");
        }
        let connection = self.transport().await?;
        if !images.is_empty()
            && self.state.lock().unwrap().capabilities["promptCapabilities"]["image"] != true
        {
            bail!("此 ACP 服务不支持图片输入");
        }
        let mut blocks = vec![json!({"type":"text","text":text})];
        let mut total_image_bytes = 0;
        for image in images {
            let mime = image["mimeType"].as_str().context("图片缺少类型")?;
            let data = image["data"].as_str().context("图片缺少内容")?;
            total_image_bytes += data.len();
            if !matches!(
                mime,
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            ) || data.len() > 20 * 1024 * 1024
                || total_image_bytes > 28 * 1024 * 1024
            {
                bail!("不支持的图片或图片过大");
            }
            blocks.push(json!({"type":"image","mimeType":mime,"data":data}));
        }
        let (session, epoch, turn) = {
            let state = self.state.lock().unwrap();
            if state.conversation.session_id.is_empty() {
                bail!("请先创建会话");
            }
            (
                state.conversation.session_id.clone(),
                state.epoch,
                state.turn + 1,
            )
        };
        self.change(|state| { state.busy = true; state.cancelling = false; state.turn = turn; state.conversation.interrupted = true; if let Some(usage)=state.conversation.context_usage.as_mut(){usage["stale"]=json!(true);} state.error.clear(); let message = json!({"_key":Uuid::new_v4().to_string(),"role":"user","content":if images.is_empty() {json!(text)} else {json!(blocks)}}); state.conversation.messages.push(message.clone()); json!({"message":message}) });
        self.save().await;
        let owner = self.clone();
        tokio::spawn(async move {
            let result = connection
                .request(
                    "session/prompt",
                    json!({"sessionId":session,"prompt":blocks}),
                    Duration::from_secs(3600),
                )
                .await;
            {
                let state = owner.state.lock().unwrap();
                if state.epoch != epoch || state.turn != turn {
                    return;
                }
            }
            let _ = owner.cancel_permissions(&connection).await;
            owner.change(|state| {
                state.busy = false;
                state.cancelling = false;
                state.conversation.interrupted = result.is_err();
                if let Err(error) = result {
                    state.error = format!("{error:#}");
                }
                json!({"settled":true})
            });
            owner.save().await;
        });
        Ok(self.status())
    }
    async fn receive(&self, epoch: u64, connection: &Transport, message: Value) {
        if self.state.lock().unwrap().epoch != epoch {
            return;
        }
        let method = message["method"].as_str().unwrap_or_default();
        if method == "session/update" {
            let params = &message["params"];
            if params["sessionId"] != self.state.lock().unwrap().conversation.session_id {
                return;
            }
            self.change(|state| {
                if state.epoch != epoch || params["sessionId"] != state.conversation.session_id {
                    return json!({});
                }
                apply_update(&mut state.conversation, &params["update"])
            });
        } else if method == "session/request_permission" && message.get("id").is_some() {
            let params = message["params"].clone();
            let allowed = {
                let state = self.state.lock().unwrap();
                state.busy
                    && !state.cancelling
                    && params["sessionId"] == state.conversation.session_id
            };
            if allowed {
                let automatic = {
                    let state = self.state.lock().unwrap();
                    if state.epoch != epoch || !state.busy || state.cancelling {
                        None
                    } else {
                        match automatic_permission(&state,&params) {
                            Some((false,outcome))=>Some((false,outcome)),
                            Some((true,outcome)) if connection.writer.try_send(json!({"jsonrpc":"2.0","id":message["id"],"result":{"outcome":outcome}})).is_ok()=>Some((true,outcome)),
                            _=>None,
                        }
                    }
                };
                if let Some((granted, outcome)) = automatic {
                    if !granted {
                        let _=connection.send(json!({"jsonrpc":"2.0","id":message["id"],"result":{"outcome":outcome}})).await;
                    }
                    return;
                }
                let id = Uuid::new_v4().to_string();
                let mut inserted = false;
                self.change(|state| {
                    if state.epoch == epoch
                        && state.busy
                        && !state.cancelling
                        && params["sessionId"] == state.conversation.session_id
                    {
                        inserted = true;
                        state.permissions.insert(
                            id,
                            Permission {
                                rpc_id: message["id"].clone(),
                                params,
                            },
                        );
                    }
                    json!({})
                });
                if !inserted {
                    let _ = connection.send(json!({"jsonrpc":"2.0","id":message["id"],"result":{"outcome":{"outcome":"cancelled"}}})).await;
                }
            } else {
                let _ = connection.send(json!({"jsonrpc":"2.0","id":message["id"],"result":{"outcome":{"outcome":"cancelled"}}})).await;
            }
        } else if message.get("id").is_some() {
            let _ = connection.send(json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Client capability not supported"}})).await;
        }
    }
    pub async fn permission(&self, id: &str, option: Option<&str>) -> Result<Value> {
        let _operation = self.operation.lock().await;
        let connection = self.transport().await?;
        let request = {
            let mut state = self.state.lock().unwrap();
            let request = state.permissions.get(id).context("权限请求已结束")?;
            if let Some(option) = option {
                if !request.params["options"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["optionId"] == option))
                {
                    bail!("无效权限选项");
                }
            }
            state.permissions.remove(id).unwrap()
        };
        let outcome = option
            .map(|option| json!({"outcome":"selected","optionId":option}))
            .unwrap_or_else(|| json!({"outcome":"cancelled"}));
        connection
            .send(json!({"jsonrpc":"2.0","id":request.rpc_id,"result":{"outcome":outcome}}))
            .await?;
        self.change(|_| json!({}));
        Ok(self.status())
    }
    async fn cancel_permissions(&self, connection: &Transport) -> Result<()> {
        let requests = {
            let mut state = self.state.lock().unwrap();
            std::mem::take(&mut state.permissions)
        };
        for (_, request) in requests {
            connection.send(json!({"jsonrpc":"2.0","id":request.rpc_id,"result":{"outcome":{"outcome":"cancelled"}}})).await?;
        }
        self.change(|_| json!({}));
        Ok(())
    }
    pub async fn cancel(self: &Arc<Self>) -> Result<Value> {
        let connection = self.transport().await?;
        self.change(|state| {
            state.cancelling = state.busy;
            json!({})
        });
        self.cancel_permissions(&connection).await?;
        let (session, epoch, turn) = {
            let state = self.state.lock().unwrap();
            (
                state.conversation.session_id.clone(),
                state.epoch,
                state.turn,
            )
        };
        connection
            .notify("session/cancel", json!({"sessionId":session}))
            .await?;
        let owner = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let state = owner.state.lock().unwrap();
            let stalled = state.epoch == epoch && state.turn == turn && state.busy;
            drop(state);
            if stalled {
                connection.fail("取消超时，已结束 Antigravity 进程树");
            }
        });
        Ok(self.status())
    }
    async fn shutdown_inner(&self) {
        let connection = self.connection.lock().await.take();
        if let Some(connection) = connection {
            let _ = self.cancel_permissions(&connection).await;
            connection.fail("Antigravity 已断开");
            let mut exited = connection.exited.clone();
            if !*exited.borrow() {
                let _ = tokio::time::timeout(Duration::from_secs(5), exited.changed()).await;
            }
        }
        self.change(|state| {
            state.epoch += 1;
            state.connected = false;
            state.connecting = false;
            state.busy = false;
            state.cancelling = false;
            state.pid = None;
            state.permissions.clear();
            json!({})
        });
        self.save().await;
    }
    pub async fn shutdown(&self) {
        if let Some(connection) = self.connection.lock().await.as_ref() {
            connection.fail("Antigravity 已断开");
        }
        self.change(|state| {
            state.epoch += 1;
            json!({})
        });
        let _operation = self.operation.lock().await;
        self.shutdown_inner().await;
    }
}

fn has_option(options: &Value, value: &str) -> bool {
    options.as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["value"] == value || has_option(&item["options"], value))
    })
}
fn model_id(conversation: &Conversation) -> &str {
    conversation
        .config_options
        .iter()
        .find(|option| option["category"] == "model" || option["id"] == "model")
        .and_then(|option| option["currentValue"].as_str())
        .unwrap_or_default()
}
fn automatic_permission(state: &State, params: &Value) -> Option<(bool, Value)> {
    let call = &params["toolCall"];
    let kind = call["kind"].as_str().unwrap_or("other");
    let name = call["rawInput"]["toolName"].as_str().unwrap_or(kind);
    let mut paths = call["locations"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["path"].as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(path) = call["rawInput"]["path"]
        .as_str()
        .or_else(|| call["rawInput"]["file_path"].as_str())
    {
        paths.push(path);
    }
    let local = !paths.is_empty()
        && call["rawInput"].get("command").is_none()
        && paths
            .iter()
            .all(|path| crate::permissions::within(Path::new(&state.conversation.cwd), path));
    let reading = matches!(kind, "read" | "search");
    let edit = kind == "edit"
        && call["rawInput"].get("command").is_none()
        && !paths.iter().any(|path| {
            path.split(['/', '\\']).any(|part| {
                matches!(
                    part.to_ascii_lowercase().as_str(),
                    ".git" | ".pi" | ".codex"
                )
            })
        });
    let protected_edit = kind == "edit"
        && paths.iter().any(|target| {
            let target = Path::new(target);
            let target = if target.is_absolute() {
                target.to_owned()
            } else {
                Path::new(&state.conversation.cwd).join(target)
            };
            !state.protected_root.as_os_str().is_empty()
                && crate::permissions::within(&state.protected_root, &target.to_string_lossy())
        });
    let decision = match state.permission_mode {
        PermissionMode::Smart if local && (reading || edit && !protected_edit) => Some(true),
        PermissionMode::Custom => state
            .permission_rules
            .decision(&[name, kind])
            .filter(|allow| !*allow || !protected_edit)
            .or({
                if reading && (local || state.permission_rules.allow_external_reads)
                    || edit
                        && local
                        && !protected_edit
                        && state.permission_rules.allow_workspace_edits
                {
                    Some(true)
                } else {
                    None
                }
            }),
        _ => None,
    }?;
    let option = params["options"]
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item["kind"]
                    == if decision {
                        "allow_once"
                    } else {
                        "reject_once"
                    }
            })
        })
        .and_then(|option| option["optionId"].as_str());
    match (decision, option) {
        (_, Some(option)) => Some((decision, json!({"outcome":"selected","optionId":option}))),
        (false, None) => Some((false, json!({"outcome":"cancelled"}))),
        _ => None,
    }
}
fn assistant(conversation: &mut Conversation) -> &mut Value {
    if conversation
        .messages
        .last()
        .is_none_or(|message| message["role"] != "assistant")
    {
        let model = conversation
            .config_options
            .iter()
            .find(|option| option["category"] == "model" || option["id"] == "model")
            .map(|option| {
                option["options"]
                    .as_array()
                    .and_then(|options| {
                        options
                            .iter()
                            .find(|item| item["value"] == option["currentValue"])
                    })
                    .and_then(|item| item["name"].as_str())
                    .or_else(|| option["currentValue"].as_str())
                    .unwrap_or_default()
                    .to_owned()
            })
            .unwrap_or_default();
        conversation.messages.push(json!({"_key":Uuid::new_v4().to_string(),"role":"assistant","model":model,"content":[]}));
    }
    conversation.messages.last_mut().unwrap()
}
fn apply_update(conversation: &mut Conversation, update: &Value) -> Value {
    match update["sessionUpdate"].as_str().unwrap_or_default() {
        "usage_update" => {
            let mut reported = false;
            if let (Some(used), Some(size)) = (update["used"].as_u64(), update["size"].as_u64()) {
                if size > 0 && size <= 9_007_199_254_740_991 && used <= 9_007_199_254_740_991 {
                    let mut usage = json!({"used":used,"size":size,"stale":false,"modelId":model_id(conversation),"updatedAt":crate::context::now()});
                    if let (Some(amount), Some(currency)) = (
                        update["cost"]["amount"]
                            .as_f64()
                            .filter(|n| n.is_finite() && *n >= 0.0),
                        update["cost"]["currency"].as_str().filter(|s| {
                            s.len() <= 12 && s.chars().all(|c| c.is_ascii_alphabetic())
                        }),
                    ) {
                        usage["cost"] = json!({"amount":amount,"currency":currency});
                    }
                    conversation.context_usage = Some(usage);
                    reported = true;
                }
            }
            if !reported {
                if let Some(usage) = conversation.context_usage.as_mut() {
                    usage["stale"] = json!(true);
                }
            }
            json!({})
        }
        "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" => {
            let user = update["sessionUpdate"] == "user_message_chunk";
            if user
                && conversation
                    .messages
                    .last()
                    .is_none_or(|message| message["role"] != "user")
            {
                conversation
                    .messages
                    .push(json!({"_key":Uuid::new_v4().to_string(),"role":"user","content":[]}));
            }
            let message = if user {
                conversation.messages.last_mut().unwrap()
            } else {
                assistant(conversation)
            };
            if let Some(text) = update["content"]["text"].as_str() {
                let thinking = update["sessionUpdate"] == "agent_thought_chunk";
                let kind = if thinking { "thinking" } else { "text" };
                if !message["content"].is_array() {
                    message["content"] = json!([]);
                }
                let content = message["content"].as_array_mut().unwrap();
                if content.last().is_none_or(|item| item["type"] != kind) {
                    content.push(json!({"type":kind,(kind):""}));
                }
                let block = content.last_mut().unwrap();
                let previous = block[kind].as_str().unwrap_or_default().to_owned();
                block[kind] = json!(previous + text);
            }
            if update["content"]["type"] == "image" && update["content"]["data"].is_string() {
                if let Some(content) = message["content"].as_array_mut() {
                    content.push(update["content"].clone());
                }
            }
            json!({"message":message})
        }
        "tool_call" | "tool_call_update" => {
            let Some(id) = update["toolCallId"].as_str() else {
                return json!({});
            };
            let fresh = !conversation.tools.contains_key(id);
            let tool = conversation
                .tools
                .entry(id.into())
                .or_insert_with(|| json!({"id":id}));
            if let Some(title) = update["title"].as_str() {
                tool["name"] = json!(title);
            }
            if let Some(status) = update["status"].as_str() {
                tool["status"] = json!(match status {
                    "completed" => "done",
                    "failed" => "error",
                    _ => "running",
                });
            }
            if let Some(input) = update.get("rawInput") {
                tool["args"] = input.clone();
            }
            if let Some(content) = update.get("content").and_then(Value::as_array) {
                tool["result"] = json!({"content":content.iter().filter_map(|item| item.get("content")).filter(|item| item["type"]=="text").cloned().collect::<Vec<_>>()});
            }
            let tool = tool.clone();
            if fresh {
                assistant(conversation)["content"].as_array_mut().unwrap().push(json!({"type":"toolCall","id":id,"name":tool["name"],"arguments":tool["args"]}));
            }
            json!({"message":conversation.messages.last(),"tool":tool,"toolId":id})
        }
        "config_option_update" => {
            let previous = model_id(conversation).to_owned();
            if let Some(options) = update["configOptions"].as_array() {
                conversation.config_options = options.clone();
            }
            if previous != model_id(conversation) {
                conversation.context_usage = None;
            }
            json!({})
        }
        _ => json!({}),
    }
}

async fn apply_proxy(command: &mut Command) {
    #[cfg(windows)]
    {
        async fn registry(name: &str) -> Option<String> {
            let mut command = Command::new(
                std::env::var_os("SystemRoot")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("C:\\Windows"))
                    .join("System32/reg.exe"),
            );
            command.args([
                "query",
                "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                "/v",
                name,
            ]);
            hide_console(&mut command);
            let output = tokio::time::timeout(Duration::from_secs(3), command.output())
                .await
                .ok()?
                .ok()?;
            if !output.status.success() {
                return None;
            }
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| {
                    line.split_once("REG_SZ")
                        .or_else(|| line.split_once("REG_DWORD"))
                        .map(|(_, value)| value.trim().to_owned())
                })
        }
        if registry("ProxyEnable").await.as_deref() == Some("0x1") {
            if let Some(proxy) = registry("ProxyServer")
                .await
                .and_then(|value| proxy_address(&value))
            {
                command
                    .env("HTTP_PROXY", &proxy)
                    .env("HTTPS_PROXY", &proxy)
                    .env("http_proxy", &proxy)
                    .env("https_proxy", &proxy);
            }
        }
    }
    let previous = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    let bypass = format!("{previous},localhost,127.0.0.1,::1");
    command.env("NO_PROXY", &bypass).env("no_proxy", bypass);
}
fn proxy_address(value: &str) -> Option<String> {
    let address = if value.contains('=') {
        let pairs = value
            .split(';')
            .filter_map(|part| part.split_once('='))
            .collect::<BTreeMap<_, _>>();
        pairs
            .get("https")
            .or_else(|| pairs.get("http"))?
            .trim()
            .to_owned()
    } else {
        value.trim().to_owned()
    };
    let address = if address.contains("://") {
        address
    } else {
        format!("http://{address}")
    };
    let url = url::Url::parse(&address).ok()?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h") || url.host_str().is_none()
    {
        return None;
    }
    Some(address)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn usage_updates_track_context_not_billing_and_reset_on_model_change() {
        let mut conversation = Conversation {
            config_options: vec![json!({"id":"model","category":"model","currentValue":"model-a"})],
            ..Default::default()
        };
        apply_update(
            &mut conversation,
            &json!({"sessionUpdate":"usage_update","used":364000,"size":828000,"cost":{"amount":0.2,"currency":"USD"}}),
        );
        assert_eq!(conversation.context_usage.as_ref().unwrap()["used"], 364000);
        assert_eq!(
            conversation.context_usage.as_ref().unwrap()["modelId"],
            "model-a"
        );
        apply_update(
            &mut conversation,
            &json!({"sessionUpdate":"usage_update","used":-1,"size":0}),
        );
        assert_eq!(conversation.context_usage.as_ref().unwrap()["used"], 364000);
        assert_eq!(conversation.context_usage.as_ref().unwrap()["stale"], true);
        apply_update(
            &mut conversation,
            &json!({"sessionUpdate":"config_option_update","configOptions":[{"id":"model","category":"model","currentValue":"model-b"}]}),
        );
        assert!(conversation.context_usage.is_none());
        apply_update(
            &mut conversation,
            &json!({"sessionUpdate":"usage_update","used":0,"size":200000}),
        );
        assert_eq!(conversation.context_usage.as_ref().unwrap()["used"], 0);
    }
    #[test]
    fn automatic_approval_is_scoped_and_never_chooses_allow_always() {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let mut state = State {
            permission_mode: PermissionMode::Smart,
            conversation: Conversation {
                cwd: work.to_string_lossy().into_owned(),
                ..Default::default()
            },
            ..Default::default()
        };
        let mut request = json!({"toolCall":{"kind":"edit","rawInput":{"path":"new.txt"}},"options":[{"kind":"allow_once","optionId":"allow"},{"kind":"reject_once","optionId":"reject"}]});
        assert!(automatic_permission(&state, &request).unwrap().0);
        request["toolCall"]["rawInput"]["path"] = json!("../outside.txt");
        assert!(automatic_permission(&state, &request).is_none());
        request["toolCall"]["rawInput"]["path"] = json!("new.txt");
        request["options"] = json!([{"kind":"allow_always","optionId":"broad"}]);
        assert!(automatic_permission(&state, &request).is_none());
        state.permission_mode = PermissionMode::Custom;
        state.permission_rules.deny_tools = vec!["edit".into()];
        assert_eq!(
            automatic_permission(&state, &request).unwrap().1["outcome"],
            "cancelled"
        );
    }
    #[tokio::test]
    async fn request_timeout_is_distinct_from_an_agent_rejection() {
        let (writer, _reader) = mpsc::channel(2);
        let (stop, _) = watch::channel(false);
        let (_, exited) = watch::channel(false);
        let transport = Transport {
            writer,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            stop,
            exited,
            pid: 0,
        };
        let error = transport
            .request(
                "session/set_config_option",
                json!({}),
                Duration::from_millis(20),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<RequestFailure>(),
            Some(RequestFailure::Timeout)
        ));
        assert!(transport.pending.lock().unwrap().is_empty());
    }
    #[test]
    fn proxy_formats_and_permission_values() {
        assert_eq!(
            proxy_address("127.0.0.1:7892").as_deref(),
            Some("http://127.0.0.1:7892")
        );
        assert_eq!(
            proxy_address("http=localhost:8080;https=localhost:7892").as_deref(),
            Some("http://localhost:7892")
        );
        assert!(proxy_address("file:///secret").is_none());
        assert!(has_option(&json!([{"options":[{"value":"high"}]}]), "high"));
        assert!(!has_option(&json!([{"value":"high"}]), "invalid"));
    }
    #[test]
    fn ordered_unicode_chunks_and_tool_updates() {
        let mut c = Conversation::default();
        for text in ["中文", "🙂"] {
            apply_update(
                &mut c,
                &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
            );
        }
        assert_eq!(c.messages[0]["content"][0]["text"], "中文🙂");
        apply_update(
            &mut c,
            &json!({"sessionUpdate":"tool_call","toolCallId":"read","title":"读取文件","status":"in_progress","rawInput":{"path":"README.md"}}),
        );
        apply_update(
            &mut c,
            &json!({"sessionUpdate":"tool_call_update","toolCallId":"read","status":"completed","content":[{"type":"content","content":{"type":"text","text":"完整结果"}}]}),
        );
        assert_eq!(c.tools["read"]["status"], "done");
        assert_eq!(c.messages.len(), 1);
    }
}
