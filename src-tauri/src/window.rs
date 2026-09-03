use tauri::WebviewWindow;

/// 切换点击穿透：enabled=true 时鼠标穿透窗口（点得到桌面），
/// enabled=false 时窗口可交互（可拖动/右键）。
/// [已核实 Tauri 2：命令注入窗口类型为 WebviewWindow；set_ignore_cursor_events(bool) 为 Window/WebviewWindow 自带方法]
#[tauri::command]
pub fn toggle_clickthrough(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())
}
