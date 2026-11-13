//! 桌面端自己的 MCP 客户端（路线图 P1.2）。
//!
//! 与 mcp.rs 的区别：mcp.rs 解析 Pi 内置 /mcp 命令的文本输出（Pi 视角）；
//! 这里由桌面进程直接按 MCP 协议连接服务器，拿到结构化的工具清单并可以调用。
//! 服务器定义沿用 Pi 的 mcp.json（mcpServers 结构），因此两边看到的是同一份配置。
//!
//! 传输：stdio JSONL；Streamable HTTP 通过系统 curl.exe 管理会话与 SSE。
//! 不引入新的第三方依赖。请求有超时，HTTP 通知流在断开或析构时终止。

use crate::mcp_http::{HttpTransport, Notification};
use crate::mcp_subscriptions::{ResourceEvent, Subscriptions};
use crate::rpc::{hide_console, JsonLines};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
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
    process::{Child, ChildStdin, Command},
    sync::{broadcast, mpsc, oneshot, Mutex as AsyncMutex},
};

/// 与 Codex / DSH 对齐的协议版本。
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// 单个请求的默认超时（秒）；服务器可用 timeout 字段覆盖工具调用超时。
pub const DEFAULT_TIMEOUT_SECS: u64 = 60;
const HANDSHAKE_TIMEOUT_SECS: u64 = 30;
const MAX_STDERR: usize = 8 * 1024;
const MAX_DESCRIPTION: usize = 400;
const MAX_SCHEMA: usize = 8000;
const MAX_RESULT: usize = 256 * 1024;

#[derive(Debug)]
pub(crate) struct ServerRequestError(String);
impl std::fmt::Display for ServerRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for ServerRequestError {}

fn default_enabled() -> bool {
    true
}

/// mcp.json 中的一个服务器定义。stdio 用 command/args/env，HTTP 用 url/headers。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// mcp.json 的键；反序列化原始条目时由调用方补上。
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub exposure: Option<String>,
}

impl ServerConfig {
    /// 传输类型：stdio / http / invalid（既没有 command 也没有 url）。
    pub fn transport(&self) -> &'static str {
        match (&self.command, &self.url) {
            (Some(command), _) if !command.trim().is_empty() => "stdio",
            (_, Some(url)) if !url.trim().is_empty() => "http",
            _ => "invalid",
        }
    }

    fn tool_timeout(&self) -> Duration {
        Duration::from_secs(self.timeout.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, 3600))
    }
}

