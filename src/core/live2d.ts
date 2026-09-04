// src/core/live2d.ts
// Live2d 单例：PIXI Application + Live2DModel（pixi-live2d-display@0.4.0, PIXI v6）
// 契约见 docs/CONTRACTS.md C1。API 以 pixi-live2d-display@0.4.0 实际类型为准（tsc --strict 已验证）。
import * as PIXI from 'pixi.js'
// Hiyori 等官方样例是 Cubism 4，走 /cubism4 入口。
// ⚠️ 运行时必须已存在全局 window.Live2DCubismCore（由 index.html 预加载 public/cubism-core/live2dcubismcore.min.js 提供）。
import { Live2DModel } from 'pixi-live2d-display/cubism4'

// pixi-live2d-display 通过 window.PIXI.Ticker 自动驱动模型更新，必须暴露。
;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI

export interface ModelExpression {
  name: string
  file: string
}


export interface ModelMeta {
  width: number
  height: number
  // 动作组：键为组名（如 Idle / TapBody），值为该组动作定义数组。
  motions: Record<string, unknown[]>
  expressions: ModelExpression[]
}

export class Live2d {
  private app: PIXI.Application | null = null
  // 精确类型（pixi-live2d-display@0.4.0 已导出 Live2DModel）。
  private model: Live2DModel | null = null
  // 加载/resize 时的 contain 基准缩放，zoom 相对它计算。
  private baseScale = 0
  // 伪表情在 Cubism 每帧提交前回写，避免动作/眨眼覆盖；销毁模型时必须解绑。
  private paramOverrides: Record<string, number> = {}
  private faceTimer: number | undefined
  private paramHook: { off: (event: string, listener: () => void) => void } | null = null
  private paramListener: (() => void) | null = null

  initApp(canvas: HTMLCanvasElement): void {
    // PIXI v6/v7 通用构造器写法（v8 才改 await app.init()）。backgroundAlpha:0 保证透明。
    this.app = new PIXI.Application({
      view: canvas,
      backgroundAlpha: 0,
      resizeTo: window,
      resolution: window.devicePixelRatio || 1,
      antialias: true,
      autoStart: true,
    })
  }

  async load(path: string): Promise<ModelMeta> {
    if (!this.app) throw new Error('Live2d.initApp() 必须先调用')
    // 先加载新模型，失败时保留当前模型，避免换装/换角色失败后出现空白窗口。
    const next = await Live2DModel.from(path)
    if (this.model) this.destroy()
    // path 为最终可访问 URL（Cubism 4 的 .model3.json）。
    // 本地模型需经 Tauri convertFileSrc 转 asset:// 后传入（在调用方处理，本方法只认 URL）。
    this.model = next
    this.app.stage.addChild(this.model)
    const meta = this.scanMeta()
    this.resizeModel(meta)
    return meta
  }

  private scanMeta(): ModelMeta {
    const m = this.model
    const motions: Record<string, unknown[]> = {}
    const rawMotions = (m as unknown as { motions?: Record<string, unknown[]> })?.motions
    if (rawMotions && typeof rawMotions === 'object') {
      for (const k of Object.keys(rawMotions)) motions[k] = rawMotions[k]
    }
    const expressions: ModelExpression[] = []
    const rawExpr = (m as unknown as { expressions?: ModelExpression[] })?.expressions
    if (Array.isArray(rawExpr)) {
      for (const e of rawExpr) expressions.push({ name: e?.name ?? '', file: e?.file ?? '' })
    }
    return {
      width: m?.width ?? 0,
      height: m?.height ?? 0,
      motions,
      expressions,
    }
  }

  resizeModel(size: ModelMeta): void {
    if (!this.model || !this.app) return
    const sw = this.app.screen.width
    const sh = this.app.screen.height
    // contain 缩放（Math.min 保证宽高都不溢出 → 全身可见），留 4% 边距。
    if (this.baseScale <= 0) {
      this.baseScale = Math.min(sw / (size.width || 1), sh / (size.height || 1)) * 0.96
    }
    this.model.scale.set(this.baseScale * this.zoom)
    this.model.anchor.set(0.5, 0.5)
    this.model.x = sw / 2
    this.model.y = sh / 2
  }

