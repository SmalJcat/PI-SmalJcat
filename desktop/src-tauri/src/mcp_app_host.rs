//! Server-provided MCP Apps, bound to a connection, resource and native window.
use crate::{
    core::{AppChatBinding, AppModelContext},
    mcp_apps::AuditEntry,
    mcp_client::{McpManager, McpSession},
    mcp_subscriptions::{validate_uri, ResourceEvent, MAX_APP_SUBSCRIPTIONS},
};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, watch, Mutex as AsyncMutex};
use uuid::Uuid;

pub const UI_VERSION: &str = "2026-01-26";
pub const UI_MIME: &str = "text/html;profile=mcp-app";
const MAX_HTML: usize = 2 * 1024 * 1024;
const MAX_MESSAGE: usize = 64 * 1024;
const MAX_SESSIONS: usize = 24;

pub fn client_capabilities() -> Value {
    json!({"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":[UI_MIME]}}})
}

pub fn resource_uri(tool: &Value) -> Option<&str> {
    tool["_meta"]["ui"]["resourceUri"]
        .as_str()
        .or_else(|| tool["_meta"]["ui/resourceUri"].as_str())
}

pub fn app_visible(tool: &Value) -> bool {
    match tool["_meta"]["ui"].get("visibility") {
        None => true,
        Some(Value::Array(values)) => values.iter().any(|value| value == "app"),
        _ => false,
    }
}