/// 展开 PLACEHOLDER_NAME 形式的环境变量引用；缺失的名字记录到 missing。
pub fn expand_env(value: &str, missing: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' && index + 1 < bytes.len() && bytes[index + 1] == b'{' {
            if let Some(end) = value[index + 2..].find('}') {
                let name = &value[index + 2..index + 2 + end];
                match std::env::var(name) {
                    Ok(found) => out.push_str(&found),
                    Err(_) => {
                        if !missing.iter().any(|value| value == name) {
                            missing.push(name.to_owned());
                        }
                        out.push_str(&value[index..index + 2 + end + 1]);
                    }
                }
                index += 2 + end + 1;
                continue;
            }
        }
        let ch = value[index..].chars().next().unwrap_or_default();
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

/// 读取 mcp.json 并返回可直接给界面用的服务器列表。
pub fn load_servers(agent_dir: &Path) -> Value {
    let path = agent_dir.join("mcp.json");
    let mut warnings: Vec<String> = Vec::new();
    let Ok(text) = fs::read_to_string(&path) else {
        return json!({
            "path": path.to_string_lossy(),
            "exists": false,
            "servers": [],
            "warnings": ["未找到 mcp.json"],
        });
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "path": path.to_string_lossy(),
                "exists": true,
                "servers": [],
                "warnings": [format!("mcp.json 不是合法 JSON：{error}")],
            });
        }
    };
    let mut servers = Vec::new();
    if let Some(map) = parsed.get("mcpServers").and_then(|value| value.as_object()) {
        for (name, raw) in map {
            let mut missing: Vec<String> = Vec::new();
            let command = raw
                .get("command")
                .and_then(|value| value.as_str())
                .map(|value| expand_env(value, &mut missing));
            let args: Vec<String> = raw
                .get("args")
                .and_then(|value| value.as_array())
                .map(|values| {
                    values
                        .iter()
                        .map(|value| expand_env(value.as_str().unwrap_or_default(), &mut missing))
                        .collect()
                })
                .unwrap_or_default();
            let env: BTreeMap<String, String> = raw
                .get("env")
                .and_then(|value| value.as_object())
                .map(|values| {
                    values
                        .iter()
                        .map(|(key, value)| {
                            (
                                key.clone(),
                                expand_env(value.as_str().unwrap_or_default(), &mut missing),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let url = raw
                .get("url")
                .and_then(|value| value.as_str())
                .map(|value| expand_env(value, &mut missing));
            let headers: BTreeMap<String, String> = raw
                .get("headers")
                .and_then(|value| value.as_object())
                .map(|values| {
                    values
                        .iter()
                        .map(|(key, value)| {
                            (
                                key.clone(),
                                expand_env(value.as_str().unwrap_or_default(), &mut missing),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let config = ServerConfig {
                name: name.clone(),
                command,
                args,
                env,
                url,
                headers,
                enabled: raw
                    .get("enabled")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(true),
                timeout: raw.get("timeout").and_then(|value| value.as_u64()),
                exposure: raw
                    .get("exposure")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned),
            };
            if config.transport() == "invalid" {
                warnings.push(format!("{name}：既没有 command 也没有 url，已跳过"));
            }
            if !missing.is_empty() {
                warnings.push(format!("{name}：缺少环境变量 {}", missing.join("、")));
            }
            servers.push(json!({
                "name": config.name,
                "transport": config.transport(),
                "command": config.command,
                "url": config.url,
                "enabled": config.enabled,
                "timeout": config.timeout,
                "exposure": config.exposure,
                "envKeys": config.env.keys().cloned().collect::<Vec<_>>(),
                "headerKeys": config.headers.keys().cloned().collect::<Vec<_>>(),
                "missingEnv": missing,
            }));
        }
    } else {
        warnings.push("mcp.json 缺少 mcpServers 对象".into());
    }
    servers.sort_by(|left, right| {
        left["name"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["name"].as_str().unwrap_or_default())
    });
    json!({
        "path": path.to_string_lossy(),
        "exists": true,
        "servers": servers,
        "warnings": warnings,
    })
}

/// 读取单个服务器的完整定义（含 env / headers），并展开环境变量。
pub fn find_server(agent_dir: &Path, name: &str) -> Result<ServerConfig> {
    let text = fs::read_to_string(agent_dir.join("mcp.json")).context("无法读取 mcp.json")?;
    let parsed: Value = serde_json::from_str(&text).context("mcp.json 不是合法 JSON")?;
    let raw = parsed
        .get("mcpServers")
        .and_then(|value| value.as_object())
        .and_then(|map| map.get(name))
        .with_context(|| format!("mcp.json 中没有名为 {name} 的服务器"))?;
    let config: ServerConfig = serde_json::from_value(raw.clone()).context("服务器定义格式无效")?;
    let mut missing = Vec::new();
    let mut config = ServerConfig {
        name: name.to_owned(),
        ..config
    };
    config.command = config.command.map(|value| expand_env(&value, &mut missing));
    config.args = config
        .args
        .iter()
        .map(|value| expand_env(value, &mut missing))
        .collect();
    config.env = config
        .env
        .iter()
        .map(|(key, value)| (key.clone(), expand_env(value, &mut missing)))
        .collect();
    config.url = config.url.map(|value| expand_env(&value, &mut missing));
    config.headers = config
        .headers
        .iter()
        .map(|(key, value)| (key.clone(), expand_env(value, &mut missing)))
        .collect();
    Ok(config)
}

// ---------------------------------------------------------------- 会话

/// 一次已建立的 MCP 连接；HTTP 保留会话标识和通知流。
pub struct McpSession {
    pub name: String,
    transport: &'static str,
    /// (serverInfo, protocolVersion)：握手完成后写入。
    handshake: Mutex<(Value, String)>,
    tools: AsyncMutex<(u64, Vec<Value>)>,
    tools_revision: Arc<AtomicU64>,
    closed: AtomicBool,
    http: Option<Arc<HttpTransport>>,
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    stderr: Mutex<String>,
    config: ServerConfig,
    capabilities: Mutex<Value>,
    pub(crate) subscriptions: Subscriptions,
    pub(crate) resource_events: broadcast::Sender<ResourceEvent>,
    runtime: tokio::runtime::Handle,
}

impl Drop for McpSession {
    fn drop(&mut self) {
        if let Some(http) = &self.http {
            http.stop();
        }
        // 尽力终止子进程：不依赖调用方记得断开。
        if let Ok(mut child) = self.child.try_lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
    }
}

impl McpSession {
    /// 建立连接：stdio 启动子进程并完成 initialize；HTTP 直接握手。
    pub async fn connect(config: ServerConfig) -> Result<Arc<Self>> {
        match config.transport() {
            "stdio" => Self::connect_stdio(config).await,
            "http" => Self::connect_http(config).await,
            _ => bail!("{}：既没有 command 也没有 url", config.name),
        }
    }

    async fn connect_stdio(config: ServerConfig) -> Result<Arc<Self>> {
        let command_line = config.command.clone().context("缺少 command")?;
        let mut command = Command::new(&command_line);
        command
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &config.env {
            command.env(key, value);
        }
        hide_console(&mut command);
        let mut child = command
            .spawn()
            .with_context(|| format!("无法启动 {command_line}"))?;
        let stdin = child.stdin.take().context("子进程 stdin 不可用")?;
        let mut stdout = child.stdout.take().context("子进程 stdout 不可用")?;
        let mut stderr = child.stderr.take().context("子进程 stderr 不可用")?;

        let session = Arc::new(Self {
            name: config.name.clone(),
            transport: "stdio",
            handshake: Mutex::new((Value::Null, PROTOCOL_VERSION.to_owned())),
            tools: AsyncMutex::new((u64::MAX, Vec::new())),
            tools_revision: Arc::new(AtomicU64::new(0)),
            closed: AtomicBool::new(false),
            http: None,
            child: AsyncMutex::new(Some(child)),
            stdin: AsyncMutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            stderr: Mutex::new(String::new()),
            capabilities: Mutex::new(json!({})),
            subscriptions: Subscriptions::default(),
            resource_events: broadcast::channel(128).0,
            runtime: tokio::runtime::Handle::current(),
            config,
        });

        let (line_tx, mut line_rx) = mpsc::channel::<Value>(256);
        tokio::spawn(async move {
            let mut parser = JsonLines::default();
            let mut buffer = vec![0_u8; 32 * 1024];
            loop {
                match stdout.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(count) => match parser.push(&buffer[..count]) {
                        Ok(messages) => {
                            for message in messages {
                                if line_tx.send(message).await.is_err() {
                                    return;
                                }
                            }
                        }
                        Err(_) => break,
                    },
                    Err(_) => break,
                }
            }
        });
        // stderr 只保留尾部，用于连接失败时给出可读原因。
        let stderr_session = session.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0_u8; 4096];
            let mut collected = String::new();
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(count) => {
                        collected.push_str(&String::from_utf8_lossy(&buffer[..count]));
                        if collected.len() > MAX_STDERR {
                            let keep = collected.len() - MAX_STDERR;
                            collected.drain(..keep);
                        }
                        if let Ok(mut slot) = stderr_session.stderr.lock() {
                            *slot = collected.clone();
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        // 把响应派发给等待者。
        let dispatch_session = session.clone();
        tokio::spawn(async move {
            while let Some(message) = line_rx.recv().await {
                dispatch_session.notification_handler()(message.clone());
                if let Some(id) = message.get("id").and_then(|value| value.as_u64()) {
                    let waiter = dispatch_session.pending.lock().unwrap().remove(&id);
                    if let Some(waiter) = waiter {
                        let _ = waiter.send(message);
                    }
                }
            }
            dispatch_session.closed.store(true, Ordering::SeqCst);
            dispatch_session.pending.lock().unwrap().clear();
            dispatch_session.subscriptions.clear();
            let _ = dispatch_session.resource_events.send(ResourceEvent::Closed);
        });

        let response = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": crate::mcp_app_host::client_capabilities(),
                    "clientInfo": { "name": "pi-desktop", "version": env!("CARGO_PKG_VERSION") },
                }),
                Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
            )
            .await?;
        session.notify("notifications/initialized", json!({})).await;
        // request() 已经取出 result，这里直接读它的字段。
        let info = response["serverInfo"].clone();
        let protocol = response["protocolVersion"]
            .as_str()
            .unwrap_or(PROTOCOL_VERSION)
            .to_owned();
        session.set_handshake(info, protocol);
        *session.capabilities.lock().unwrap() = response["capabilities"].clone();
        Ok(session)
    }

    fn set_handshake(&self, info: Value, protocol: String) {
        if let Ok(mut slot) = self.handshake.lock() {
            *slot = (info, protocol);
        }
    }

    /// 服务器自报信息（握手前为 null）。
    pub fn server_info(&self) -> Value {
        self.handshake
            .lock()
            .map(|value| value.0.clone())
            .unwrap_or(Value::Null)
    }

    /// 协商到的协议版本。
    pub fn protocol(&self) -> String {
        self.handshake
            .lock()
            .map(|value| value.1.clone())
            .unwrap_or_else(|_| PROTOCOL_VERSION.to_owned())
    }

    async fn connect_http(config: ServerConfig) -> Result<Arc<Self>> {
        let http = HttpTransport::new(
            config.url.as_deref().context("缺少 url")?,
            config.headers.clone(),
        )?;
        let session = Arc::new(Self {
            name: config.name.clone(),
            transport: "http",
            handshake: Mutex::new((Value::Null, PROTOCOL_VERSION.to_owned())),
            tools: AsyncMutex::new((u64::MAX, Vec::new())),
            tools_revision: Arc::new(AtomicU64::new(0)),
            closed: AtomicBool::new(false),
            http: Some(http.clone()),
            child: AsyncMutex::new(None),
            stdin: AsyncMutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            stderr: Mutex::new(String::new()),
            capabilities: Mutex::new(json!({})),
            subscriptions: Subscriptions::default(),
            resource_events: broadcast::channel(128).0,
            runtime: tokio::runtime::Handle::current(),
            config,
        });
        let response = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": crate::mcp_app_host::client_capabilities(),
                    "clientInfo": { "name": "pi-desktop", "version": env!("CARGO_PKG_VERSION") },
                }),
                Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
            )
            .await?;
        session.set_handshake(
            response["serverInfo"].clone(),
            response["protocolVersion"]
                .as_str()
                .unwrap_or(PROTOCOL_VERSION)
                .to_owned(),
        );
        *session.capabilities.lock().unwrap() = response["capabilities"].clone();
        http.set_protocol(&session.protocol())?;
        http.post(
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
            &session.notification_handler(),
        )
        .await?;
        http.listen(session.notification_handler());
        Ok(session)
    }

    fn notification_handler(&self) -> Notification {
        let revision = self.tools_revision.clone();
        let events = self.resource_events.clone();
        let http = self.http.as_ref().map(Arc::downgrade);
        Arc::new(move |message| {
            if message.get("id").is_none()
                && message["method"] == "notifications/tools/list_changed"
            {
                revision.fetch_add(1, Ordering::SeqCst);
            }
            if http
                .as_ref()
                .and_then(std::sync::Weak::upgrade)
                .is_some_and(|http| !http.connected())
            {
                let _ = events.send(ResourceEvent::Closed);
                return;
            }
            if message["jsonrpc"] != "2.0" || message.get("id").is_some() {
                return;
            }
            match message["method"].as_str() {
                Some("notifications/resources/list_changed") => {
                    let _ = events.send(ResourceEvent::ListChanged);
                }
                Some("notifications/resources/updated") => {
                    if let Some(uri) = message["params"]["uri"]
                        .as_str()
                        .filter(|uri| crate::mcp_subscriptions::validate_uri(uri).is_ok())
                    {
                        let _ = events.send(ResourceEvent::Updated(uri.to_owned()));
                    }
                }
                _ => {}
            }
        })
    }

    pub(crate) fn resource_capabilities(&self) -> Value {
        self.capabilities.lock().unwrap()["resources"].clone()
    }

    pub(crate) async fn resource_control(
        &self,
        method: &str,
        uri: &str,
        permit: Option<&AtomicBool>,
        timeout: Option<Duration>,
    ) -> Result<()> {
        if self.resource_capabilities()["subscribe"] != true {
            bail!("服务器未声明资源订阅能力");
        }
        let duration = timeout.map_or(self.config.tool_timeout(), |timeout| {
            timeout.min(self.config.tool_timeout())
        });
        let result = self
            .request_guarded(method, json!({"uri":uri}), duration, permit)
            .await?;
        if !result.is_object() || serde_json::to_vec(&result)?.len() > MAX_RESULT {
            bail!("资源订阅响应格式无效或超限");
        }
        Ok(())
    }

    pub(crate) fn release_resource_owner(
        self: &Arc<Self>,
        owner: String,
        completed: impl FnOnce(Result<()>) + Send + 'static,
    ) {
        let session = self.clone();
        self.runtime.spawn(async move {
            completed(session.subscriptions.release(&session, &owner).await);
        });
    }

    pub(crate) fn connected(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
            && self.http.as_ref().is_none_or(|http| http.connected())
    }

    fn take_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// 发送请求并等待对应 id 的响应。
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        self.request_guarded(method, params, timeout, None).await
    }

    async fn request_guarded(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        permit: Option<&AtomicBool>,
    ) -> Result<Value> {
        if !self.connected() {
            bail!("MCP 连接已断开");
        }
        let id = self.take_id();
        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Some(http) = &self.http {
            let message = http
                .post_guarded(&payload, timeout, &self.notification_handler(), permit)
                .await?;
            if let Some(error) = message.get("error") {
                return Err(ServerRequestError(format!(
                    "{}：{}",
                    method,
                    truncate(&error.to_string(), 400)
                ))
                .into());
            }
            return Ok(message["result"].clone());
        }
        let (tx, rx) = oneshot::channel();
        let deadline = tokio::time::Instant::now() + timeout;
        self.pending.lock().unwrap().insert(id, tx);
        match tokio::time::timeout_at(deadline, self.write_stdio_guarded(&payload, permit)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                self.pending.lock().unwrap().remove(&id);
                return Err(error);
            }
            Err(_) => {
                // A partial JSONL write cannot be reused by a later request.
                self.shutdown().await;
                bail!("{method} 写入超时，MCP 连接已关闭");
            }
        }
        match tokio::time::timeout_at(deadline, rx).await {
            Ok(Ok(message)) => {
                if let Some(error) = message.get("error") {
                    return Err(ServerRequestError(format!(
                        "{}：{}",
                        method,
                        truncate(&error.to_string(), 400)
                    ))
                    .into());
                }
                Ok(message["result"].clone())
            }
            Ok(Err(_)) => bail!("{method} 的连接已断开{}", self.stderr_suffix()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                bail!(
                    "{method} 超时（{} 秒）{}",
                    timeout.as_secs(),
                    self.stderr_suffix()
                )
            }
        }
    }

    async fn write_stdio(&self, payload: &Value) -> Result<()> {
        self.write_stdio_guarded(payload, None).await
    }

    async fn write_stdio_guarded(
        &self,
        payload: &Value,
        permit: Option<&AtomicBool>,
    ) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        if !self.connected() {
            bail!("MCP 连接已断开");
        }
        let stdin = guard.as_mut().context("连接已关闭")?;
        let mut line = serde_json::to_vec(payload)?;
        line.push(b'\n');
        // Commit under the writer lock. Revoked queued calls never reach stdin;
        // an already committed write must finish to preserve JSONL framing.
        if permit.is_some_and(|permit| !permit.load(Ordering::SeqCst)) {
            bail!("App 已关闭");
        }
        stdin.write_all(&line).await.context("写入子进程失败")?;
        stdin.flush().await.context("刷新子进程输入失败")?;
        Ok(())
    }

    async fn notify(&self, method: &str, params: Value) {
        if self.transport != "stdio" {
            return;
        }
        let payload = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.write_stdio(&payload).await;
    }

    fn stderr_suffix(&self) -> String {
        let text = self
            .stderr
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        let text = text.trim();
        if text.is_empty() {
            String::new()
        } else {
            format!("；stderr: {}", truncate(text, 300))
        }
    }

    /// 发现工具；refresh 为 false 时使用缓存。
    pub async fn list_tools(&self, refresh: bool) -> Result<Vec<Value>> {
        if !self.connected() {
            bail!("MCP HTTP 会话已关闭或过期，请断开后重新连接");
        }
        let revision = self.tools_revision.load(Ordering::SeqCst);
        if !refresh {
            let cached = self.tools.lock().await;
            if cached.0 == revision {
                return Ok(cached.1.clone());
            }
        }
        let result = self
            .request("tools/list", json!({}), self.config.tool_timeout())
            .await?;
        let tools: Vec<Value> = result
            .get("tools")
            .and_then(|value| value.as_array())
            .map(|values| values.iter().map(project_tool).collect())
            .unwrap_or_default();
        *self.tools.lock().await = (revision, tools.clone());
        Ok(tools)
    }

    /// 调用工具。isError 结果原样返回给调用方判断，不在这里抛错。
    pub async fn call_tool(&self, tool: &str, arguments: Value) -> Result<Value> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
                self.config.tool_timeout(),
            )
            .await?;
        Ok(bound_result(result))
    }

    pub(crate) async fn call_app_tool(
        &self,
        tool: &str,
        arguments: Value,
        permit: &AtomicBool,
    ) -> Result<Value> {
        let result = self
            .request_guarded(
                "tools/call",
                json!({"name":tool,"arguments":arguments}),
                self.config.tool_timeout(),
                Some(permit),
            )
            .await?;
        Ok(bound_result(result))
    }

    pub(crate) async fn read_app_resource(&self, uri: &str) -> Result<Value> {
        if !self.capabilities.lock().unwrap()["resources"].is_object() {
            bail!("服务器未声明 resources 能力");
        }
        let result = self
            .request(
                "resources/read",
                json!({"uri":uri}),
                self.config.tool_timeout(),
            )
            .await?;
        if serde_json::to_vec(&result)?.len() > 3 * 1024 * 1024 {
            bail!("App 资源响应超过 3 MiB");
        }
        Ok(result)
    }

    pub(crate) async fn app_tools(&self) -> Result<Vec<Value>> {
        let result = self
            .request("tools/list", json!({}), self.config.tool_timeout())
            .await?;
        if serde_json::to_vec(&result)?.len() > 4 * 1024 * 1024 {
            bail!("App 工具目录超过 4 MiB");
        }
        let tools = result["tools"].as_array().context("App 工具目录格式无效")?;
        if tools.iter().any(|tool| {
            !tool["name"].as_str().is_some_and(|name| !name.is_empty())
                || !tool["inputSchema"].is_object()
        }) {
            bail!("App 工具定义无效");
        }
        Ok(tools.clone())
    }

    pub(crate) async fn content_request(
        &self,
        capability: &str,
        method: &str,
        params: Value,
        permit: Option<&AtomicBool>,
    ) -> Result<Value> {
        if !self.capabilities.lock().unwrap()[capability].is_object() {
            bail!("服务器未声明 {capability} 能力");
        }
        let result = self
            .request_guarded(method, params, self.config.tool_timeout(), permit)
            .await?;
        // 不截断结构化内容：URI、分页游标和 base64 都必须保持完整。
        if serde_json::to_vec(&result)?.len() > MAX_RESULT {
            bail!("{method} 结果超过 256 KiB 展示上限，请缩小资源或目录页");
        }
        Ok(result)
    }

    /// 关闭连接并等待子进程退出。
    pub async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.subscriptions.clear();
        let _ = self.resource_events.send(ResourceEvent::Closed);
        self.pending.lock().unwrap().clear();
        if let Some(http) = &self.http {
            http.shutdown().await;
            return;
        }
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
        guard.take();
        // Killing the peer first breaks a blocked pipe writer before taking its lock.
        self.stdin.lock().await.take();
    }

    /// 给界面用的会话摘要。
    pub fn summary(&self) -> Value {
        json!({
            "name": self.name,
            "transport": self.transport,
            "connected": self.connected(),
            "serverInfo": self.server_info(),
            "protocolVersion": self.protocol(),
            "capabilities": self.capabilities.lock().unwrap().clone(),
            "toolCount": self.tools.try_lock().map(|value| value.1.len()).unwrap_or(0),
        })
    }
}