  // ── M2 互动 ───────────────────────────────────────────────
  /** 命中检测：返回点 (x,y) 命中的 hit area 名称数组（model3.json 的 HitAreas.Name）。空数组=未命中。 */
  hitTest(x: number, y: number): string[] {
    return this.model?.hitTest(x, y) ?? []
  }

  /**
   * 宽松命中：点是否落在模型可见包围盒内（world space，即 canvas CSS 像素）。
   * 用途：Hiyori 的 HitAreas 只有 Body 一个且边界较紧，仅靠 hitTest 会出现「点身体没反应」；
   * 桌宠场景下凡是点在模型范围内都应给反馈，故用包围盒兜底。
   */
  containsPoint(x: number, y: number): boolean {
    if (!this.model) return false
    const b = this.model.getBounds()
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
  }

  /** 当前模型的 world-space 包围盒，供聊天气泡和自动行为布局使用。 */
  getBounds(): { x: number; y: number; width: number; height: number } {
    const b = this.model?.getBounds()
    return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { x: 0, y: 0, width: 0, height: 0 }
  }

  // ── M4 互动扩展：注视 / 缩放 / 伪表情 ───────────────────────

  /** 视线跟随：眼睛与头部看向 (x,y)（world space）。底层 Live2DModel.focus 内部自行做坐标转换。 */
  focus(x: number, y: number): void {
    this.model?.focus(x, y)
  }

  /** 当前模型中心点（world space）。 */
  getPosition(): { x: number; y: number } {
    return { x: this.model?.x ?? 0, y: this.model?.y ?? 0 }
  }

  /** 设置模型中心点；自动行为使用，坐标始终限制在 canvas 内。 */
  setPosition(x: number, y: number): void {
    if (!this.model || !this.app) return
    const b = this.model.getBounds()
    const halfW = b.width / 2
    const halfH = b.height / 2
    this.model.x = Math.max(halfW, Math.min(this.app.screen.width - halfW, x))
    this.model.y = Math.max(halfH, Math.min(this.app.screen.height - halfH, y))
  }

  /** 当前缩放倍率（1 = 加载时 contain 基准）。 */
  get zoom(): number {
    if (!this.model) return 1
    return this.model.scale.x / (this.baseScale || 1)
  }

  /** 设置缩放倍率，范围钳制 [0.35, 3]，缩放围绕模型锚点（中心）。 */
  setZoom(z: number): void {
    if (!this.model) return
    const clamped = Math.max(0.35, Math.min(3, z))
    this.model.scale.set((this.baseScale || 1) * clamped)
  }

  /** 参数化表情：不依赖 .exp3.json，Hiyori/Rice 等单表情模型也可用。 */
  applyFace(name: 'smile' | 'surprise' | 'blush' | 'wink' | 'reset', durationMs = 2500): void {
    if (!this.model) return
    this.ensureParamHook()
    if (this.faceTimer) clearTimeout(this.faceTimer)
    if (name === 'reset') {
      this.paramOverrides = {}
      return
    }
    const set = (id: string, ratio: number) => {
      const { min, max } = this.getParameterRange(id)
      const value = min + (max - min) * ratio
      if (Number.isFinite(value)) this.paramOverrides[id] = value
    }
    switch (name) {
      case 'smile':
        set('ParamMouthForm', 1)
        set('ParamEyeLOpen', 0.9)
        set('ParamEyeROpen', 0.9)
        set('ParamEyeLSmile', 1)
        set('ParamEyeRSmile', 1)
        break
      case 'surprise':
        set('ParamMouthOpenY', 0.8)
        set('ParamEyeLOpen', 1)
        set('ParamEyeROpen', 1)
        set('ParamBrowLY', 0.8)
        set('ParamBrowRY', 0.8)
        break
      case 'blush':
        set('ParamCheek', 1)
        set('ParamMouthForm', 0.8)
        break
      case 'wink':
        set('ParamEyeLOpen', 1)
        set('ParamEyeROpen', 0)
        set('ParamMouthForm', 0.9)
        break
    }
    this.faceTimer = window.setTimeout(() => {
      this.paramOverrides = {}
      this.faceTimer = undefined
    }, durationMs)
  }

