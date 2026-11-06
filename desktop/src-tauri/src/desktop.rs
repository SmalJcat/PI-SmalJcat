use crate::{
    core::{ConnectOptions, Core},
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
use tauri::{ipc::Channel, Manager, State, WebviewUrl, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

pub struct DesktopState {
    pub core: Arc<Core>,
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
    state.core.subscribe(Arc::new(move |value| {
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
        return Err("无效客户端".into());
    }
    dispatch(
        window,
        state.core.clone(),
        &operation,
        payload.unwrap_or_else(|| json!({})),
    )
    .await
    .map_err(|error| format!("{error:#}"))
}
async fn dispatch(
    window: WebviewWindow,
    core: Arc<Core>,
    operation: &str,
    payload: Value,
) -> Result<Value> {
    let app = window.app_handle().clone();
    match operation {
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
        "context-settings" => core.configure_context(payload).await,
        "agent-tasks" => core.agent_action(payload).await,
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
            let mut cwd = core.cwd().await;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = std::env::var_os("PI_DESKTOP_USER_DATA")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let core = Core::new(&data_dir)?;
            app.manage(DesktopState {
                core,
                close_prompt: AtomicBool::new(false),
            });
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
        .invoke_handler(tauri::generate_handler![pi_subscribe, pi_command])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<DesktopState>();
                if state.core.closing.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                if state.close_prompt.swap(true, Ordering::SeqCst) {
                    return;
                }
                let app = window.app_handle().clone();
                let core = state.core.clone();
                tauri::async_runtime::spawn(async move {
                    let proceed =
                        if core.busy().await || core.operation_pending() || core.agents.busy() {
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
                        core.shutdown().await;
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
