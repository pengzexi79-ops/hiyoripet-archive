# PROGRESS.md — 当前进度与下一步

> AI 每次会话开始先读这个文件，用 ≤5 行复述进度后再动手。

## 当前状态（2026-09-03 20:2x）
- **里程碑**：M0（骨架：Tauri 2 透明窗口 + 点击穿透 + 托盘退出）**编译验证通过** ✅（2026-09-03，`cargo build --target x86_64-pc-windows-gnu` 成功，`pet.exe` 219MB debug + `pet_lib.dll` 产出）。
- **环境**：
  - ✅ Rust 1.98.0 stable，已 `rustup default stable-x86_64-pc-windows-gnu`（默认工具链此前未设，是首个编译报错根因）。
  - ✅ `x86_64-pc-windows-gnu` target 已装；`.cargo/config.toml` 默认 target=gnu。
  - ✅ MinGW-w64（winlibs UCRT64 GCC 16.2.0）已落 `D:/codex/pet/.mingw`，`gcc --version` 验证通过；其 `bin` + `x86_64-w64-mingw32/bin` 已**持久化进用户 PATH**（`.NET [Environment]::SetEnvironmentVariable`，避免 setx 1024 截断），并在编译命令里显式 export。
  - ✅ pnpm 已装（`D:/node-global/pnpm`）。
- **已写文件**：`src-tauri/`(Cargo.toml/lib.rs/window.rs/tray.rs/main.rs/build.rs/tauri.conf.json/capabilities/default.json/icons) + `src/`(App.vue/main.ts) + `vite.config.ts`/`index.html`/`package.json`/`tsconfig.json` + `docs/`(AGENTS/ARCHITECTURE/CONTRACTS/DECISIONS/PROGRESS) + `.cargo/config.toml` + `.gitignore`。
- **M0 代码正确性（已对 Tauri 2 官方文档核实）**：
  - `Cargo.toml`：`tauri` 加 `features = ["tray-icon"]`（否则 `tauri::tray` 编不过）。
  - `tray.rs`：`on_menu_event` 首参是 `&TrayIcon`；退出 `app.app_handle().exit(0)`，取窗 `app.app_handle().get_webview_window("main")`。
  - `window.rs`：`toggle_clickthrough(WebviewWindow, bool)` → `set_ignore_cursor_events(bool)`（Tauri 2 `Window` 真实方法）。
  - `tauri.conf.json`：窗口 `decorations:false / transparent:true / alwaysOnTop:true`，`frontendDist:"../dist"`。
  - `capabilities/default.json`：含 `core:window:allow-set-ignore-cursor-events` + `allow-start-dragging` 等，覆盖前端 invoke 所需权限。

## M0 编译踩坑实录（全部已解决，固化防复发 —— 见 DECISIONS D8）
1. `rustup could not choose a version` → 未设默认工具链 → `rustup default stable-x86_64-pc-windows-gnu`。
2. `could not find Cargo.toml` → 从仓库根跑 cargo → 改用 `--manifest-path src-tauri/Cargo.toml`。
3. `generate_context!` 缺前端目录 → 预建 `dist/index.html` 占位（M1 的 `pnpm build` 会覆盖）。
4. `error calling dlltool 'dlltool.exe': program not found` → GNU target 用 dlltool 生成 raw-dylib 导入库，但 `.mingw/bin` 不在 PATH → 持久化进用户 PATH + 编译命令 export。
5. `icons/icon.ico not found`（tauri-build 生成 Windows 资源文件必需）→ 用纯标准库 Python `_installers/make_ico.py` 生成多尺寸 BMP 型 `icon.ico`（蓝圆占位，后续可换正式图）。
6. `ld.exe: error: export ordinal too large: 91170` → MinGW `ld` 默认导出所有静态库符号，Rust cdylib 符号量超 PE 导出表 16 位序数上限 → `.cargo/config.toml` 加 `rustflags=["-C","link-arg=-Wl,--exclude-libs=ALL"]`。
7. 良性告警 `.rsrc merge failure: multiple non-default manifests` → Tauri manifest 与 MinGW 默认 manifest 合并提示，**不影响产物**。

## 下一步（按顺序）
1. ✅ 已编译通过 → 提交 `git commit -m "M0 verified: Tauri 2 transparent window + clickthrough + tray"`（建议把 `.cargo/config.toml`、`.gitignore`、docs、修复后的 src-tauri 一并纳入）。
2. ⏳ **运行时验收待用户桌面确认**：透明窗口/点击穿透/托盘退出需在带显示 + WebView2 运行时的 Windows 桌面实测（本沙箱无 GUI，仅做到编译验证）。`pnpm tauri dev` 会先 `pnpm build` 产出真实 `dist` 再起 Rust 壳。
3. 进 M1：接入 Live2D 占位模型（官方 sample Hiyori，见 D3），用 PIXI.js v7 + pixi-live2d-display@0.4.0 渲染到透明窗口；vendoring `live2dcubismcore.min.js` 到 `public/cubism-core/`；`tsc` 验证 `src/core/live2d.ts` 的「待核实」API。

## 本轮已完成的 M1 准备（等待 MinGW 期间并行推进，不阻塞 M0）
- **D7 决策落地**：渲染库锁定 `PIXI v7 + pixi-live2d-display@0.4.0`（该库不支持 PIXI v8）；Cubism 4 需 vendoring `live2dcubismcore.min.js` 到 `public/cubism-core/` 并由 index.html 预加载（已在 .gitignore 排除）。
- `package.json`：加 `pixi.js@^7.4.2` + `pixi-live2d-display@0.4.0`。
- `.gitignore`：加 `models/`、`public/cubism-core/`。
- `src/core/live2d.ts`：按 CONTRACTS C1 写出 Live2d 单例（initApp/load/destroy/resizeModel/playMotion/playExpressions/getParameterRange/setParameterValue）。API 已对官方文档核实：`Live2DModel.from(url)`、`model.motion(group,index?)`、`model.expression(idx|name)`、`window.PIXI=PIXI` 自动驱动；`motions`/`expressions` 枚举与 `setParameterValue`/`getParameterRange` 的实现标「待核实」，待 pixi 装好后用 `tsc` 验证门禁。
- ⚠️ `live2d.ts` 含 `pixi-live2d-display/cubism4` 引入，须 `pnpm install` 后方可 `tsc`/`vite build`；M0 的 `cargo build` 不受影响（Rust 侧独立）。

## 验收标准（M0）
- [ ] `cargo build --target x86_64-pc-windows-gnu` 成功产出 `.exe`
- [ ] 窗口透明无边框、始终置顶
- [ ] 鼠标能透过窗口点到桌面图标（点击穿透生效）
- [ ] 拖拽可移动窗口（穿透在模型区临时关闭）
- [ ] 右键托盘 → 退出，无残留进程

## 已知风险
- ~~Tauri 2 + windows-gnu 链接 webview2 `undefined reference`~~ → **未发生**：dlltool(PATH) + `--exclude-libs=ALL` 已覆盖，GNU 链接实测通过。D6 降级 Electron 的兜底暂不触发。
- pnpm 在 `D:/node-global`，调用用绝对路径或先 `export PATH="$PATH:/d/node-global"`。
- M0 仅编译验证，**运行时**（透明/穿透/托盘）待用户桌面实测；`dist/` 被 gitignore，`cargo build` 靠占位 `dist/index.html` 跑通，正式前端由 `pnpm build` 生成。
