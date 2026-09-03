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
  getMotionGroups(): string[];                             // 列出所有动作组名
  async playMotionRandom(group: string): Promise<void>;    // 随机播组内某动作
  async playExpressionRandom(): Promise<void>;             // 随机播表情
}
```

约束：
- `load` 接受**任意** `.model3.json` 目录，不写死模型名（见 DECISIONS D3）。
- `destroy` 后必须从 PIXI stage 移除并 `model.destroy()`，否则切换模型内存上涨。

## C2 WebSocket 消息协议（前端 ↔ 后端）

```ts
// 前端 → 后端
type ClientMsg =
  | { type: 'audio-chunk';   data: Float32Array }   // 采样率固定 16000
  | { type: 'audio-end' }
  | { type: 'text-input';    text: string; image?: string }
  | { type: 'interrupt' }
  | { type: 'switch-character'; confUid: string };

// 后端 → 前端
type ServerMsg =
  | { type: 'ai-response';   text: string; audio?: string; volumes?: number[]; emotion: string }
  | { type: 'transcription'; text: string }
  | { type: 'tool-status';   tool: string; status: string }
  | { type: 'error';         message: string };
```

约束：音频采样率全局固定 **16000 Hz**（见 AGENTS.md 规则 10）。

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
