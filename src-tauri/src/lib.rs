mod backend;
mod tray;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = window.emit("pet-opened", ());
            }
        }))
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
