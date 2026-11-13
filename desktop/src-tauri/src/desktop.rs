use crate::{
    core::{ConnectOptions, Core},
    index_store::IndexStore,
    mcp_app_host::McpAppHost,
    mcp_apps::WidgetHost,
    mcp_client::McpManager,
    terminal::Terminal,
    update::UpdateManager,
    workspace,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{ipc::Channel, Emitter, Manager, State, WebviewUrl, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

/// 审阅窗口的标签判定：只有它自己能读取工作区变更。
fn is_review_window(label: &str) -> bool {
    label == "review"
}

/// 独立审阅窗口的初始选择（文件与暂存分组）。工作区路径始终从实时会话读取，
/// 因此主窗口切换工作区后，审阅窗口刷新即可跟随。
#[derive(Default)]
pub struct ReviewWindows {
    selection: std::sync::Mutex<Option<(String, String)>>,
}

impl ReviewWindows {
    pub fn set_selection(&self, file: Option<String>, stage: &str) {
        if let Ok(mut slot) = self.selection.lock() {
            *slot = file.map(|file| (file, stage.to_owned()));
        }
    }

    pub fn selection(&self) -> Option<(String, String)> {
        self.selection.lock().ok().and_then(|value| value.clone())
    }
}

/// 命令层需要的一组服务。集中成一个结构，新增子系统时不必再改 dispatch 签名。
#[derive(Clone)]
pub struct Services {
    pub core: Arc<Core>,
    pub update: Arc<UpdateManager>,
    pub mcp: Arc<McpManager>,
    pub widgets: Arc<WidgetHost>,
    pub apps: Arc<McpAppHost>,
    pub review: Arc<ReviewWindows>,
    pub terminal: Arc<Terminal>,
    pub index: Arc<IndexStore>,
    pub session_index: Arc<crate::session_index::SessionIndex>,
    pub antigravity: Arc<crate::antigravity::Antigravity>,
}

/// 系统集成开关：关闭到托盘与"真的退出"标记。
#[derive(Default)]
pub struct SystemFlags {
    close_to_tray: AtomicBool,
    quitting: AtomicBool,
}

impl SystemFlags {
    pub fn set_close_to_tray(&self, value: bool) {
        self.close_to_tray.store(value, Ordering::SeqCst);
    }
    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::SeqCst)
    }
    /// 从托盘菜单退出时调用：此后关闭请求不再被拦成隐藏。
    pub fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }
    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