/// 只保留界面需要的字段，并限制长度。
fn project_tool(tool: &Value) -> Value {
    let schema = tool
        .get("inputSchema")
        .map(|value| truncate(&value.to_string(), MAX_SCHEMA))
        .unwrap_or_else(|| "{}".to_owned());
    let required: Vec<String> = tool
        .get("inputSchema")
        .and_then(|value| value.get("required"))
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "name": tool.get("name").and_then(|value| value.as_str()).unwrap_or_default(),
        "description": truncate(
            tool.get("description").and_then(|value| value.as_str()).unwrap_or_default(),
            MAX_DESCRIPTION,
        ),
        "required": required,
        "inputSchema": schema,
        "_meta": {
            "ui": tool["_meta"]["ui"],
            "ui/resourceUri": tool["_meta"]["ui/resourceUri"],
        },
    })
}

fn bound_result(result: Value) -> Value {
    let text = result.to_string();
    if text.len() <= MAX_RESULT {
        return result;
    }
    json!({
        "content": [{ "type": "text", "text": truncate(&text, MAX_RESULT) }],
        "isError": false,
        "truncated": true,
    })
}

fn truncate(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（已截断）", &value[..end])
}

// ---------------------------------------------------------------- 管理器

/// 持有所有活动会话；命令层通过它连接、列工具、调用与断开。
pub struct McpManager {
    agent_dir: PathBuf,
    sessions: AsyncMutex<HashMap<String, Arc<McpSession>>>,
}

