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
    if (this.model) this.destroy()
    // path 为最终可访问 URL（Cubism 4 的 .model3.json）。
    // 本地模型需经 Tauri convertFileSrc 转 asset:// 后传入（在调用方处理，本方法只认 URL）。
    this.model = await Live2DModel.from(path)
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
    const scale = Math.min(sw / (size.width || 1), sh / (size.height || 1)) * 0.92
    this.model.scale.set(scale)
    this.model.anchor.set(0.5, 0.5)
    this.model.x = sw / 2
    this.model.y = sh / 2
  }

  // ── M2 互动 ───────────────────────────────────────────────
  /** 命中检测：返回点 (x,y) 命中的 hit area 名称数组（model3.json 的 HitAreas.Name）。空数组=未命中。 */
  hitTest(x: number, y: number): string[] {
    return this.model?.hitTest(x, y) ?? []
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
    // pixi-live2d-display 无直接公开 API，走 internalModel.coreModel（Cubism Core）。
    const internal = (this.model as unknown as { internalModel?: { coreModel?: unknown } })?.internalModel
    const cm = internal?.coreModel as
      | { getParameterMinimumValue?: (id: string) => number; getParameterMaximumValue?: (id: string) => number }
      | undefined
    try {
      if (cm?.getParameterMinimumValue && cm?.getParameterMaximumValue) {
        return { min: cm.getParameterMinimumValue(id), max: cm.getParameterMaximumValue(id) }
      }
    } catch {
      /* ignore */
    }
    return { min: 0, max: 1 }
  }

  setParameterValue(id: string, value: number | boolean): void {
    if (!this.model) return
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : value
    // Live2DModel.setParameterValue 在 0.4.0 通过内部代理暴露，用可选链兜底。
    const setter = (this.model as unknown as { setParameterValue?: (id: string, v: number) => void })
      .setParameterValue
    setter?.(id, v)
  }

  destroy(): void {
    if (this.model) {
      this.app?.stage.removeChild(this.model)
      this.model.destroy()
      this.model = null
    }
  }
}