pub struct DesktopState {
    pub services: Services,
    close_prompt: AtomicBool,
}
#[tauri::command]
fn pi_subscribe(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    events: Channel<Value>,
) -> std::result::Result<(), String> {
    if window.label() != "main" {
        return Err("无效客户端".into());
    }
    // 第一次 WebView→Rust 调用：说明 WebView 已经活着并能对话（早于前端首帧上报）
    window
        .state::<crate::trace::StartupTrace>()
        .mark("命令通道");
    let acp_events = events.clone();
    state.services.antigravity.subscribe(Arc::new(move |event| {
        let _ = acp_events.send(json!({"engine":"antigravity","generation":0,"event":event}));
    }));
    state.services.core.subscribe(Arc::new(move |value| {
        let _ = events.send(value);
    }));
    Ok(())
}
#[tauri::command]
async fn pi_command(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    operation: String,
    payload: Option<Value>,
) -> std::result::Result<Value, String> {
    if window.label() != "main" {
        state
            .services
            .apps
            .denied_native_command(window.label(), &operation);
        return Err("无效客户端".into());
    }
    dispatch(
        window,
        state.services.clone(),
        &operation,
        payload.unwrap_or_else(|| json!({})),
    )
    .await
    .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn widget_command(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    operation: String,
    payload: Option<Value>,
) -> std::result::Result<Value, String> {
    let payload = payload.unwrap_or_else(|| json!({}));
    let services = &state.services;
    let result: Result<Value> = match operation.as_str() {
        "app-bootstrap" => services.apps.bootstrap(window.label()),
        "app-close" => match services.apps.bootstrap(window.label()) {
            Ok(identity) => {
                services.apps.close(identity["id"].as_str().unwrap());
                window
                    .close()
                    .map(|_| json!({"closed":true}))
                    .map_err(Into::into)
            }
            Err(error) => Err(error),
        },
        "app-rpc" => match payload["message"].as_str() {
            Some(raw) => {
                // Validate the registered native window before processing any message.
                match services.apps.bootstrap(window.label()) {
                    Ok(_) => Ok(services.apps.message(window.label(), raw).await),
                    Err(error) => Err(error),
                }
            }
            None => Err(anyhow::anyhow!("缺少 App 消息")),
        },
        "identity" | "invoke" => match services.widgets.widget_for_label(window.label()) {
            Some(widget) if operation == "identity" => {
                Ok(json!({"widget":widget,"allowed":services.widgets.allowed(&widget)}))
            }
            Some(widget) => match payload["message"].as_str() {
                Some(raw) => Ok(services.widgets.dispatch(&widget, raw)),
                None => Err(anyhow::anyhow!("缺少 widget 消息")),
            },
            None => Err(anyhow::anyhow!("无效 widget 窗口")),
        },
        _ => Err(anyhow::anyhow!("无效 widget 命令")),
    };
    result.map_err(|error| format!("{error:#}"))
}

async fn dispatch(
    window: WebviewWindow,
    services: Services,
    operation: &str,
    payload: Value,
) -> Result<Value> {
    let Services {
        core,
        update,
        mcp,
        widgets,
        apps,
        review,
        terminal,
        index,
        session_index,
        antigravity,
    } = services;
    let app = window.app_handle().clone();
    match operation {
        "antigravity" => {
            let action = payload["action"].as_str().unwrap_or("status");
            match action {
                "status" => Ok(antigravity.status()),
                "choose-executable" => {
                    let selected = tokio::task::spawn_blocking(move || {
                        app.dialog()
                            .file()
                            .set_title("选择 agy.exe")
                            .add_filter("Antigravity CLI", &["exe"])
                            .blocking_pick_file()
                    })
                    .await?;
                    Ok(selected
                        .map(|file| json!(file.to_string()))
                        .unwrap_or(Value::Null))
                }
                "connect" => {
                    antigravity
                        .connect(
                            &PathBuf::from(payload["cwd"].as_str().context("缺少工作区")?),
                            payload["executable"]
                                .as_str()
                                .filter(|path| !path.is_empty()),
                        )
                        .await
                }
                "connect-new" => {
                    antigravity
                        .connect_new(
                            &PathBuf::from(payload["cwd"].as_str().context("缺少工作区")?),
                            payload["executable"]
                                .as_str()
                                .filter(|path| !path.is_empty()),
                        )
                        .await
                }
                "new" => antigravity.session(None).await,
                "load" => {
                    antigravity
                        .session(Some(payload["sessionId"].as_str().context("缺少会话 ID")?))
                        .await
                }
                "list" => antigravity.list().await,
                "set-permission-mode" => {
                    antigravity
                        .set_permission_policy(
                            payload["mode"].as_str().context("缺少权限模式")?,
                            payload
                                .get("rules")
                                .cloned()
                                .map(serde_json::from_value)
                                .transpose()?,
                        )
                        .await
                }
                "configure" => {
                    antigravity
                        .configure(
                            payload["configId"].as_str().context("缺少配置项")?,
                            payload["value"].as_str().context("缺少配置值")?,
                        )
                        .await
                }
                "prompt" => {
                    let images: Vec<Value> = serde_json::from_value(
                        payload.get("images").cloned().unwrap_or_else(|| json!([])),
                    )?;
                    antigravity
                        .prompt_for_session(
                            payload["text"].as_str().unwrap_or_default(),
                            &images,
                            payload["expectedSessionId"].as_str(),
                        )
                        .await
                }
                "permission" => {
                    antigravity
                        .permission(
                            payload["id"].as_str().context("缺少权限请求")?,
                            payload["optionId"].as_str(),
                        )
                        .await
                }
                "cancel" => antigravity.cancel().await,
                "disconnect" => {
                    antigravity.shutdown().await;
                    Ok(antigravity.status())
                }
                _ => bail!("不支持的 Antigravity 操作"),
            }
        }
        "bootstrap" => Ok(core.bootstrap().await),
        "connect" => {
            core.connect(serde_json::from_value::<ConnectOptions>(payload)?)
                .await
        }
        "session-access" => {
            core.session_access(payload["path"].as_str().context("缺少会话路径")?)
                .await
        }
        "mcp-status" => {
            core.mcp_status(payload["reconnect"].as_str().map(String::from))
                .await
        }
        "context-status" => core.context_status().await,
        "prepare-message-edit" => {
            core.prepare_message_edit(
                payload["sessionId"].as_str().context("缺少会话 ID")?,
                payload["entryId"].as_str().context("缺少消息 ID")?,
            )
            .await
        }
        "context-usage" => core.context_usage().await,
        "permissions" => core.permission_action(payload).await,
        "context-settings" => core.configure_context(payload).await,
        "agent-tasks" => core.agent_action(payload).await,
        // 子代理角色目录（路线图 P3.2）：界面用它渲染角色选择。
        "agent-roles" => Ok(json!({ "roles": crate::agent_roles::catalog() })),
        "search-files" => {
            let cwd = core.current().await?.cwd;
            let query = payload["query"].as_str().unwrap_or_default().to_owned();
            tokio::task::spawn_blocking(move || crate::review::search_files(&cwd, &query)).await?
        }
        "review" => {
            crate::review::file_review(
                &core.current().await?.cwd,
                payload["relative"].as_str().context("缺少路径")?,
                payload["stage"].as_str().unwrap_or("working"),
            )
            .await
        }
        "open-editor" => {
            let active = core.current().await?;
            let target = workspace::within_workspace(
                &active.cwd,
                payload["relative"].as_str().context("缺少路径")?,
            )?;
            let line = payload["line"].as_u64().unwrap_or(1).clamp(1, 1_000_000);
            let mut url = url::Url::parse("vscode://file/")?;
            url.set_path(&format!(
                "{}:{line}",
                target.to_string_lossy().replace('\\', "/")
            ));
            app.opener().open_url(url.as_str(), None::<&str>)?;
            Ok(Value::Null)
        }
        "snapshot" => core.snapshot().await,
        "sessions" => {
            core.sessions(payload["cwd"].as_str().map(String::from))
                .await
        }
        "command" => {
            core.command(
                payload["type"].as_str().context("缺少命令类型")?,
                payload.get("data").cloned().unwrap_or_else(|| json!({})),
            )
            .await
        }
        "stop" => core.stop().await,
        "dialog" => {
            core.respond(payload).await?;
            Ok(Value::Null)
        }
        "choose-workspace" => {
            let result = tokio::task::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .set_title("选择工作区")
                    .blocking_pick_folder()
            })
            .await?;
            Ok(result.map(|p| p.to_string().into()).unwrap_or(Value::Null))
        }
        "choose-executable" => {
            let result = tokio::task::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .set_title("选择 pi.exe")
                    .add_filter("Pi executable", &["exe"])
                    .blocking_pick_file()
            })
            .await?;
            if let Some(file) = result {
                core.set_executable(&PathBuf::from(file.to_string())).await
            } else {
                Ok(Value::Null)
            }
        }
        "choose-attachments" => {
            let result = tokio::task::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .set_title("添加文本或图片")
                    .blocking_pick_files()
            })
            .await?;
            let paths: Vec<String> = result
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.to_string())
                .collect();
            tokio::task::spawn_blocking(move || workspace::attachments(&paths)).await?
        }
        "attachments" => {
            let paths: Vec<String> = serde_json::from_value(payload["paths"].clone())?;
            tokio::task::spawn_blocking(move || workspace::attachments(&paths)).await?
        }
        "files" | "preview" => {
            let cwd = core.current().await?.cwd;
            let relative = payload["relative"].as_str().unwrap_or_default().to_owned();
            let preview = operation == "preview";
            tokio::task::spawn_blocking(move || {
                if preview {
                    workspace::preview_file(&cwd, &relative)
                } else {
                    workspace::list_files(&cwd, &relative)
                }
            })
            .await?
        }
        "changes" => workspace::git_changes(&core.current().await?.cwd).await,
        "diff" => {
            workspace::git_diff(
                &core.current().await?.cwd,
                payload["relative"].as_str().context("缺少文件路径")?,
            )
            .await
        }
        "reveal-workspace" => {
            let mut cwd = match payload["cwd"].as_str() {
                Some(path) => {
                    let directory = PathBuf::from(path);
                    if !directory.is_absolute() || !directory.is_dir() {
                        bail!("项目文件夹不存在或不是绝对路径。");
                    }
                    directory
                }
                None => core.cwd().await,
            };
            if cwd.as_os_str().is_empty() {
                cwd = PathBuf::from(core.preferences().await.last_workspace);
            }
            app.opener()
                .open_path(cwd.to_string_lossy(), None::<&str>)?;
            Ok(json!(""))
        }
        "reveal-config" => {
            app.opener()
                .open_path(core.agent_dir.to_string_lossy(), None::<&str>)?;
            Ok(json!(""))
        }
        "open-link" => {
            let url = url::Url::parse(payload["url"].as_str().context("缺少链接")?)?;
            if !["http", "https"].contains(&url.scheme()) {
                bail!("仅支持打开 HTTP / HTTPS 链接。");
            }
            app.opener().open_url(url.as_str(), None::<&str>)?;
            Ok(Value::Null)
        }
        "export" => {
            if core.busy().await {
                bail!("请等待任务完成再导出。");
            }
            let picker_app = app.clone();
            let result = tokio::task::spawn_blocking(move || {
                picker_app
                    .dialog()
                    .file()
                    .set_title("导出当前会话")
                    .set_file_name("pi-session.html")
                    .add_filter("HTML", &["html"])
                    .blocking_save_file()
            })
            .await?;
            if let Some(file) = result {
                let result = core.export(&file.to_string()).await?;
                let output = result["path"].as_str().context("Pi 未返回导出路径")?;
                app.opener().reveal_item_in_dir(output)?;
                Ok(output.into())
            } else {
                Ok(Value::Null)
            }
        }
        "diagnostics" => Ok(core.diagnostics().await),
        // 桌面端自建 MCP 连接（路线图 P1.2）：连接、列工具、调用、断开。
        "mcp-servers" => Ok(mcp.list().await),
        "mcp-connect" => {
            mcp.connect(payload["name"].as_str().context("缺少服务器名")?)
                .await
        }
        "mcp-tools" => {
            mcp.tools(
                payload["name"].as_str().context("缺少服务器名")?,
                payload["refresh"].as_bool().unwrap_or(false),
            )
            .await
        }
        "mcp-call" => {
            mcp.call(
                payload["name"].as_str().context("缺少服务器名")?,
                payload["tool"].as_str().context("缺少工具名")?,
                payload
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            )
            .await
        }
        "mcp-resources" | "mcp-resource-templates" | "mcp-prompts" => {
            let kind = match operation {
                "mcp-resources" => "resources",
                "mcp-resource-templates" => "templates",
                _ => "prompts",
            };
            let cursor = match payload.get("cursor") {
                Some(value) => Some(value.as_str().context("游标必须是字符串")?),
                None => None,
            };
            mcp.content_list(
                payload["name"].as_str().context("缺少服务器名")?,
                kind,
                cursor,
            )
            .await
        }
        "mcp-resource-read" => {
            mcp.read_resource(
                payload["name"].as_str().context("缺少服务器名")?,
                payload["uri"].as_str().context("缺少资源 URI")?,
            )
            .await
        }
        "mcp-prompt-get" => {
            mcp.get_prompt(
                payload["name"].as_str().context("缺少服务器名")?,
                payload["prompt"].as_str().context("缺少提示词名称")?,
                payload
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            )
            .await
        }
        "mcp-disconnect" => Ok(mcp
            .disconnect(payload["name"].as_str().unwrap_or("*"))
            .await),
        "mcp-app-prepare" => {
            apps.prepare(
                &mcp,
                payload["name"].as_str().context("缺少服务器名")?,
                payload["tool"].as_str().context("缺少工具名")?,
            )
            .await
        }
        "mcp-app-open" => {
            let id = payload["id"].as_str().context("缺少 App 会话")?.to_owned();
            let grants: Vec<String> = serde_json::from_value(payload["grantedTools"].clone())
                .context("App 工具授权格式无效")?;
            let allow_resources = payload
                .get("allowResources")
                .map(|value| value.as_bool().context("App 资源授权必须为布尔值"))
                .transpose()?
                .unwrap_or(false);
            let allow_messages = payload
                .get("allowMessages")
                .map(|value| value.as_bool().context("App 消息授权必须为布尔值"))
                .transpose()?
                .unwrap_or(false);
            let chat = if allow_messages {
                Some(core.bind_app_chat().await?)
            } else {
                None
            };
            let label = apps.activate(
                &id,
                &grants,
                allow_resources,
                chat,
                payload["arguments"].clone(),
                payload["result"].clone(),
            )?;
            let identity = apps.bootstrap(&label)?;
            let title = format!(
                "MCP App · {} · {}",
                identity["server"].as_str().unwrap_or_default(),
                identity["title"].as_str().unwrap_or_default()
            );
            let data_dir = std::env::var_os("PI_DESKTOP_USER_DATA")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let opened = tauri::WebviewWindowBuilder::new(
                &app,
                &label,
                WebviewUrl::App("widget-sandbox.html".into()),
            )
            .title(
                title
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(180)
                    .collect::<String>(),
            )
            .inner_size(760.0, 660.0)
            .min_inner_size(380.0, 420.0)
            .data_directory(data_dir.join("widgets").join(&label))
            .on_navigation(|url| {
                url.scheme() == "mcp-app"
                    || matches!(
                        url.host_str(),
                        Some("mcp-app.localhost" | "tauri.localhost")
                    )
                    || cfg!(debug_assertions)
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(5178)
            })
            .build();
            match opened {
                Ok(window) => {
                    if apps.bootstrap(&label).is_err() {
                        let _ = window.destroy();
                        bail!("App 打开操作已取消");
                    }
                    let _ = window.set_focus();
                    Ok(json!({"id":id,"label":label}))
                }
                Err(error) => {
                    apps.close(&id);
                    Err(error.into())
                }
            }
        }
        "mcp-app-close" => {
            let id = payload["id"].as_str().context("缺少 App 会话")?;
            let label = format!("widget-app-{id}");
            apps.close(id);
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.close();
            }
            Ok(json!({"closed":true}))
        }
        // 工作树（路线图 P3.2 收尾）：列出/清理可写子代理留下的隔离工作树。
        "worktree-list" => {
            let cwd = core.current().await?.cwd;
            tokio::task::spawn_blocking(move || {
                if !crate::worktree::is_repo(&cwd) {
                    return Ok(
                        json!({ "repo": "", "worktrees": [], "reason": "当前工作区不是 git 仓库" }),
                    );
                }
                Ok(json!({
                    "repo": crate::worktree::repo_root(&cwd)?.to_string_lossy(),
                    "worktrees": crate::worktree::list(&cwd)?,
                }))
            })
            .await?
        }
        "worktree-remove" => {
            let cwd = core.current().await?.cwd;
            let path = PathBuf::from(payload["path"].as_str().context("缺少路径")?);
            tokio::task::spawn_blocking(move || {
                crate::worktree::remove(&cwd, &path)?;
                Ok(json!({ "removed": true }))
            })
            .await?
        }
        // 启动耗时：前端首次渲染完成后上报，这里记录并打印一行摘要（便于在启动日志里核对）
        "startup-ready" => {
            let trace = window.state::<crate::trace::StartupTrace>();
            trace.mark("前端就绪");
            let mut report = trace.report();
            let render_ms = payload["renderMs"].as_u64().unwrap_or(0);
            // 口径说明随数据一起返回，避免以后被误读成"完整冷启动"
            if let Some(object) = report.as_object_mut() {
                object.insert(
                    "scope".into(),
                    json!("进程内启动：自 main() 第一条语句起，含 Builder/插件初始化、WebView 启动与首帧；不含 exe 加载与 DLL 解析"),
                );
            }
            // 前端渲染耗时单独列出：它与 JS 体积直接相关，和 Rust/WebView 启动成本不是一回事
            if let Some(object) = report.as_object_mut() {
                object.insert("renderMs".into(), json!(render_ms));
            }
            println!("{}（前端渲染 {render_ms}ms）", trace.summary_line());
            Ok(json!({ "startup": report, "renderMs": render_ms }))
        }
        "startup-trace" => Ok(window.state::<crate::trace::StartupTrace>().report()),
        // 会话全文检索：正文索引进 FTS5（trigram，中文可子串匹配）。
        "session-search" => {
            let query = payload["query"].as_str().unwrap_or_default();
            let limit = payload["limit"].as_u64().unwrap_or(8) as usize;
            // 检索前先按陈旧度增量同步（stat 扫描 + 变动文件重建）：
            // 这样刚聊完就能搜到，不需要重启或手点刷新；同步过新则直接跳过。
            const STALE_MS: i64 = 3000;
            let cwd = core.current().await?.cwd;
            let root = crate::workspace::session_root(&cwd, &core.agent_dir)?;
            let worker = session_index.clone();
            // spawn_blocking 返回 JoinHandle<Result<…>>：两次 ? 分别解掉 JoinError 与内部 Result
            let summary = tokio::task::spawn_blocking(move || {
                worker.sync_if_stale(&root, STALE_MS, &mut |_done, _total| {})
            })
            .await??;
            let options = json!({
                "query": query,
                "limit": limit,
                "sinceDays": payload["sinceDays"].as_u64().unwrap_or(0),
                "workspace": payload["workspace"].as_str().unwrap_or_default(),
            });
            let result = session_index.search_filtered(&options)?;
            Ok(json!({
                "items": result["items"],
                "mode": result["mode"],
                "total": result["total"],
                "firstSync": summary.unwrap_or(Value::Null),
                "stats": session_index.stats(),
            }))
        }
        "session-index-sync" => {
            let cwd = core.current().await?.cwd;
            let root = crate::workspace::session_root(&cwd, &core.agent_dir)?;
            let worker = session_index.clone();
            tokio::task::spawn_blocking(move || {
                let summary = worker.sync(&root, &mut |_done, _total| {})?;
                Ok::<Value, anyhow::Error>(json!({
                    "summary": summary,
                    "stats": worker.stats(),
                }))
            })
            .await?
        }
        "session-index-stats" => Ok(json!({
            "stats": session_index.stats(),
            "indexedTasks": index.stats()["tasks"],
        })),
        // 崩溃与异常退出诊断（纯本地，不上报）
        "crash-status" => {
            let data_dir = index
                .path()
                .parent()
                .map(|path| path.to_path_buf())
                .unwrap_or_default();
            Ok(crate::diagnostics::status(&data_dir))
        }
        "crash-report" => {
            let data_dir = index
                .path()
                .parent()
                .map(|path| path.to_path_buf())
                .unwrap_or_default();
            let message = payload["message"]
                .as_str()
                .unwrap_or("前端错误")
                .to_string();
            let detail = payload["detail"].as_str().unwrap_or_default();
            let at = crate::diagnostics::now_ms();
            let text = crate::diagnostics::report_text(
                env!("CARGO_PKG_VERSION"),
                "renderer",
                &message,
                "webview",
                detail,
                at,
            );
            let path = crate::diagnostics::write_renderer(&data_dir, &text, at)?;
            Ok(json!({ "path": path.to_string_lossy() }))
        }
        "crash-clear" => {
            let data_dir = index
                .path()
                .parent()
                .map(|path| path.to_path_buf())
                .unwrap_or_default();
            Ok(json!({ "removed": crate::diagnostics::clear(&data_dir)? }))
        }
        // 保留策略（单机使用）：只清理可再生的东西；记录清理必须"先预览再执行"。
        "retention-status" => {
            let preferences = core.preferences().await;
            let data_dir = index
                .path()
                .parent()
                .map(|path| path.to_path_buf())
                .unwrap_or_default();
            Ok(crate::retention::overview(
                core.agents.root(),
                &data_dir,
                preferences.archived_retention_days,
                crate::retention::now_ms(),
            ))
        }
        "retention-set" => {
            let days = payload["days"].as_i64().context("缺少保留期")?;
            let preferences = core.set_retention(days).await?;
            Ok(json!({ "retentionDays": preferences.archived_retention_days }))
        }
        "retention-apply" => {
            // 只删除 payload 里点名的 id，并且这些 id 必须仍然满足过期条件：
            // 预览到执行之间用户可能又恢复了归档，所以服务端重新算一遍而不是照单执行。
            let requested: Vec<String> = payload["ids"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let preferences = core.preferences().await;
            let candidates: Vec<crate::retention::RecordCandidate> =
                crate::retention::record_candidates(
                    core.agents.root(),
                    preferences.archived_retention_days,
                    crate::retention::now_ms(),
                )
                .into_iter()
                .filter(|candidate| requested.iter().any(|id| id == &candidate.id))
                .collect();
            let result = crate::retention::remove_records(&candidates)?;
            for id in result["ids"].as_array().into_iter().flatten() {
                if let Some(id) = id.as_str() {
                    core.agents.forget(id);
                }
            }
            Ok(result)
        }
        // 存储用量与清理（单机使用）：只统计与清理应用自己管理的目录。
        "storage-usage" => {
            let data_dir = index
                .path()
                .parent()
                .map(|path| path.to_path_buf())
                .unwrap_or_default();
            let records_root = core.agents.root().to_path_buf();
            let worktrees = records_root.join("worktrees");
            let (root_bytes, root_files) = crate::storage::measure(&records_root);
            let (worktree_bytes, worktree_files) = crate::storage::measure(&worktrees);
            let (update_bytes, update_files) = crate::storage::measure(&data_dir.join("updates"));
            let index_files = crate::storage::index_files(index.path());
            let index_bytes: u64 = index_files
                .iter()
                .map(|path| {
                    std::fs::metadata(path)
                        .map(|meta| meta.len())
                        .unwrap_or_default()
                })
                .sum();
            let records_bytes = root_bytes.saturating_sub(worktree_bytes);
            let records_files = root_files.saturating_sub(worktree_files);
            let stats = index.stats();
            Ok(json!({
                "rows": [
                    {"id": "records", "label": "任务记录与会话", "path": records_root.to_string_lossy(), "bytes": records_bytes, "files": records_files},
                    {"id": "worktrees", "label": "隔离工作树", "path": worktrees.to_string_lossy(), "bytes": worktree_bytes, "files": worktree_files, "note": "在子代理任务详情里逐个移除，分支会保留"},
                    {"id": "updates", "label": "更新缓存", "path": data_dir.join("updates").to_string_lossy(), "bytes": update_bytes, "files": update_files, "cleanable": true},
                    {"id": "index", "label": "本地索引", "path": index.path().to_string_lossy(), "bytes": index_bytes, "files": index_files.len() as u64, "resettable": true, "note": "可清空后从记录重建"},
                ],
                "totalBytes": records_bytes + worktree_bytes + update_bytes + index_bytes,
                "indexedTasks": stats["tasks"],
                "indexedAt": stats["lastRebuildAtMs"],
            }))
        }
        "storage-clean" => {
            let target = payload["target"].as_str().unwrap_or_default().to_owned();
            let data_dir = index
                .path()
                .parent()
                .map(|path| path.to_path_buf())
                .unwrap_or_default();
            crate::storage::clean(&target, &data_dir, index.path())
        }
        // 清空索引并从任务记录重建（不动索引文件：删掉正在使用的数据库不安全）
        "index-reset" => {
            index.reset()?;
            core.agents.sync_index_all();
            Ok(json!({ "stats": index.stats() }))
        }
        "index-sync" => {
            core.agents.sync_index_all();
            Ok(json!({ "stats": index.stats() }))
        }
        // 系统集成（路线图增量）：开机自启 / 关闭到托盘 / 任务完成通知。
        "system-status" => {
            let preferences = core.preferences().await;
            Ok(json!({
                "launchAtLogin": crate::startup::is_enabled(crate::startup::RUN_KEY)
                    .unwrap_or(preferences.launch_at_login),
                "closeToTray": preferences.close_to_tray,
                "notifications": preferences.notifications,
                "traySupported": true,
            }))
        }
        "system-set" => {
            let launch = payload["launchAtLogin"].as_bool();
            let tray = payload["closeToTray"].as_bool();
            let notify_enabled = payload["notifications"].as_bool();
            if let Some(enabled) = launch {
                if enabled {
                    let executable = std::env::current_exe()
                        .map_err(|error| anyhow::anyhow!("无法确定程序路径：{error}"))?;
                    crate::startup::set_enabled(
                        crate::startup::RUN_KEY,
                        &crate::startup::command_for(&executable),
                    )?;
                } else {
                    crate::startup::remove(crate::startup::RUN_KEY)?;
                }
            }
            let preferences = core
                .set_system_preferences(launch, tray, notify_enabled)
                .await?;
            if let Some(value) = tray {
                window.state::<SystemFlags>().set_close_to_tray(value);
            }
            Ok(json!({
                "launchAtLogin": crate::startup::is_enabled(crate::startup::RUN_KEY).unwrap_or(false),
                "closeToTray": preferences.close_to_tray,
                "notifications": preferences.notifications,
            }))
        }
        "system-notify" => {
            let preferences = core.preferences().await;
            let mut sent = false;
            if preferences.notifications {
                crate::system::notify(
                    &window.app_handle().clone(),
                    payload["title"].as_str().unwrap_or("Pi Desktop"),
                    payload["body"].as_str().unwrap_or_default(),
                )?;
                sent = true;
            }
            Ok(json!({ "sent": sent }))
        }
        // 本地任务索引（路线图 P3.3）：SQLite 缓存，可随时从任务记录重建。
        "index-stats" => Ok(index.stats()),
        "index-search" => index.search(&payload),
        "index-rebuild" => {
            let records: Vec<Value> = core.agents.list()["tasks"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let worker = index.clone();
            tokio::task::spawn_blocking(move || {
                let summary = worker.rebuild(&records, |_done, _total| {})?;
                Ok::<Value, anyhow::Error>(json!({
                    "summary": summary,
                    "stats": worker.stats(),
                }))
            })
            .await?
        }
        // 工作区命令面板（路线图 P3）：在主窗口的工作区里跑命令并流式回传输出。
        "terminal-run" => {
            if window.label() != "main" {
                bail!("只有主窗口可以运行命令");
            }
            let cwd = crate::terminal::resolve_cwd(&core.current().await?.cwd)?;
            let shell = payload["shell"].as_str().unwrap_or("cmd").to_owned();
            let command = payload["command"].as_str().context("缺少命令")?.to_owned();
            let events = window.clone();
            let sink_events = events.clone();
            let sink: crate::terminal::Sink = Arc::new(move |event| {
                let _ = sink_events.emit("terminal://event", event);
            });
            let worker = terminal.clone();
            let logged = command.clone();
            let shell_for_log = shell.clone();
            tokio::task::spawn(async move {
                if let Err(error) = worker.start(&cwd, &shell, &logged, sink).await {
                    // 启动失败也要让界面看到，而不是点了没反应。
                    let _ = events.emit(
                        "terminal://event",
                        json!({ "type": "error", "message": format!("{error:#}") }),
                    );
                }
            });
            Ok(json!({ "started": true, "command": command, "shell": shell_for_log }))
        }
        "terminal-cancel" => Ok(terminal.cancel().await),
        "terminal-history" => Ok(json!({
            "runs": terminal.history(payload["limit"].as_u64().unwrap_or(20) as usize),
            "busy": terminal.busy().await,
        })),
        "terminal-clear" => Ok(terminal.clear()),
        // 独立审阅窗口（路线图 P2.2）：主窗口开窗，窗口内只读变更与补丁，可把文件引用回主窗口。
        "review-window-open" => {
            if window.label() != "main" {
                bail!("只有主窗口可以打开审阅窗口");
            }
            let file = payload["file"].as_str().map(str::to_owned);
            let stage = payload["stage"].as_str().unwrap_or("working").to_owned();
            review.set_selection(file, &stage);
            let data_dir = std::env::var_os("PI_DESKTOP_USER_DATA")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            if let Some(existing) = app.get_webview_window("review") {
                let _ = existing.set_focus();
                let _ = existing.emit("review://refresh", json!({}));
                return Ok(json!({ "label": "review", "reused": true }));
            }
            let window = tauri::WebviewWindowBuilder::new(
                &app,
                "review",
                WebviewUrl::App("review-window.html".into()),
            )
            .title("Pi Desktop · 改动审阅")
            .inner_size(980.0, 720.0)
            .min_inner_size(520.0, 420.0)
            .data_directory(data_dir.join("review-window"))
            .on_navigation(|url| {
                matches!(url.scheme(), "tauri" | "http" | "https")
                    && url.host_str() == Some("tauri.localhost")
            })
            .build()?;
            let _ = window.set_focus();
            Ok(json!({ "label": "review", "reused": false }))
        }
        // 下面四个只接受审阅窗口（或主窗口关闭它），避免其它窗口借道读取工作区。
        "review-context" => {
            if !is_review_window(window.label()) {
                bail!("这不是审阅窗口");
            }
            let active = core.current().await?;
            let selection = review.selection();
            Ok(json!({
                "cwd": active.cwd.to_string_lossy(),
                "file": selection.as_ref().map(|value| value.0.clone()),
                "stage": selection.as_ref().map(|value| value.1.clone()).unwrap_or_else(|| "working".into()),
            }))
        }
        "review-changes" => {
            if !is_review_window(window.label()) {
                bail!("这不是审阅窗口");
            }
            workspace::git_changes(&core.current().await?.cwd).await
        }
        "review-diff" => {
            if !is_review_window(window.label()) {
                bail!("这不是审阅窗口");
            }
            let stage = payload["stage"].as_str().unwrap_or("working");
            crate::review::file_review(
                &core.current().await?.cwd,
                payload["relative"].as_str().context("缺少路径")?,
                stage,
            )
            .await
        }
        "review-reference" => {
            if !is_review_window(window.label()) {
                bail!("这不是审阅窗口");
            }
            let path = payload["relative"].as_str().context("缺少路径")?.to_owned();
            let line = payload["line"].as_u64().unwrap_or(0);
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.emit("review://reference", json!({ "path": path, "line": line }));
                let _ = main.set_focus();
            }
            Ok(json!({ "referenced": path }))
        }
        "review-window-close" => {
            if let Some(window) = app.get_webview_window("review") {
                let _ = window.close();
            }
            Ok(json!({ "closed": true }))
        }
        // MCP Apps 沙箱宿主（路线图 P1.2b）：白名单目录、授权、调用校验与审计。
        "widget-catalog" => Ok(crate::mcp_apps::fixture_catalog()),
        "widget-open" => {
            let widget = payload["widget"]
                .as_str()
                .context("缺少 widget 标识")?
                .to_owned();
            let requested: Vec<String> =
                serde_json::from_value(payload["requested"].clone()).unwrap_or_default();
            let granted: Vec<String> =
                serde_json::from_value(payload["granted"].clone()).unwrap_or_default();
            let session = widgets.open(&widget, &requested, &granted);
            let label = crate::mcp_apps::window_label(&widget);
            let render = payload.get("data").cloned().unwrap_or_else(|| json!({}));
            // 已经开过就复用窗口，只把新的数据推给它。
            if let Some(existing) = app.get_webview_window(&label) {
                let _ = existing.set_focus();
                let _ = existing.emit(
                    "widget://render",
                    json!({ "widget": widget, "data": render }),
                );
                return Ok(json!({ "session": session, "label": label, "reused": true }));
            }
            let data_dir = std::env::var_os("PI_DESKTOP_USER_DATA")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let window = tauri::WebviewWindowBuilder::new(
                &app,
                &label,
                WebviewUrl::App("widget-sandbox.html".into()),
            )
            .title(format!("Pi Widget · {widget}"))
            .inner_size(560.0, 660.0)
            .min_inner_size(380.0, 420.0)
            // 独立数据目录：widget 与主窗口不共享 WebView2 存储。
            .data_directory(data_dir.join("widgets").join(&label))
            .on_navigation(|url| {
                matches!(url.scheme(), "tauri" | "http" | "https")
                    && url.host_str() == Some("tauri.localhost")
            })
            .build()?;
            let _ = window.set_focus();
            let _ = window.emit(
                "widget://render",
                json!({ "widget": widget, "data": render }),
            );
            Ok(json!({ "session": session, "label": label, "reused": false }))
        }
        // 下面三个只接受沙箱窗口：按窗口标签反查会话，主窗口调用一律拒绝。
        "widget-identity" => {
            let widget = widgets
                .widget_for_label(window.label())
                .context("这不是沙箱 widget 窗口")?;
            Ok(json!({ "widget": widget, "allowed": widgets.allowed(&widget) }))
        }
        "widget-invoke" => {
            let widget = widgets
                .widget_for_label(window.label())
                .context("这不是沙箱 widget 窗口")?;
            Ok(widgets.dispatch(
                &widget,
                payload["message"].as_str().context("缺少消息内容")?,
            ))
        }
        "widget-audit" => {
            let mut entries = apps.audit();
            entries.extend(
                widgets
                    .audit(200)
                    .iter()
                    .map(|entry| serde_json::to_value(entry).unwrap()),
            );
            entries.sort_by_key(|entry| std::cmp::Reverse(entry["atMs"].as_u64().unwrap_or(0)));
            entries.truncate(payload["limit"].as_u64().unwrap_or(50).clamp(1, 200) as usize);
            Ok(json!({"entries":entries}))
        }
        "widget-close" => {
            let widget = payload["widget"].as_str().context("缺少 widget 标识")?;
            let label = crate::mcp_apps::window_label(widget);
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.close();
            }
            Ok(widgets.close(widget))
        }
        // 扩展清单 / 权限 / 签名判定（路线图 P1.1）。只读扫描，不加载扩展。
        "extensions-list" => {
            let root = payload["dir"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| core.agent_dir.join("extensions"));
            Ok(tokio::task::spawn_blocking(move || crate::extensions::scan(&root)).await?)
        }
        // 应用内更新（路线图 P0.3）。所有动作都只返回状态，不抛错给前端。
        "update-status" => Ok(update.status()),
        "update-source" => {
            update.set_source(payload["source"].as_str().map(String::from));
            Ok(update.status())
        }
        "update-check" => match payload["manifest"].as_str() {
            Some(text) => update.check_text(text),
            None => update.check_remote(),
        },
        "update-download" => {
            let worker = update.clone();
            tokio::task::spawn_blocking(move || worker.download()).await?
        }
        "update-install" => update.install(),
        "window" => {
            match payload["action"].as_str().context("缺少窗口操作")? {
                "minimize" => window.minimize()?,
                "maximize" => {
                    if window.is_maximized()? {
                        window.unmaximize()?
                    } else {
                        window.maximize()?
                    }
                }
                "close" => window.close()?,
                _ => bail!("无效窗口操作"),
            }
            Ok(Value::Null)
        }
        _ => bail!("不支持的客户端操作：{operation}"),
    }
}