impl McpManager {
    pub fn new(agent_dir: PathBuf) -> Self {
        Self {
            agent_dir,
            sessions: AsyncMutex::new(HashMap::new()),
        }
    }

    /// 服务器定义 + 当前连接状态。
    pub async fn list(&self) -> Value {
        let mut listing = load_servers(&self.agent_dir);
        let sessions = self.sessions.lock().await;
        if let Some(servers) = listing["servers"].as_array_mut() {
            for server in servers.iter_mut() {
                let name = server["name"].as_str().unwrap_or_default().to_owned();
                match sessions.get(&name) {
                    Some(session) => {
                        server["connected"] = json!(session.connected());
                        server["serverInfo"] = session.server_info();
                        server["capabilities"] = session.capabilities.lock().unwrap().clone();
                        server["toolCount"] = json!(session
                            .tools
                            .try_lock()
                            .map(|value| value.1.len())
                            .unwrap_or(0));
                    }
                    None => {
                        server["connected"] = json!(false);
                        server["toolCount"] = json!(0);
                    }
                }
            }
        }
        listing["connectedCount"] = json!(sessions
            .values()
            .filter(|session| session.connected())
            .count());
        listing
    }

    async fn session(&self, name: &str) -> Result<Arc<McpSession>> {
        // Serialize creation with disconnect: a completed disconnect must not be
        // followed by an older handshake inserting a fresh live session.
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(name) {
            if session.connected() {
                return Ok(session.clone());
            }
        }
        // A new user action may reconnect; never replay the failed tool call.
        if let Some(session) = sessions.remove(name) {
            session.shutdown().await;
        }
        let config = find_server(&self.agent_dir, name)?;
        let session = McpSession::connect(config).await?;
        sessions.insert(name.to_owned(), session.clone());
        Ok(session)
    }

