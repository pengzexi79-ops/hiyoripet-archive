mod backend;
mod tray;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![window::toggle_clickthrough])
        .setup(|app| {
            app.manage(backend::launch(app));
            tray::build_tray(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Hiyori Pet");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            backend::shutdown(app_handle);
        }
    });
}
