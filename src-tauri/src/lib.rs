mod tray;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![window::toggle_clickthrough])
        .setup(|app| {
            tray::build_tray(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running pet");
}