    /// 只建立连接；能力枚举由调用方独立请求。
    pub async fn connect(&self, name: &str) -> Result<Value> {
        let session = self.session(name).await?;
        Ok(json!({ "server": session.summary() }))
    }

    pub(crate) async fn app_session(&self, name: &str) -> Result<Arc<McpSession>> {
        self.session(name).await
    }

    pub async fn tools(&self, name: &str, refresh: bool) -> Result<Value> {
        let session = self.session(name).await?;
        let tools = session.list_tools(refresh).await?;
        Ok(json!({ "server": session.summary(), "tools": tools }))
    }

    pub async fn call(&self, name: &str, tool: &str, arguments: Value) -> Result<Value> {
        if !arguments.is_object() {
            bail!("工具参数必须是 JSON 对象");
        }
        let session = self.session(name).await?;
        let result = session.call_tool(tool, arguments).await?;
        Ok(json!({ "server": name, "tool": tool, "result": result }))
    }

    /// 单页内容目录。游标原样传递，不缓存，避免展示陈旧目录。
    pub async fn content_list(
        &self,
        name: &str,
        kind: &str,
        cursor: Option<&str>,
    ) -> Result<Value> {
        let (capability, method, field) = match kind {
            "resources" => ("resources", "resources/list", "resources"),
            "templates" => ("resources", "resources/templates/list", "resourceTemplates"),
            "prompts" => ("prompts", "prompts/list", "prompts"),
            _ => bail!("未知 MCP 目录类型"),
        };
        let session = self.session(name).await?;
        let params = cursor.map_or_else(|| json!({}), |cursor| json!({"cursor": cursor}));
        let result = session
            .content_request(capability, method, params, None)
            .await?;
        if !result[field].is_array() {
            bail!("{method} 返回缺少 {field} 数组");
        }
        if result
            .get("nextCursor")
            .is_some_and(|value| !value.is_string())
        {
            bail!("{method} 返回无效 nextCursor");
        }
        let mut response = json!({"server": session.summary(), (field): result[field]});
        if let Some(cursor) = result.get("nextCursor") {
            response["nextCursor"] = cursor.clone();
        }
        Ok(response)
    }

