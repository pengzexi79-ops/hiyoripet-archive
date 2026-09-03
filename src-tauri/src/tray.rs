use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// 构建系统托盘：右键菜单含穿透开关与退出。
/// [待核实：Tauri 2 tray/menu API（MenuItem::with_id、TrayIconBuilder、on_menu_event）以编译为准]
pub fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let ct_on = MenuItem::with_id(app, "ct_on", "点击穿透：开（鼠标可点桌面）", true, None::<&str>)?;
    let ct_off = MenuItem::with_id(app, "ct_off", "点击穿透：关（窗口可交互）", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&ct_on, &ct_off, &quit_i])?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Pet 桌宠")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "ct_on" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_ignore_cursor_events(true);
                }
            }
            "ct_off" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_ignore_cursor_events(false);
                }
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
