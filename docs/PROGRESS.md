# PROGRESS.md — 当前进度与下一步

> AI 每次会话开始先读这个文件，用 ≤5 行复述进度后再动手。

## 当前状态（2026-09-03 17:5x）
- **里程碑**：M0（骨架：环境 + Tauri 透明窗口 + 点击穿透 + 托盘退出）进行中
- **环境**：
  - ✅ Rust 1.98.0 stable 已装（`~/.cargo/bin`）
  - ❌ MSVC / VS Build Tools：沙箱禁提权，装不上（EXITCODE=138，详见 DECISIONS.md D6）
  - 🔄 MinGW-w64（winlibs UCRT64）：下载+解压中（后台任务 xRaPDz）
  - ⏳ 待：验证 `gcc --version` + `rustup target add x86_64-pc-windows-gnu`
  - ✅ pnpm 已装（`D:/node-global/pnpm`，加入 PATH 或调用时带全路径）
- **工程骨架**：目录已建（src/、src-tauri/、backend/、docs/），尚未初始化具体代码
- **事实源文档**：AGENTS.md / DECISIONS.md / PROGRESS.md 已写；ARCHITECTURE.md / CONTRACTS.md 待补

## 下一步（按顺序）
1. MinGW 就位后，配 `.cargo/config.toml`：`[target.x86_64-pc-windows-gnu]` 设 linker=`x86_64-w64-mingw32-gcc`、ar=`x86_64-w64-mingw32-ar`；设 `[build] target = "x86_64-pc-windows-gnu"`。
2. 手写最小 Tauri 2 骨架（不依赖 `create-tauri-app` 脚手架，避免联网拉模板）：
   - `src-tauri/Cargo.toml`：tauri 2 + tauri-plugin-*-（先最少依赖）
   - `src-tauri/src/lib.rs`：入口 + 托盘
   - `src-tauri/src/window.rs`：透明 `transparent:true` / `decorations:false` / `alwaysOnTop:true`（tauri.conf.json）+ 点击穿透（Rust `set_ignore_cursor_events`）
   - `src-tauri/tauri.conf.json`：窗口配置 + `bundle` 设置
   - `src-tauri/capabilities/default.json`：显式开 `core:window:allow-*` 等权限（防静默失败）
   - `src/App.vue` + `src/main.ts`：极简 Vue 3 壳（一个可拖拽色块占位，验证窗口行为）
3. 跑通 M0 验收：窗口透明置顶、鼠标能透过点到桌面、右键托盘可退出、`cargo build` 用 GNU 工具链成功。

## 验收标准（M0）
- [ ] `cargo build --target x86_64-pc-windows-gnu` 成功产出 `.exe`
- [ ] 窗口透明无边框、始终置顶
- [ ] 鼠标能透过窗口点到桌面图标（点击穿透生效）
- [ ] 拖拽可移动窗口（穿透在模型区临时关闭）
- [ ] 右键托盘 → 退出，能干净退出无残留进程

## 已知风险
- Tauri 2 + windows-gnu 链接 webview2 可能报 `undefined reference` → 见 D6 兜底方案。
- pnpm 在 `D:/node-global`，脚本里调用用绝对路径或先 `export PATH="$PATH:/d/node-global"`。