    pub async fn read_resource(&self, name: &str, uri: &str) -> Result<Value> {
        if uri.trim().is_empty() {
            bail!("资源 URI 不能为空");
        }
        let session = self.session(name).await?;
        let result = session
            .content_request("resources", "resources/read", json!({"uri": uri}), None)
            .await?;
        if !result["contents"].is_array() {
            bail!("resources/read 返回缺少 contents 数组");
        }
        Ok(json!({"server": name, "uri": uri, "result": result}))
    }

    pub async fn get_prompt(&self, name: &str, prompt: &str, arguments: Value) -> Result<Value> {
        if prompt.trim().is_empty() {
            bail!("提示词名称不能为空");
        }
        if !arguments
            .as_object()
            .is_some_and(|values| values.values().all(Value::is_string))
        {
            bail!("提示词参数必须是字符串值组成的 JSON 对象");
        }
        let session = self.session(name).await?;
        let result = session
            .content_request(
                "prompts",
                "prompts/get",
                json!({"name": prompt, "arguments": arguments}),
                None,
            )
            .await?;
        if !result["messages"].is_array() {
            bail!("prompts/get 返回缺少 messages 数组");
        }
        Ok(json!({"server": name, "prompt": prompt, "result": result}))
    }

    /// 断开一个服务器（name 为 * 时全部断开）。
    pub async fn disconnect(&self, name: &str) -> Value {
        let removed: Vec<Arc<McpSession>> = {
            let mut sessions = self.sessions.lock().await;
            if name == "*" {
                sessions.drain().map(|(_, session)| session).collect()
            } else {
                sessions.remove(name).into_iter().collect()
            }
        };
        for session in &removed {
            session.shutdown().await;
        }
        json!({ "disconnected": removed.iter().map(|s| s.name.clone()).collect::<Vec<_>>() })
    }

