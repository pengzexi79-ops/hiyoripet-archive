use std::{
    ffi::c_void,
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static CLICKTHROUGH_ENABLED: AtomicBool = AtomicBool::new(false);
static PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

/// 切换点击穿透：enabled=true 时鼠标穿透窗口；再次在人物窗口范围内右键由 Win32 钩子提供退出确认。
pub fn set_clickthrough(window: &WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    CLICKTHROUGH_ENABLED.store(enabled, Ordering::Release);
    window
        .emit("clickthrough-changed", enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_clickthrough(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    set_clickthrough(&window, enabled)
}

#[cfg(windows)]
mod native_recovery {
    use super::*;

    type Handle = *mut c_void;
    type HookProc = Option<unsafe extern "system" fn(i32, usize, isize) -> isize>;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct MouseHook {
        point: Point,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    struct Message {
        hwnd: Handle,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        point: Point,
        private: u32,
    }

    const WH_MOUSE_LL: i32 = 14;
    const WM_RBUTTONUP: usize = 0x0205;
    const MB_YESNO: u32 = 0x0000_0004;
    const MB_ICONQUESTION: u32 = 0x0000_0020;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;
    const MB_TOPMOST: u32 = 0x0004_0000;
    const IDYES: i32 = 6;

    unsafe extern "system" {
        fn SetWindowsHookExW(
            id_hook: i32,
            callback: HookProc,
            module: Handle,
            thread_id: u32,
        ) -> Handle;
        fn CallNextHookEx(hook: Handle, code: i32, w_param: usize, l_param: isize) -> isize;
        fn GetMessageW(message: *mut Message, hwnd: Handle, min: u32, max: u32) -> i32;
        fn TranslateMessage(message: *const Message) -> i32;
        fn DispatchMessageW(message: *const Message) -> isize;
        fn FindWindowW(class_name: *const u16, window_name: *const u16) -> Handle;
        fn GetWindowRect(hwnd: Handle, rect: *mut Rect) -> i32;
        fn MessageBoxW(hwnd: Handle, text: *const u16, caption: *const u16, kind: u32) -> i32;
        fn GetModuleHandleW(module_name: *const u16) -> Handle;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    unsafe fn pet_window() -> Handle {
        FindWindowW(null(), wide("日和桌宠").as_ptr())
    }

    unsafe extern "system" fn mouse_hook(code: i32, w_param: usize, l_param: isize) -> isize {
        if code >= 0 && w_param == WM_RBUTTONUP && CLICKTHROUGH_ENABLED.load(Ordering::Acquire) {
            let mouse = &*(l_param as *const MouseHook);
            let hwnd = pet_window();
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let inside = !hwnd.is_null()
                && GetWindowRect(hwnd, &mut rect) != 0
                && mouse.point.x >= rect.left
                && mouse.point.x < rect.right
                && mouse.point.y >= rect.top
                && mouse.point.y < rect.bottom;
            if inside {
                if PROMPT_OPEN
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    let hwnd_value = hwnd as usize;
                    thread::spawn(move || show_exit_prompt(hwnd_value));
                }
                return 1;
            }
        }
        CallNextHookEx(null_mut(), code, w_param, l_param)
    }

    fn show_exit_prompt(hwnd_value: usize) {
        let hwnd = hwnd_value as Handle;
        let answer = unsafe {
            MessageBoxW(
                hwnd,
                wide("是否退出鼠标穿透模式？").as_ptr(),
                wide("日和桌宠").as_ptr(),
                MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
            )
        };
        if answer == IDYES {
            if let Some(window) = APP_HANDLE
                .get()
                .and_then(|app| app.get_webview_window("main"))
            {
                let _ = set_clickthrough(&window, false);
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        PROMPT_OPEN.store(false, Ordering::Release);
    }

    pub(super) fn start() {
        thread::spawn(|| unsafe {
            let hook =
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), GetModuleHandleW(null()), 0);
            if hook.is_null() {
                return;
            }
            let mut message: Message = std::mem::zeroed();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
    }
}

pub fn start_clickthrough_recovery(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    #[cfg(windows)]
    native_recovery::start();
}
