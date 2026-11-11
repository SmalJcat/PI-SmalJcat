#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // 启动计时的零点放在第一行：这样后续 trace 覆盖 Builder/插件初始化，
    // 而不是只从 Tauri 的 run() 开始计。exe 加载与 DLL 解析仍在 main 之前，不计入。
    pi_desktop::trace::mark_process_start();
    pi_desktop::desktop::run();
}