    pub async fn shutdown(&self) {
        let _ = self.disconnect("*").await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resource_reads_queued_on_stdio_recheck_revoked_permission_before_writing() {
        let root = tempfile::tempdir().unwrap();
        let script = r#"
let reads=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.id===undefined)return;
  const result=request.method==='initialize'
    ? {protocolVersion:'2025-06-18',capabilities:{resources:{}},serverInfo:{name:'guard',version:'1'}}
    : {contents:[{uri:request.params.uri,text:String(++reads)}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
"#;
        fs::write(
            root.path().join("mcp.json"),
            json!({"mcpServers":{"guard":{"command":"node","args":["-e",script]}}}).to_string(),
        )
        .unwrap();
        let session = McpSession::connect(find_server(root.path(), "guard").unwrap())
            .await
            .unwrap();
        let writer = session.stdin.lock().await;
        let permit = Arc::new(AtomicBool::new(true));
        let pending_session = session.clone();
        let pending_permit = permit.clone();
        let pending = tokio::spawn(async move {
            pending_session
                .content_request(
                    "resources",
                    "resources/read",
                    json!({"uri":"fixture://queued"}),
                    Some(&pending_permit),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while session.pending.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        permit.store(false, Ordering::SeqCst);
        drop(writer);
        assert!(pending.await.unwrap().is_err());
        assert!(session.pending.lock().unwrap().is_empty());
        let result = session
            .content_request(
                "resources",
                "resources/read",
                json!({"uri":"fixture://next"}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(result["contents"][0]["text"], "1");
        session.shutdown().await;
    }

    #[test]
    fn env_expansion_reports_missing_names_once() {
        let mut missing = Vec::new();
        assert_eq!(expand_env("Bearer abc", &mut missing), "Bearer abc");
        assert!(missing.is_empty());

        std::env::set_var("PI_MCP_TEST_TOKEN", "s3cret");
        let mut missing = Vec::new();
        assert_eq!(
            expand_env("Bearer ${PI_MCP_TEST_TOKEN}", &mut missing),
            "Bearer s3cret"
        );
        assert!(missing.is_empty());

        let mut missing = Vec::new();
        assert_eq!(
            expand_env("${PI_MCP_NOT_SET}-${PI_MCP_NOT_SET}", &mut missing),
            "${PI_MCP_NOT_SET}-${PI_MCP_NOT_SET}"
        );
        assert_eq!(missing, vec!["PI_MCP_NOT_SET"]);
        // 未闭合的花括号按普通文本处理
        let mut missing = Vec::new();
        assert_eq!(expand_env("a${b", &mut missing), "a${b");
        assert!(missing.is_empty());
    }

    #[test]
    fn load_servers_reads_stdio_and_http_definitions() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("mcp.json"),
            serde_json::to_vec(&json!({
                "mcpServers": {
                    "local": { "command": "node", "args": ["server.mjs"], "env": { "A": "1" }, "timeout": 120 },
                    "remote": { "url": "http://127.0.0.1:9000/mcp", "headers": { "Authorization": "Bearer x" } },
                    "broken": { "exposure": "deferred" },
                    "off": { "command": "node", "enabled": false }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let listing = load_servers(dir.path());
        let servers = listing["servers"].as_array().unwrap();
        assert_eq!(servers.len(), 4);
        assert_eq!(servers[0]["name"], "broken");
        assert_eq!(servers[0]["transport"], "invalid");
        assert!(listing["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning
                .as_str()
                .unwrap_or_default()
                .contains("既没有 command 也没有 url")));
        let local = servers.iter().find(|s| s["name"] == "local").unwrap();
        assert_eq!(local["transport"], "stdio");
        assert_eq!(local["timeout"], 120);
        assert_eq!(local["envKeys"][0], "A");
        let remote = servers.iter().find(|s| s["name"] == "remote").unwrap();
        assert_eq!(remote["transport"], "http");
        assert_eq!(remote["headerKeys"][0], "Authorization");
        assert_eq!(remote["enabled"], true);
        let off = servers.iter().find(|s| s["name"] == "off").unwrap();
        assert_eq!(off["enabled"], false);
    }

    #[test]
    fn load_servers_tolerates_missing_or_broken_files() {
        let dir = tempfile::tempdir().unwrap();
        let listing = load_servers(dir.path());
        assert_eq!(listing["exists"], false);
        assert_eq!(listing["servers"].as_array().unwrap().len(), 0);

        fs::write(dir.path().join("mcp.json"), b"not json").unwrap();
        let listing = load_servers(dir.path());
        assert_eq!(listing["exists"], true);
        assert!(listing["warnings"][0]
            .as_str()
            .unwrap()
            .contains("不是合法 JSON"));

        fs::write(dir.path().join("mcp.json"), b"{}").unwrap();
        let listing = load_servers(dir.path());
        assert!(listing["warnings"][0]
            .as_str()
            .unwrap()
            .contains("mcpServers"));
    }

    #[test]
    fn find_server_expands_env_and_rejects_unknown_names() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("PI_MCP_TEST_HEADER", "token-1");
        fs::write(
            dir.path().join("mcp.json"),
            serde_json::to_vec(&json!({
                "mcpServers": {
                    "remote": { "url": "http://x/mcp", "headers": { "Authorization": "Bearer ${PI_MCP_TEST_HEADER}" } }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let config = find_server(dir.path(), "remote").unwrap();
        assert_eq!(config.transport(), "http");
        assert_eq!(
            config.headers.get("Authorization").map(String::as_str),
            Some("Bearer token-1")
        );
        assert!(find_server(dir.path(), "nope").is_err());
        std::env::remove_var("PI_MCP_TEST_HEADER");
    }

    #[test]
    fn tool_projection_truncates_and_keeps_required() {
        let tool = json!({
            "name": "search",
            "description": "x".repeat(1000),
            "inputSchema": { "type": "object", "required": ["q"], "properties": { "q": { "type": "string" } } }
        });
        let projected = project_tool(&tool);
        assert_eq!(projected["name"], "search");
        assert!(projected["description"].as_str().unwrap().len() < 1000);
        assert_eq!(projected["required"][0], "q");
        assert!(projected["inputSchema"]
            .as_str()
            .unwrap()
            .contains("\"object\""));
    }

    #[test]
    fn oversized_results_are_bounded() {
        let result =
            json!({ "content": [{ "type": "text", "text": "y".repeat(MAX_RESULT + 1000) }] });
        let bounded = bound_result(result);
        assert_eq!(bounded["truncated"], true);
        assert!(bounded.to_string().len() < MAX_RESULT + 2000);
    }

    #[tokio::test]
    async fn list_reports_disconnected_servers() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("mcp.json"),
            serde_json::to_vec(&json!({ "mcpServers": { "local": { "command": "node" } } }))
                .unwrap(),
        )
        .unwrap();
        let manager = McpManager::new(dir.path().to_path_buf());
        let listing = manager.list().await;
        assert_eq!(listing["connectedCount"], 0);
        assert_eq!(listing["servers"][0]["connected"], false);
        assert_eq!(listing["servers"][0]["toolCount"], 0);
        assert!(manager.connect("missing").await.is_err());
    }
}
