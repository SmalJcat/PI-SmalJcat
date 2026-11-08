//! 系统集成：任务完成通知与托盘。
//!
//! 通知走 tauri-plugin-notification；托盘在启动时按偏好创建（默认关闭，
//! 与既有行为一致：默认点关闭就是退出程序）。

use anyhow::{Context, Result};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

/// 创建托盘图标与菜单。只在偏好开启时调用。
pub fn install_tray(app: &AppHandle) -> Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .context("无法创建托盘菜单项")?;
    let quit = MenuItem::with_id(app, "quit", "退出 Pi Desktop", true, None::<&str>)
        .context("无法创建托盘菜单项")?;
    let menu = Menu::with_items(app, &[&show, &quit]).context("无法创建托盘菜单")?;
    let icon = app
        .default_window_icon()
        .cloned()
        .context("应用缺少默认窗口图标，无法创建托盘")?;

    let builder = TrayIconBuilder::with_id("pi-tray")
        .icon(icon)
        .tooltip("Pi Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                // 标记为"真的退出"，否则关闭逻辑会把窗口藏起来
                if let Some(flags) = app.try_state::<crate::desktop::SystemFlags>() {
                    flags.mark_quitting();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    builder.build(app).context("无法创建托盘图标")?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 发送一条系统通知。内容为空时直接返回，调用方不必自己判断。
pub fn notify(app: &AppHandle, title: &str, body: &str) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        return Ok(());
    }
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body.trim())
        .show()
        .context("发送系统通知失败")?;
    Ok(())
}
