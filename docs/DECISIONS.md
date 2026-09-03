# DECISIONS.md — 已拍板的架构与方向决策

> 格式：每条决策一行结论 + 理由 + 影响范围。改决策必须先在此记录并说明，再动代码。

## D1 场景定位：陪伴助手（非直播虚拟形象）
- 理由：文档默认定位；直播分支（虚拟摄像头/透明通道/音频路由）工作量独立，且与 douyin-mixcut 的耦合未确认。
- 影响：M0–M5 前端形态为桌面常驻窗口。直播分支预留为 M5 后可选。
- 状态：待用户最终确认（用户说「据实际开发场景进行」，先按此推进）。

## D2 授权路径：开发期「自用不分发」（A）
- 理由：避免触发 Live2D SDK 发行许可证谈判。开发/测试/自用完全免费、无限制。
- 影响：模型先用官方样例（Hiyori/Shizuku，受 Live2D 免费素材协议约束，**非商用**）；发布前再决定是否开放「用户导入自有模型」（属可扩展性 APP，需单独签约）。
- 红线：严禁在 README/发布物里声称已获商用授权。

## D3 模型来源：官方样例优先，架构预留替换
- 理由：零成本起步、可验证渲染管线；不内置任何受版权角色资源。
- 影响：`src/core/live2d.ts` 的 `load(path)` 必须接受任意 `.model3.json` 目录，不写死模型名。

## D4 AI 后端：默认 foxtoken 网关，支持切本地
- 理由：用户已有 foxtoken.top OpenAI 兼容网关（含 GPT-5 系模型），无需新增账号。
- 配置：`backend/conf.yaml` 的 `llm_configs` 里放 `foxtoken` 项，`base_url=https://foxtoken.top/v1`，模型 `gpt-5.5`。
- 影响：ASR/TTS 仍走本地（sherpa-onnx / Edge TTS），降低延迟与成本；LLM 走云端。
- 密钥：放环境变量 `${FOXTOKEN_KEY}`，**不写进仓库**。
- **配置约定（2026-08-31 修正）**：`backend/conf.yaml` 里 `llm_configs`/`tts_configs`/`asr_configs` 的**顶层键**（如 `foxtoken`/`edge`/`stub`）只是「配置标签」，**不是** provider 类型；真实实现由该配置项内部的 `provider` 字段（如 `openai-compatible`/`edge-tts`/`stub`）决定。`build_llm/build_tts/build_asr` 一律按 `cfg.provider` 分发，配置键可自由命名（避免 `edge` ≠ `edge-tts` 这类 `ValueError`）。

## D5 语音链路：M3 再做
- 理由：ASR/TTS/VAD 约占 40% 工作量，且依赖音频设备调试。
- 影响：M0–M2 只做纯交互 + 文本对话预留（WS 协议里先定义 `text-input` 消息，音频通道留桩）。

## D6 工具链：MinGW-w64（winlibs UCRT64）+ Rust GNU —— 环境强制
- 理由：**沙箱安全策略封死 VS 安装器提权服务**（所有 VS Build Tools 安装均 EXITCODE=138，引导器解压到 `%TEMP%` 后即退出），MSVC 路线在本机不可行。
- 决策：用 winlibs 解压版 MinGW-w64（无需提权）+ Rust `x86_64-pc-windows-gnu` target。
- 工具链位置：`D:/codex/pet/.mingw/bin`（加入 PATH）；Rust target `x86_64-pc-windows-gnu`。
- 影响：
  - 编译命令必须走 GNU（cargo 默认 target 改为 gnu，或每次 `cargo build --target x86_64-pc-windows-gnu`）。
  - Tauri 2 在 windows-gnu 下链接 webview2 是已知风险点，需实测；若 `undefined reference to __imp_*` 类错误填不动，降级 Electron（需用户批准，见 AGENTS.md 环境约束）。
- 状态：**MinGW 已就位 + M0 编译通过**（2026-09-03）。webview2 链接 `undefined reference` 实际未发生，见 D8。

