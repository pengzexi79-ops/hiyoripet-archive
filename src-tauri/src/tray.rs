use crate::window::set_clickthrough;
use tauri::{
    Emitter,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// 构建系统托盘：右键菜单含穿透开关与退出。
/// [已核实 Tauri 2：MenuItem::with_id / Menu::with_items / TrayIconBuilder::with_id 均按官方写法；on_menu_event 首参为 &TrayIcon，退出/取窗走 app.app_handle()]
pub fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let ct_on = MenuItem::with_id(app, "ct_on", "点击穿透：开（鼠标可点桌面）", true, None::<&str>)?;
    let ct_off = MenuItem::with_id(app, "ct_off", "点击穿透：关（窗口可交互）", true, None::<&str>)?;
    let show_pet = MenuItem::with_id(app, "show_pet", "显示宠物", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&ct_on, &ct_off, &show_pet, &quit_i])?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Pet 桌宠")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            // on_menu_event 第一个参数是 &TrayIcon，不是 &App；
            // 退出/取窗口都要经 app.app_handle()（AppHandle 实现 Manager）。
            "quit" => app.app_handle().exit(0),
            "ct_on" => {
                if let Some(w) = app.app_handle().get_webview_window("main") {
                    let _ = set_clickthrough(&w, true);
                }
            }
            "ct_off" => {
                if let Some(w) = app.app_handle().get_webview_window("main") {
                    let _ = set_clickthrough(&w, false);
                }
            }
            "show_pet" => {
                if let Some(w) = app.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.emit("pet-opened", ());
                }
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
