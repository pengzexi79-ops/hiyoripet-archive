# CONTRACTS.md — 接口契约（单一事实源）

> AI 实现任何模块前，先确认本文件里的类型/接口签名。新增接口必须在这里登记。

## C1 前端 `Live2d` 单例（`src/core/live2d.ts`）

```ts
export interface ModelExpression {
  name: string;
  file: string;
}

export interface ModelMeta {
  width: number;
  height: number;
  motions: Record<string, unknown[]>;        // 动作组，键为组名（如 Idle / TapBody），值为该组动作定义数组
  expressions: ModelExpression[];            // 表情（name 取自 .exp3.json 的 Name）
}

export class Live2d {
  private app: Application | null = null;   // PIXI.Application
  private model: Live2DModel | null = null; // pixi-live2d-display 实例

  initApp(canvas: HTMLCanvasElement): void;                 // backgroundAlpha:0, resizeTo:window, resolution:devicePixelRatio
  async load(path: string): Promise<ModelMeta>;             // 扫描 .model3.json；资源路径经 convertFileSrc 转 asset://
  destroy(): void;                                         // 必须彻底释放，防内存泄漏
  resizeModel(size: ModelMeta): void;                      // 缩放居中
  // ── 渲染/驱动 ──
  async playMotion(group: string, index: number): Promise<void>;
  async playExpressions(index: number): Promise<void>;
  getParameterRange(id: string): { min: number; max: number };
  setParameterValue(id: string, value: number | boolean): void;
  // ── M2 互动 ──
  hitTest(x: number, y: number): string[];                 // 返回命中的 hit area 名称数组（model3.json HitAreas.Name）
  containsPoint(x: number, y: number): boolean;            // 宽松命中：点是否落在模型包围盒内（兜底用）
  getBounds(): { x: number; y: number; width: number; height: number }; // world-space 包围盒
  getPosition(): { x: number; y: number };                 // 模型中心点（world space）
  setPosition(x: number, y: number): void;                 // 在画布内设置模型中心点
  getMotionGroups(): string[];                             // 列出所有动作组名
  async playMotionRandom(group: string): Promise<void>;    // 随机播组内某动作
  async playExpressionRandom(): Promise<void>;             // 随机播表情
  get zoom(): number;                                      // 相对初始 contain 尺寸的缩放
  setZoom(z: number): void;                                // [0.35, 3]，浏览器预览使用；桌面端由窗口尺寸配合
}
```

约束：
- `load` 接受**任意** `.model3.json` 目录，不写死模型名（见 DECISIONS D3）。
- `destroy` 后必须从 PIXI stage 移除并 `model.destroy()`，否则切换模型内存上涨。
- **坐标语义**：`hitTest`/`containsPoint` 入参均为 **world space（canvas CSS 像素）**。
  `Live2DModel.hitTest` 内部已调 `toModelPosition()` 自行转换，**调用方不要重复转换**。
- **宽松命中约定**：互动判定应为 `hitTest(x,y).includes('Body') || containsPoint(x,y)`。
  原因：Hiyori 的 HitAreas 仅 `Body` 一个且边界紧，单靠 `hitTest` 会出现「点身体没反应」。
- **拖动与互动不互斥**：`onPointerDown` 里判定互动后**仍要调** `startDragging()`，
  保证任意位置都能拖动窗口（点在模型上也能拖着走）。

## C2 WebSocket 消息协议（前端 ↔ 后端）

```ts
// 前端 → 后端
type ClientMsg =
  | { type: 'ping' }
  | { type: 'audio-chunk';   data: number[] }       // 采样率固定 16000，M3 后续（JSON 传输，二进制帧待优化）
  | { type: 'audio-end' }
  | { type: 'text-input';    text: string; image?: string }
  | { type: 'interrupt' }
  | { type: 'switch-character'; confUid: string };

// 后端 → 前端
type ServerMsg =
  | { type: 'pong' }
  | { type: 'ai-response';   text: string; audio?: string; volumes?: number[]; emotion: string }
  | { type: 'transcription'; text: string }
  | { type: 'tool-status';   tool: string; status: string }
  | { type: 'error';         message: string };
```

约束：
- 音频采样率全局固定 **16000 Hz**（见 AGENTS.md 规则 10）。
- `ai-response.text` 为**流式增量（delta）**，前端按会话累加为完整字幕。
- `ping`/`pong` 用于心跳保活，前端每 15s 发一次 `ping`。

## C3 后端能力接口（`backend/*/`）—— 工厂 + Protocol 模式

```python
# backend/asr/asr_interface.py
class ASRInterface(Protocol):
    async def transcribe_np(self, audio: np.ndarray) -> str: ...

# backend/llm/llm_interface.py
class LLMInterface(Protocol):
    async def chat_iter(self, messages: list[dict]) -> AsyncIterator[str]: ...

# backend/tts/tts_interface.py
class TTSInterface(Protocol):
    async def generate_audio(self, text: str, **kwargs) -> tuple[str, list[float]]:
        """返回 (音频文件路径, 逐帧音量包)。音量包用于口型同步。"""
        ...
```

约束：
- 每个能力通过 `*_factory.py` 实例化，配置驱动（`conf.yaml`）。
- 新增后端只改 `conf.yaml` + 注册到工厂，不动业务调用方。

## C4 配置 schema（`backend/conf.yaml` + `config_manager/`）

- 用 Pydantic 校验，启动时校验失败即退出。
- 支持 `${ENV_VAR}` 环境变量替换。
- LLM 默认项示例（见 DECISIONS D4）：
  ```yaml
  llm_configs:
    foxtoken:
      provider: openai-compatible
      base_url: https://foxtoken.top/v1
      api_key: ${FOXTOKEN_KEY}
      model: gpt-5.5
  ```
- 密钥只走环境变量，**不写进仓库**。

## C4 桌宠扩展动作事件（前端窗口 API）

外部脚本或后续 API 适配器可调用 `window.petApi?.dispatch(action)`，不直接依赖 Live2D 实例：

```ts
type PetApiAction =
  | { type: 'motion'; group: string }
  | { type: 'face'; name: 'smile' | 'surprise' | 'blush' | 'wink' }
  | { type: 'say'; text: string };
```

动作/表情不在设置面板展示，由场景、状态、空闲行为或此扩展事件触发。未知动作组静默忽略。

## C5 桌面发布与后端 sidecar 生命周期

```text
Tauri resource: $RESOURCE/backend/pet-backend.exe
WebSocket:       ws://127.0.0.1:8000/ws
Health:          GET http://127.0.0.1:8000/health
```

约束：
- `backend/main.py` 是 PyInstaller 入口；发布构建使用 `--onefile --noconsole`，`conf.yaml` 必须作为数据文件打入。
- Tauri 启动时由 `src-tauri/src/backend.rs` 启动 sidecar，并传入 `PET_PARENT_PID=<Tauri PID>`；禁止要求用户手动启动 Python/Uvicorn。
- 正常退出时 Tauri 必须终止整个 sidecar 进程树；Tauri 崩溃或被强制结束时，sidecar 的父进程监视器必须自行退出。
- `/health` 返回 `{ "status": "ok", "llm": "remote" | "local" }`。没有 `FOXTOKEN_KEY` 或远端调用失败时，文本消息仍返回 `ai-response`，使用本地陪伴回复，不把桌宠降级成不可用错误页。
- 前端允许在 sidecar 解压启动期间短暂重连；发布包不得依赖 Vite `devUrl` 或端口 1420。