pub fn run() {
    // 启动耗时：零点来自 main() 的第一行（见 trace::mark_process_start），
    // 因此这里的累计时间包含 Builder 与插件初始化。
    let trace = crate::trace::StartupTrace::default();
    trace.begin();
    let builder = tauri::Builder::default().manage(trace);
    // Fixture processes have isolated profiles and must not activate/exit into
    // the user's running release. Production builds always remain single-instance.
    let isolated_fixture = cfg!(feature = "test-fixture")
        && std::env::var("PI_DESKTOP_TEST").as_deref() == Ok("1")
        && std::env::var_os("PI_DESKTOP_USER_DATA").is_some();
    let builder = if isolated_fixture {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
    };
    builder
        .register_uri_scheme_protocol("mcp-app", |context, request| {
            let state = context.app_handle().state::<DesktopState>();
            let id = request.uri().path().trim_start_matches('/');
            let document = if request.method() == "GET" && request.uri().query().is_none() {
                state.services.apps.document(context.webview_label(), id)
            } else {
                Err(anyhow::anyhow!("无效资源请求"))
            };
            match document {
                Ok((html, csp)) => tauri::http::Response::builder()
                    .header("Content-Type", "text/html; charset=utf-8")
                    .header("Content-Security-Policy", csp)
                    .header("Cache-Control", "no-store")
                    .header("X-Content-Type-Options", "nosniff")
                    .body(html.into_bytes())
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(403)
                    .body(b"App resource unavailable".to_vec())
                    .unwrap(),
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(SystemFlags::default())
        .setup(|app| {
            // The frontend uses no JS path API. WebView2 injects its bootstrap
            // into unprivileged subframes, where TAURI_INTERNALS is unavailable.
            // Native path resolution uses the already managed PathResolver.
            #[cfg(windows)]
            app.handle().remove_plugin("path");
            let data_dir = std::env::var_os("PI_DESKTOP_USER_DATA")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            // 启动时应用上一次已校验的更新；失败只记录，不阻塞启动。
            let current_exe = std::env::current_exe().unwrap_or_default();
            match crate::update::apply_pending_with(&data_dir, &current_exe) {
                Ok(Some(message)) => eprintln!("pi-desktop: {message}"),
                Ok(None) => {}
                Err(error) => eprintln!("pi-desktop: 忽略待应用更新：{error:#}"),
            }
            let core = Core::new(&data_dir)?;
            let update = Arc::new(UpdateManager::new(
                data_dir.clone(),
                current_exe,
                env!("CARGO_PKG_VERSION"),
            ));
            let mcp = Arc::new(McpManager::new(core.agent_dir.clone()));
            app.manage(DesktopState {
                services: Services {
                    core,
                    update,
                    mcp,
                    widgets: Arc::new(WidgetHost::new()),
                    review: Arc::new(ReviewWindows::default()),
                    apps: Arc::new(McpAppHost::default()),
                    terminal: Arc::new(Terminal::new()),
                    index: Arc::new(IndexStore::open(&data_dir.join("index.sqlite"))?),
                    session_index: Arc::new(crate::session_index::SessionIndex::open(
                        &data_dir.join("sessions.sqlite"),
                    )?),
                    antigravity: crate::antigravity::Antigravity::new(data_dir.join("antigravity")),
                },
                close_prompt: AtomicBool::new(false),
            });
            app.state::<crate::trace::StartupTrace>().mark("数据层");
            // 系统集成：托盘需要在启动时决定是否创建；开机自启登记对齐一次。
            {
                let preferences = tauri::async_runtime::block_on(
                    app.state::<DesktopState>().services.core.preferences(),
                );
                app.state::<SystemFlags>()
                    .set_close_to_tray(preferences.close_to_tray);
                if preferences.launch_at_login {
                    if let Ok(executable) = std::env::current_exe() {
                        let _ = crate::startup::set_enabled(
                            crate::startup::RUN_KEY,
                            &crate::startup::command_for(&executable),
                        );
                    }
                }
                if preferences.close_to_tray {
                    if let Err(error) = crate::system::install_tray(app.handle()) {
                        eprintln!("托盘创建失败：{error:#}");
                    }
                }
                // 启动时清掉过期的更新缓存：这是纯缓存（下次检查更新会重新下载），可以静默处理；
                // 任务记录与会话永不自动删除——保留期到了也只在界面提示。
                {
                    let data_dir_task = data_dir.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = tokio::task::spawn_blocking(move || {
                            crate::retention::clean_update_cache(&data_dir_task)
                        })
                        .await;
                    });
                }
                // 启动时后台同步会话索引：不阻塞首屏，搜索随即可用
                {
                    let core_task = app.state::<DesktopState>().services.core.clone();
                    let session_index = app.state::<DesktopState>().services.session_index.clone();
                    tauri::async_runtime::spawn(async move {
                        let Ok(active) = core_task.current().await else {
                            return;
                        };
                        let Ok(root) =
                            crate::workspace::session_root(&active.cwd, &core_task.agent_dir)
                        else {
                            return;
                        };
                        let _ = tokio::task::spawn_blocking(move || {
                            session_index.sync(&root, &mut |_, _| {})
                        })
                        .await;
                    });
                }
                // 索引挂到任务管理器上：记录一变就同步，启动时全量对齐（自愈历史漂移）
                let state = app.state::<DesktopState>();
                state
                    .services
                    .core
                    .agents
                    .attach_index(state.services.index.clone());
            }
            app.state::<crate::trace::StartupTrace>().mark("系统集成");
            // 崩溃诊断：panic 写本地报告（含回溯），不上报任何地方
            {
                let crash_dir_root = data_dir.clone();
                let version = env!("CARGO_PKG_VERSION").to_string();
                std::panic::set_hook(Box::new(move |info| {
                    let thread = std::thread::current()
                        .name()
                        .unwrap_or("unnamed")
                        .to_string();
                    let message = info
                        .payload()
                        .downcast_ref::<&str>()
                        .map(|text| (*text).to_string())
                        .or_else(|| info.payload().downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "（无法读取 panic 内容）".to_string());
                    let location = info
                        .location()
                        .map(|spot| format!("{}:{}:{}", spot.file(), spot.line(), spot.column()))
                        .unwrap_or_default();
                    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
                    let at = crate::diagnostics::now_ms();
                    let text = crate::diagnostics::report_text(
                        &version, &thread, &message, &location, &backtrace, at,
                    );
                    match crate::diagnostics::write_crash(&crash_dir_root, &text, at) {
                        Ok(path) => {
                            eprintln!("Pi Desktop 崩溃：{message}（报告：{}）", path.display())
                        }
                        Err(error) => {
                            eprintln!("Pi Desktop 崩溃：{message}（报告写入失败：{error}）")
                        }
                    }
                }));
            }
            let allowed_dev = cfg!(debug_assertions);
            let builder =
                tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Pi Desktop")
                    .inner_size(1440.0, 940.0)
                    .min_inner_size(960.0, 640.0)
                    .decorations(false)
                    .resizable(true)
                    .data_directory(data_dir.join("webview"))
                    .on_navigation(move |url| {
                        (matches!(url.scheme(), "tauri" | "http" | "https")
                            && url.host_str() == Some("tauri.localhost"))
                            || (allowed_dev
                                && url.scheme() == "http"
                                && url.host_str() == Some("127.0.0.1")
                                && url.port() == Some(5178))
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            #[cfg(feature = "test-fixture")]
            let builder = if std::env::var("PI_DESKTOP_DEBUG_PORT").as_deref() == Ok("9224") {
                builder.additional_browser_args(
                    "--remote-debugging-port=9224 --remote-debugging-address=127.0.0.1",
                )
            } else {
                builder
            };
            let window = builder.build()?;
            window.set_focus()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi_subscribe,
            pi_command,
            widget_command
        ])
        .on_window_event(|window, event| {
            if window.label().starts_with("widget-") {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window.label().starts_with("widget-app-") {
                        api.prevent_close();
                        window
                            .state::<DesktopState>()
                            .services
                            .apps
                            .close_window(window.label());
                        let _ = window.emit("widget://teardown", json!({}));
                        let closing = window.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                            let _ = closing.destroy();
                        });
                    }
                }
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let state = window.state::<DesktopState>();
                    state.services.apps.close_window(window.label());
                    if let Some(widget) = state.services.widgets.widget_for_label(window.label()) {
                        state.services.widgets.close(&widget);
                    }
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<DesktopState>();
                if state.services.core.closing.load(Ordering::SeqCst) {
                    return;
                }
                // 关闭到托盘：偏好开启且不是从托盘退出时，隐藏窗口而不是退出程序。
                {
                    let flags = window.state::<SystemFlags>();
                    if flags.close_to_tray() && !flags.is_quitting() && window.label() == "main" {
                        api.prevent_close();
                        let _ = window.hide();
                        return;
                    }
                }
                api.prevent_close();
                if state.close_prompt.swap(true, Ordering::SeqCst) {
                    return;
                }
                let app = window.app_handle().clone();
                let core = state.services.core.clone();
                let antigravity = state.services.antigravity.clone();
                tauri::async_runtime::spawn(async move {
                    let proceed = if core.busy().await
                        || core.operation_pending()
                        || core.agents.busy()
                        || antigravity.busy()
                    {
                        let dialog_app = app.clone();
                        tokio::task::spawn_blocking(move || {
                            dialog_app
                                .dialog()
                                .message("任务仍在运行，停止并关闭 Pi Desktop？")
                                .title("关闭 Pi Desktop")
                                .buttons(MessageDialogButtons::OkCancelCustom(
                                    "停止并关闭".into(),
                                    "继续运行".into(),
                                ))
                                .blocking_show()
                        })
                        .await
                        .unwrap_or(false)
                    } else {
                        true
                    };
                    if proceed {
                        antigravity.shutdown().await;
                        core.shutdown().await;
                        let _ = app.state::<DesktopState>().services.mcp.shutdown().await;
                        // 正常退出标记：下次启动据此区分"异常退出"（有更新的 panic 报告才算）
                        let data_dir = app
                            .state::<DesktopState>()
                            .services
                            .index
                            .path()
                            .parent()
                            .map(|path| path.to_path_buf())
                            .unwrap_or_default();
                        let _ = crate::diagnostics::mark_clean_exit(
                            &data_dir,
                            env!("CARGO_PKG_VERSION"),
                        );
                        app.exit(0);
                    } else {
                        app.state::<DesktopState>()
                            .close_prompt
                            .store(false, Ordering::SeqCst);
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Pi Desktop 启动失败");
}