  /** 在 beforeModelUpdate 回写，确保覆盖动作、原生表情、眨眼和注视的本帧结果。 */
  private ensureParamHook(): void {
    if (this.paramHook || !this.model) return
    const internal = this.model.internalModel as unknown as {
      on: (event: string, listener: () => void) => void
      off: (event: string, listener: () => void) => void
      coreModel: { setParameterValueById: (id: string, value: number) => void }
    }
    const listener = () => {
      for (const values of [this.paramOverrides]) {
        for (const [id, value] of Object.entries(values)) {
          if (Number.isFinite(value)) internal.coreModel.setParameterValueById(id, value)
        }
      }
    }
    internal.on('beforeModelUpdate', listener)
    this.paramHook = internal
    this.paramListener = listener
  }

  /** 列出所有动作组名（如 ['Idle','TapBody']）。 */
  getMotionGroups(): string[] {
    const raw = (this.model as unknown as { motions?: Record<string, unknown[]> })?.motions
    return raw ? Object.keys(raw) : []
  }

  /** 随机播一个动作组里的某个动作；组不存在则静默。 */
  async playMotionRandom(group: string): Promise<void> {
    const raw = (this.model as unknown as { motions?: Record<string, unknown[]> })?.motions
    const arr = raw?.[group]
    if (Array.isArray(arr) && arr.length) {
      const i = Math.floor(Math.random() * arr.length)
      await this.playMotion(group, i)
    }
  }

  /** 随机播一个表情；无表情则静默。 */
  async playExpressionRandom(): Promise<void> {
    const exprs = (this.model as unknown as { expressions?: ModelExpression[] })?.expressions
    if (Array.isArray(exprs) && exprs.length) {
      const i = Math.floor(Math.random() * exprs.length)
      await this.playExpressions(i)
    }
  }

  async playMotion(group: string, index: number): Promise<void> {
    if (this.model) await this.model.motion(group, index)
  }

  async playExpressions(index: number): Promise<void> {
    if (this.model) this.model.expression(index)
  }

  getParameterRange(id: string): { min: number; max: number } {
    // Cubism Core 的 min/max API 接受参数索引，不接受字符串 ID。
    const cm = (this.model?.internalModel as unknown as { coreModel?: {
      getParameterIndex: (id: string) => number
      getParameterCount: () => number
      getParameterMinimumValue: (index: number) => number
      getParameterMaximumValue: (index: number) => number
    } })?.coreModel
    try {
      if (cm) {
        const index = cm.getParameterIndex(id)
        if (index >= 0 && index < cm.getParameterCount()) {
          const min = cm.getParameterMinimumValue(index)
          const max = cm.getParameterMaximumValue(index)
          if (Number.isFinite(min) && Number.isFinite(max) && max > min) return { min, max }
        }
      }
    } catch {
      /* 使用安全默认范围 */
    }
    return { min: 0, max: 1 }
  }

  setParameterValue(id: string, value: number | boolean): void {
    const coreModel = (this.model?.internalModel as unknown as {
      coreModel?: { setParameterValueById: (id: string, value: number) => void }
    })?.coreModel
    if (!coreModel) return
    coreModel.setParameterValueById(id, typeof value === 'boolean' ? Number(value) : value)
  }

  destroy(): void {
    if (this.faceTimer) clearTimeout(this.faceTimer)
    if (this.paramHook && this.paramListener) this.paramHook.off('beforeModelUpdate', this.paramListener)
    this.faceTimer = undefined
    this.paramHook = null
    this.paramListener = null
    this.paramOverrides = {}
    if (this.model) {
      this.app?.stage.removeChild(this.model)
      this.model.destroy()
      this.model = null
    }
    this.baseScale = 0
  }
}
