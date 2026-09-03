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
- 状态：MinGW 下载/解压进行中，待验证 `gcc --version` + `cargo build` 可编 Tauri 最小壳。