pub fn resource_document(result: &Value, uri: &str) -> Result<(String, String, Value)> {
    if !uri.starts_with("ui://") || uri.len() > 4096 {
        bail!("App 资源 URI 必须使用 ui://");
    }
    let contents = result["contents"]
        .as_array()
        .context("App 资源缺少 contents")?;
    let mut matching = contents.iter().filter(|item| item["uri"] == uri);
    let content = matching.next().context("App 资源 URI 与请求不匹配")?;
    if matching.next().is_some() {
        bail!("App 资源包含重复 URI");
    }
    let mime = content["mimeType"].as_str().unwrap_or_default();
    if !mime.replace([' ', '"'], "").eq_ignore_ascii_case(UI_MIME) {
        bail!("App 资源 MIME 必须为 {UI_MIME}");
    }
    let html = match (content.get("text"), content.get("blob")) {
        (Some(Value::String(text)), None) => text.clone(),
        (None, Some(Value::String(blob))) => {
            String::from_utf8(STANDARD.decode(blob).context("App HTML base64 无效")?)
                .context("App HTML 不是 UTF-8")?
        }
        _ => bail!("App 资源必须包含 text 或 blob"),
    };
    if html.is_empty() || html.len() > MAX_HTML {
        bail!("App HTML 为空或超过 2 MiB");
    }
    let mut domains = json!({});
    if content["_meta"]["ui"]
        .get("csp")
        .is_some_and(|value| !value.is_object())
    {
        bail!("App CSP 必须为对象");
    }
    for key in [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
    ] {
        let mut approved = Vec::<String>::new();
        if let Some(value) = content["_meta"]["ui"]["csp"].get(key) {
            let values = value.as_array().context("App CSP 来源必须为数组")?;
            if values.len() > 32 {
                bail!("App CSP 来源过多");
            }
            for value in values {
                let domain = value.as_str().context("App CSP 来源必须为字符串")?;
                let parsed = url::Url::parse(&domain.replace("*.", "wildcard."))
                    .context("App CSP 来源不是有效 URL")?;
                let scheme_allowed = matches!(parsed.scheme(), "http" | "https")
                    || key == "connectDomains" && matches!(parsed.scheme(), "ws" | "wss");
                if !scheme_allowed
                    || domain.len() > 2048
                    || domain.contains([';', '\'', '"'])
                    || domain.bytes().any(|byte| byte <= 0x20 || byte == 0x7f)
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.host_str().is_none()
                    || parsed.path() != "/"
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                    || domain.matches('*').count() > usize::from(domain.contains("://*."))
                {
                    bail!("App CSP 只接受来源，不接受路径、凭据或指令");
                }
                let origin = parsed.origin().ascii_serialization();
                let normalized = if domain.contains("://*.") {
                    origin.replacen("://wildcard.", "://*.", 1)
                } else {
                    origin
                };
                if !approved.contains(&normalized) {
                    approved.push(normalized);
                }
            }
        }
        domains[key] = json!(approved);
    }
    let sources = |key: &str| {
        domains[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let resources = sources("resourceDomains");
    let connections = sources("connectDomains");
    let frames = sources("frameDomains");
    let bases = sources("baseUriDomains");
    let csp = format!(
        "default-src 'none'; script-src 'self' 'unsafe-inline' {resources}; \
         style-src 'self' 'unsafe-inline' {resources}; img-src 'self' data: {resources}; \
         font-src 'self' {resources}; media-src 'self' data: {resources}; \
         connect-src {}; frame-src {}; base-uri {}; object-src 'none'; form-action 'none'",
        if connections.is_empty() {
            "'none'"
        } else {
            &connections
        },
        if frames.is_empty() { "'none'" } else { &frames },
        if bases.is_empty() { "'self'" } else { &bases },
    );
    Ok((html, csp, domains))
}

#[derive(Default)]
struct AppState {
    initialized: bool,
    ready: bool,
    grants: HashSet<String>,
    allow_resources: bool,
    chat: Option<AppChatBinding>,
    model_context: Option<AppModelContext>,
    pending: HashSet<String>,
    arguments: Value,
    result: Value,
}

pub struct PiAccess {
    pub binding: AppChatBinding,
    pub messages: bool,
    pub model_context: bool,
}

struct App {
    active: Arc<AtomicBool>,
    id: String,
    connection: Arc<McpSession>,
    tool: Value,
    uri: String,
    html: String,
    csp: String,
    domains: Value,
    tools: Vec<Value>,
    created: Instant,
    state: Mutex<AppState>,
    notifications: AsyncMutex<AppNotifications>,
    closed: watch::Sender<bool>,
}

struct AppNotifications {
    receiver: broadcast::Receiver<ResourceEvent>,
    last_sent: Option<Instant>,
}

struct RequestGuard {
    app: Arc<App>,
    key: String,
}
impl RequestGuard {
    fn begin(app: &Arc<App>, id: &Value) -> Result<Self> {
        if !app.connection.connected() {
            bail!("MCP 连接已断开，请重新打开 App");
        }
        if !app.active.load(Ordering::SeqCst) {
            bail!("App 已关闭");
        }
        let key = id.to_string();
        let mut state = app.state.lock().unwrap();
        if !state.ready {
            bail!("App 尚未完成初始化");
        }
        if state.pending.len() >= 16 || !state.pending.insert(key.clone()) {
            bail!("App 请求过多或 id 重复");
        }
        Ok(Self {
            app: app.clone(),
            key,
        })
    }
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.app.state.lock().unwrap().pending.remove(&self.key);
    }
}

#[derive(Default)]
pub struct McpAppHost {
    sessions: Mutex<HashMap<String, Arc<App>>>,
    audit: Arc<Mutex<VecDeque<AuditEntry>>>,
}

impl McpAppHost {
    pub async fn prepare(
        &self,
        manager: &McpManager,
        name: &str,
        tool_name: &str,
    ) -> Result<Value> {
        let connection = manager.app_session(name).await?;
        let tools = connection.app_tools().await?;
        let tool = tools
            .iter()
            .find(|tool| tool["name"] == tool_name)
            .context("服务器工具已变更，请刷新")?
            .clone();
        let uri = resource_uri(&tool)
            .context("该工具没有 MCP App 资源")?
            .to_owned();
        let resource = connection.read_app_resource(&uri).await?;
        let (html, csp, domains) = resource_document(&resource, &uri)?;
        if !tool["inputSchema"].is_object() {
            bail!("App 工具 schema 无效");
        }
        let tools = tools.into_iter().filter(app_visible).collect::<Vec<_>>();
        let id = Uuid::new_v4().to_string();
        let descriptor = json!({
            "id": id, "server": name, "tool": tool_name, "uri": uri,
            "title": tool_name, "sha256": format!("{:x}", Sha256::digest(html.as_bytes())),
            "tools": tools.iter().map(|tool|json!({"name":tool["name"],"description":tool["description"]})).collect::<Vec<_>>(),
            "domains": domains,
        });
        let app = Arc::new(App {
            id: id.clone(),
            active: Arc::new(AtomicBool::new(false)),
            notifications: AsyncMutex::new(AppNotifications {
                receiver: connection.resource_events.subscribe(),
                last_sent: None,
            }),
            closed: watch::channel(false).0,
            connection,
            tool,
            uri: uri.clone(),
            html,
            csp,
            domains,
            tools,
            created: Instant::now(),
            state: Mutex::new(AppState::default()),
        });
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, app| {
            app.active.load(Ordering::SeqCst) || app.created.elapsed() < Duration::from_secs(300)
        });
        if sessions.len() >= MAX_SESSIONS {
            bail!("App 会话过多，请先关闭已有窗口或授权面板");
        }
        sessions.insert(id.clone(), app);
        drop(sessions);
        self.record(
            &id,
            "prepare",
            true,
            &format!("server={name}, resource={uri}"),
        );
        Ok(descriptor)
    }

    pub fn activate(
        &self,
        id: &str,
        grants: &[String],
        allow_resources: bool,
        pi: Option<PiAccess>,
        arguments: Value,
        result: Value,
    ) -> Result<String> {
        let sessions = self.sessions.lock().unwrap();
        let app = sessions.get(id).cloned().context("App 会话已关闭或过期")?;
        if !app.connection.connected() {
            bail!("MCP 连接已断开，请重新打开 App");
        }
        if !arguments.is_object()
            || !result.is_object()
            || serde_json::to_vec(&arguments)?.len() > MAX_MESSAGE
            || serde_json::to_vec(&result)?.len() > 512 * 1024
        {
            bail!("App 初始输入或结果格式无效或超限");
        }
        let mut state = app.state.lock().unwrap();
        if app.active.load(Ordering::SeqCst) {
            bail!("App 已打开");
        }
        if app.created.elapsed() >= Duration::from_secs(300) {
            bail!("App 预备会话已过期");
        }
        for name in grants {
            if !app.tools.iter().any(|tool| tool["name"] == *name) {
                bail!("App 授权包含不可调用的工具");
            }
        }
        state.grants = grants.iter().cloned().collect();
        state.allow_resources = allow_resources;
        if let Some(pi) = pi {
            if pi.messages {
                state.chat = Some(pi.binding.clone());
            }
            if pi.model_context {
                let active = app.active.clone();
                let connection = app.connection.clone();
                let source = format!(
                    "{} · {}",
                    json!(app.connection.name),
                    json!(app.tool["name"])
                )
                .chars()
                .take(512)
                .collect();
                state.model_context =
                    Some(pi.binding.model_context(app.id.clone(), source, move || {
                        active.load(Ordering::SeqCst) && connection.connected()
                    }));
            }
        }
        state.arguments = arguments;
        state.result = result;
        app.active.store(true, Ordering::SeqCst);
        self.record(
            id,
            "open",
            true,
            &format!("App 已打开，资源读取授权={allow_resources}"),
        );
        Ok(format!("widget-app-{id}"))
    }

    fn get(&self, id: &str) -> Result<Arc<App>> {
        let mut sessions = self.sessions.lock().unwrap();
        let app = sessions.get(id).cloned().context("App 会话已关闭或过期")?;
        if !app.active.load(Ordering::SeqCst) && app.created.elapsed() >= Duration::from_secs(300) {
            sessions.remove(id);
            bail!("App 预备会话已过期");
        }
        Ok(app)
    }

    fn for_window(&self, label: &str) -> Result<Arc<App>> {
        let id = label.strip_prefix("widget-app-").context("无效 App 窗口")?;
        let app = self.get(id)?;
        if !app.active.load(Ordering::SeqCst) {
            bail!("App 窗口尚未打开");
        }
        Ok(app)
    }

    pub fn bootstrap(&self, label: &str) -> Result<Value> {
        let app = self.for_window(label)?;
        let resources = app.connection.resource_capabilities();
        let notifications = app.state.lock().unwrap().allow_resources
            && app.connection.connected()
            && (resources["subscribe"] == true || resources["listChanged"] == true);
        Ok(
            json!({"kind":"mcp","id":app.id,"server":app.connection.name,
            "title":app.tool["name"],"uri":app.uri,"resourceNotifications":notifications}),
        )
    }

    pub fn document(&self, label: &str, id: &str) -> Result<(String, String)> {
        let app = self.for_window(label)?;
        if app.id != id {
            bail!("App 资源不属于当前窗口");
        }
        Ok((app.html.clone(), app.csp.clone()))
    }

    pub fn close(&self, id: &str) {
        if let Some(app) = self.sessions.lock().unwrap().remove(id) {
            app.active.store(false, Ordering::SeqCst);
            app.closed.send_replace(true);
            let audit = self.audit.clone();
            let owner = app.id.clone();
            app.connection
                .release_resource_owner(owner.clone(), move |result| {
                    if let Err(error) = result {
                        Self::record_into(
                            &audit,
                            &owner,
                            "resources/cleanup",
                            false,
                            &format!("{error:#}"),
                        );
                    }
                });
            self.record(id, "close", true, "App 会话已关闭");
        }
    }

    pub fn close_window(&self, label: &str) {
        if let Some(id) = label.strip_prefix("widget-app-") {
            self.close(id);
        }
    }

    pub fn audit(&self) -> Vec<Value> {
        self.audit
            .lock()
            .unwrap()
            .iter()
            .rev()
            .filter_map(|entry| serde_json::to_value(entry).ok())
            .collect()
    }

    pub fn denied_native_command(&self, label: &str, operation: &str) {
        self.record(label, operation, false, "主窗口命令拒绝");
    }

    fn record(&self, id: &str, method: &str, ok: bool, detail: &str) {
        Self::record_into(&self.audit, id, method, ok, detail);
    }

    fn record_into(
        entries: &Mutex<VecDeque<AuditEntry>>,
        id: &str,
        method: &str,
        ok: bool,
        detail: &str,
    ) {
        let mut audit = entries.lock().unwrap();
        while audit.len() >= 200 {
            audit.pop_front();
        }
        audit.push_back(AuditEntry {
            at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            api: format!("{id}::{}", method.chars().take(100).collect::<String>()),
            ok,
            detail: detail.chars().take(300).collect(),
        });
    }

    pub async fn notifications(&self, label: &str) -> Result<Value> {
        let app = self.for_window(label)?;
        if !app.state.lock().unwrap().allow_resources {
            bail!("App 未获授权读取服务器资源");
        }
        let mut stream = app
            .notifications
            .try_lock()
            .context("App 通知请求正在等待")?;
        let mut closed = app.closed.subscribe();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if !app.active.load(Ordering::SeqCst) || *closed.borrow() {
                bail!("App 已关闭");
            }
            if !app.connection.connected() {
                bail!("MCP 连接已断开，请重新打开 App");
            }
            let received = tokio::select! {
                _=closed.changed()=>bail!("App 已关闭"),
                value=tokio::time::timeout_at(deadline,stream.receiver.recv())=>value,
            };
            let first = match received {
                Ok(value) => value,
                Err(_) => return Ok(json!({"notifications":[]})),
            };
            let mut uris = BTreeSet::new();
            let mut resync = false;
            let mut events = vec![first];
            for _ in 0..128 {
                match stream.receiver.try_recv() {
                    Ok(event) => events.push(Ok(event)),
                    Err(broadcast::error::TryRecvError::Lagged(_)) => resync = true,
                    Err(broadcast::error::TryRecvError::Empty) => break,
                    Err(broadcast::error::TryRecvError::Closed) => bail!("MCP 通知连接已关闭"),
                }
            }
            for event in events {
                match event {
                    Ok(ResourceEvent::Updated(uri)) => {
                        uris.insert(uri);
                    }
                    Ok(ResourceEvent::ListChanged)
                    | Err(broadcast::error::RecvError::Lagged(_)) => resync = true,
                    Ok(ResourceEvent::Closed) | Err(broadcast::error::RecvError::Closed) => {
                        bail!("MCP 连接已断开，请重新打开 App")
                    }
                }
            }
            if resync {
                uris.extend(app.connection.subscriptions.uris(&app.id));
            }
            uris.retain(|uri| app.connection.subscriptions.owns(&app.id, uri));
            let catalog = resync && app.connection.resource_capabilities()["listChanged"] == true;
            if uris.is_empty() && !catalog || !app.state.lock().unwrap().ready {
                continue;
            }
            let delay = stream
                .last_sent
                .map(|last| Duration::from_millis(100).saturating_sub(last.elapsed()))
                .unwrap_or_default();
            tokio::select! { _=closed.changed()=>bail!("App 已关闭"), _=tokio::time::sleep(delay)=>{} }
            if !app.active.load(Ordering::SeqCst) || !app.connection.connected() {
                bail!("App 或 MCP 连接已关闭");
            }
            if !app.state.lock().unwrap().ready {
                continue;
            }
            uris.retain(|uri| app.connection.subscriptions.owns(&app.id, uri));
            let mut notifications=uris.into_iter().map(|uri|json!({"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":uri}})).collect::<Vec<_>>();
            if catalog {
                notifications
                    .push(json!({"jsonrpc":"2.0","method":"notifications/resources/list_changed"}));
            }
            if notifications.is_empty() {
                continue;
            }
            stream.last_sent = Some(Instant::now());
            return Ok(json!({"notifications":notifications}));
        }
    }

    pub async fn message(&self, label: &str, raw: &str) -> Value {
        if raw.len() > MAX_MESSAGE {
            self.record(label, "invalid", false, "App 消息超过 64 KiB");
            return json!({"response":{"jsonrpc":"2.0","id":null,
                "error":{"code":-32600,"message":"App 消息超过 64 KiB"}},"notifications":[]});
        }
        let message: Value = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => {
                self.record(label, "invalid", false, "App 消息不是 JSON");
                return json!({"response":{"jsonrpc":"2.0","id":null,
                    "error":{"code":-32700,"message":"App 消息不是合法 JSON"}},"notifications":[]});
            }
        };
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        if !message.is_object()
            || message["jsonrpc"] != "2.0"
            || !message["method"]
                .as_str()
                .is_some_and(|method| !method.is_empty())
            || message
                .get("id")
                .is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        {
            self.record(label, "invalid", false, "JSON-RPC 消息形状无效");
            return json!({"response":{"jsonrpc":"2.0","id":null,
                "error":{"code":-32600,"message":"JSON-RPC 消息形状无效"}},"notifications":[]});
        }
        let method = message["method"].as_str().unwrap_or_default();
        let notification = message.get("id").is_none();
        let result = self.dispatch_message(label, &message).await;
        let app_id = label.strip_prefix("widget-app-").unwrap_or(label);
        match result {
            Ok((result, notifications)) => {
                self.record(app_id, method, true, "已处理");
                let response = if notification {
                    Value::Null
                } else {
                    json!({"jsonrpc":"2.0","id":id,"result":result})
                };
                json!({"response":response,"notifications":notifications})
            }
            Err(error) => {
                self.record(app_id, method, false, &format!("{error:#}"));
                let code = if !matches!(
                    method,
                    "ui/initialize"
                        | "ui/notifications/initialized"
                        | "tools/call"
                        | "resources/read"
                        | "resources/subscribe"
                        | "resources/unsubscribe"
                        | "ui/message"
                        | "ui/update-model-context"
                        | "ping"
                        | "notifications/message"
                        | "ui/notifications/size-changed"
                        | "ui/request-display-mode"
                ) {
                    -32601
                } else {
                    -32000
                };
                json!({"response": if notification { Value::Null } else {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":error.to_string()}})
                },"notifications":[]})
            }
        }
    }

    async fn dispatch_message(&self, label: &str, message: &Value) -> Result<(Value, Vec<Value>)> {
        if message["jsonrpc"] != "2.0" || !message.is_object() {
            bail!("App 消息必须为 JSON-RPC 2.0");
        }
        let app = self.for_window(label)?;
        let method = message["method"].as_str().context("消息缺少 method")?;
        let id = message.get("id");
        let notification = id.is_none();
        if let Some(id) = id {
            if !id.is_string() && !id.is_i64() && !id.is_u64() {
                bail!("App 请求 id 无效");
            }
        }
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() {
            bail!("App 参数必须为对象");
        }
        match method {
            "ui/initialize" if !notification => {
                if !params["protocolVersion"].is_string()
                    || !params["appInfo"].is_object()
                    || !params["appCapabilities"].is_object()
                {
                    bail!("App 初始化参数无效");
                }
                let mut state = app.state.lock().unwrap();
                state.initialized = true;
                state.ready = false;
                let mut capabilities = json!({"serverTools":{},"logging":{},
                    "sandbox":{"permissions":{},"csp":app.domains}});
                if state.allow_resources {
                    capabilities["serverResources"] = json!({});
                    let resources = app.connection.resource_capabilities();
                    if resources["listChanged"] == true {
                        capabilities["serverResources"]["listChanged"] = json!(true);
                    }
                    if resources["subscribe"] == true {
                        capabilities["experimental"] = json!({"pi-desktop/resource-subscriptions":{"maxSubscriptions":MAX_APP_SUBSCRIPTIONS}});
                    }
                }
                if state.chat.is_some() {
                    capabilities["message"] = json!({"text":{}});
                }
                if state.model_context.is_some() {
                    capabilities["updateModelContext"] = json!({"text":{},"structuredContent":{}});
                }
                Ok((
                    json!({
                        "protocolVersion":UI_VERSION,
                        "hostInfo":{"name":"Pi Desktop","version":env!("CARGO_PKG_VERSION")},
                        "hostCapabilities":capabilities,
                        "hostContext":{"toolInfo":{"tool":app.tool},"theme":"dark",
                            "displayMode":"inline","availableDisplayModes":["inline"],
                            "platform":"desktop","containerDimensions":{"width":720,"height":560}},
                    }),
                    vec![],
                ))
            }
            "ui/notifications/initialized" if notification => {
                let mut state = app.state.lock().unwrap();
                if !state.initialized {
                    bail!("App 尚未初始化");
                }
                if state.ready {
                    return Ok((json!({}), vec![]));
                }
                state.ready = true;
                Ok((
                    json!({}),
                    vec![
                        json!({"jsonrpc":"2.0","method":"ui/notifications/tool-input",
                        "params":{"arguments":state.arguments}}),
                        json!({"jsonrpc":"2.0","method":"ui/notifications/tool-result","params":state.result}),
                    ],
                ))
            }
            "ping" if !notification => Ok((json!({}), vec![])),
            "notifications/message" | "ui/notifications/size-changed" if notification => {
                Ok((json!({}), vec![]))
            }
            "ui/request-display-mode" if !notification => Ok((json!({"mode":"inline"}), vec![])),
            "ui/update-model-context" if !notification => {
                let context = app
                    .state
                    .lock()
                    .unwrap()
                    .model_context
                    .clone()
                    .context("App 未获授权提供模型上下文")?;
                let _request = RequestGuard::begin(&app, &message["id"])?;
                context
                    .update(&params)
                    .await
                    .context("App 上下文更新失败，请查看宿主审计")?;
                Ok((json!({}), vec![]))
            }
            "ui/message" if !notification => {
                let chat = app
                    .state
                    .lock()
                    .unwrap()
                    .chat
                    .clone()
                    .context("App 未获授权向 Pi 对话发送消息")?;
                if params["role"] != "user" {
                    bail!("App 消息角色必须为 user");
                }
                let blocks = match &params["content"] {
                    Value::Array(blocks) => blocks.as_slice(),
                    block @ Value::Object(_) => std::slice::from_ref(block),
                    _ => bail!("App 消息必须包含 text 内容块"),
                };
                let parts = blocks
                    .iter()
                    .map(|block| {
                        if block["type"] != "text" {
                            bail!("App 消息只支持文本");
                        }
                        block["text"].as_str().context("App 文本内容无效")
                    })
                    .collect::<Result<Vec<_>>>()?;
                let text = parts.join("\n");
                if text.trim().is_empty() {
                    bail!("App 消息不能为空");
                }
                let _request = RequestGuard::begin(&app, &message["id"])?;
                let text = format!(
                    "[MCP App {} · {}]\n\n{text}",
                    json!(app.connection.name),
                    json!(app.tool["name"])
                );
                chat.send(text, &app.active)
                    .await
                    .context("App 消息发送失败，请查看宿主审计")?;
                if !app.active.load(Ordering::SeqCst) {
                    bail!("App 已关闭");
                }
                Ok((json!({}), vec![]))
            }
            "resources/subscribe" | "resources/unsubscribe" if !notification => {
                if !app.state.lock().unwrap().allow_resources {
                    bail!("App 未获授权读取服务器资源");
                }
                if app.connection.resource_capabilities()["subscribe"] != true {
                    bail!("服务器未声明资源订阅能力");
                }
                let uri = params["uri"].as_str().context("缺少资源 URI")?;
                validate_uri(uri)?;
                let _request = RequestGuard::begin(&app, &message["id"])?;
                let result = if method == "resources/subscribe" {
                    app.connection
                        .subscriptions
                        .subscribe(&app.connection, &app.id, uri, &app.active)
                        .await
                } else {
                    app.connection
                        .subscriptions
                        .unsubscribe(&app.connection, &app.id, uri, &app.active)
                        .await
                };
                result.context("MCP 资源订阅变更失败，请查看宿主审计")?;
                if !app.active.load(Ordering::SeqCst) {
                    bail!("App 已关闭");
                }
                Ok((json!({}), vec![]))
            }
            "resources/read" if !notification => {
                if !app.state.lock().unwrap().allow_resources {
                    bail!("App 未获授权读取服务器资源");
                }
                let uri = params["uri"].as_str().context("缺少资源 URI")?;
                validate_uri(uri)?;
                let _request = RequestGuard::begin(&app, &message["id"])?;
                let result = app
                    .connection
                    .content_request(
                        "resources",
                        "resources/read",
                        json!({"uri":uri}),
                        Some(&app.active),
                    )
                    .await
                    .context("MCP 资源读取失败，请查看宿主审计")?;
                if !app.active.load(Ordering::SeqCst) {
                    bail!("App 已关闭");
                }
                if !result["contents"].is_array() {
                    bail!("resources/read 返回缺少 contents 数组");
                }
                Ok((result, vec![]))
            }
            "tools/call" if !notification => {
                let name = params["name"].as_str().context("缺少工具名称")?;
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if !arguments.is_object() {
                    bail!("工具参数必须为对象");
                }
                if !app.state.lock().unwrap().grants.contains(name) {
                    bail!("App 未获授权调用工具 {name}");
                }
                let _request = RequestGuard::begin(&app, &message["id"])?;
                let tools = app
                    .connection
                    .app_tools()
                    .await
                    .context("MCP 工具目录读取失败，请查看宿主审计")?;
                if !tools
                    .iter()
                    .any(|tool| tool["name"] == name && app_visible(tool))
                {
                    bail!("工具不允许此 App 调用");
                }
                if !app.active.load(Ordering::SeqCst) {
                    bail!("App 已关闭");
                }
                let result = app
                    .connection
                    .call_app_tool(name, arguments, &app.active)
                    .await
                    .context("MCP 工具调用失败，请查看宿主审计")?;
                if !app.active.load(Ordering::SeqCst) {
                    bail!("App 已关闭");
                }
                Ok((result, vec![]))
            }
            _ => bail!("App 方法不可用"),
        }
    }
}