## D8 windows-gnu 编译必踩的 6 个坑（已逐一解决，固化防复发）
- 背景：本机唯一可行工具链 = winlibs MinGW-w64 + Rust `x86_64-pc-windows-gnu`（D6）。以下每一条都是 `cargo build` 实际撞到的硬错，按出现顺序：
  1. **rustup 无默认工具链** → `rustup default stable-x86_64-pc-windows-gnu`（否则 `rustup could not choose a version`）。
  2. **Cargo.toml 在 `src-tauri/` 不在仓库根** → 编译用 `cargo build --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu`（从根跑报 `could not find Cargo.toml`）。
  3. **`generate_context!` 缺前端目录** → 预建 `dist/index.html` 占位（正式前端由 `pnpm build` 生成并覆盖；`dist/` 在 .gitignore）。
  4. **`dlltool.exe` 不在 PATH** → GNU target 用 `dlltool` 给 raw-dylib 生成导入库，rustc 按名调用；把 `.mingw/bin` 与 `.mingw/x86_64-w64-mingw32/bin` 持久化进**用户 PATH**（`.NET SetEnvironmentVariable`，避开 setx 1024 截断），编译命令里也显式 export。
  5. **缺 `icons/icon.ico`** → Tauri 2 在 Windows 生成资源文件强制需要 `icon.ico`；用纯标准库 Python `_installers/make_ico.py` 生成多尺寸 BMP 型 ICO（windres 兼容）。
  6. **`ld.exe: error: export ordinal too large`**（~9 万序数，超 PE 16 位上限）→ MinGW `ld` 默认导出所有静态库符号；在 `.cargo/config.toml` 的 `[target.x86_64-pc-windows-gnu]` 加 `rustflags = ["-C","link-arg=-Wl,--exclude-libs=ALL"]`，只保留 crate 自身显式导出符号。
- 良性告警：`.rsrc merge failure: multiple non-default manifests`（Tauri manifest 与 MinGW 默认 manifest 合并提示），**不影响产物**。
- 决策影响：任何在本机跑 `cargo build`（或 `pnpm tauri build`）的会话，都必须带上述 PATH（MinGW bin）且依赖 `.cargo/config.toml` 的 `rustflags`；新建 crate 同此约束。

## D7 渲染库版本锁定：PIXI **v6** + pixi-live2d-display@0.4.0（禁用 v7/v8）
- 理由：`pixi-live2d-display@0.4.0`（4 年前最后稳定版）的 `peerDependencies` **明确写 `@pixi/core`/`@pixi/display`/`@pixi/loaders`/`@pixi/math`/`@pixi/sprite`/`@pixi/utils` 全为 `^6`**。PixiJS **v7 把这些 `@pixi/*` 拆分包合并进了 `pixi.js` 内部包**，导致 `pixi-live2d-display` 的 `import ... from '@pixi/core'` 在 v7 下**根本解析不到包**，编译/运行期直接崩。v8 更是整体重写，更不可行。
- 决策：前端渲染锁定 **`pixi.js@^6.5.10`** + `pixi-live2d-display@0.4.0`（官方样例 Hiyori 是 Cubism 4，走 `/cubism4` 入口，该子路径 export 在 0.4.0 中确实存在）。
- ⚠️ 早期草拟误写"v6/v7 兼容"，已据 `peerDependencies` 实测纠正为 **仅 v6**。凡涉及 pixi 版本之处一律 v6。
- `new PIXI.Application({ view, backgroundAlpha:0, resizeTo, resolution, antialias, autoStart })` 构造器写法在 v6/v7 通用（v8 才改 `await app.init()`），故 `src/core/live2d.ts` 代码无需为降级 v6 改动。
- Cubism 4 运行时硬依赖：需 `live2dcubismcore.min.js`（Cubism Core）暴露为全局 `window.Live2DCubismCore`，由 `pixi-live2d-display/cubism4` 引用。该文件**不在 GitHub 仓库**（框架仓库仅 75 文件、无 `.min.js`），须从 Live2D 官方 SDK 包（`https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-*.zip`，已验证可达）解出的 `CubismWebFramework/Core/live2dcubismcore.min.js` vendoring 到 `public/cubism-core/` 并由 `index.html` 的 `<script>` 在模块脚本前预加载。
- 影响：`package.json` 依赖锁 v6；`src/core/live2d.ts` 按 v0.4.0 API 写（`Live2DModel.from` / `model.motion` / `model.expression` / `model.setParameterValue` / `model.internalModel.coreModel`）。
- 状态：pixi 已就位（pixi.js 6.5.x + pixi-live2d-display 0.4.0），`live2d.ts` 的「待核实」API 正在用 `tsc` 核实并修正。
