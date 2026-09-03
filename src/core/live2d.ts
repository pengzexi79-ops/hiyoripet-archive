// src/core/live2d.ts
// Live2d 单例：PIXI Application + Live2DModel（pixi-live2d-display@0.4.0, PIXI v7）
// 契约见 docs/CONTRACTS.md C1。API 细节以 pixi-live2d-display@0.4.0 实际类型为准（下方「待核实」项须在装好依赖后 tsc 核实）。
import * as PIXI from 'pixi.js'
// Hiyori 等官方样例是 Cubism 4，走 /cubism4 入口。
// ⚠️ 运行时必须已存在全局 window.Live2DCubismCore（由 index.html 预加载 public/cubism-core/live2dcubismcore.min.js 提供）。
import { Live2DModel } from 'pixi-live2d-display/cubism4'

// pixi-live2d-display 通过 window.PIXI.Ticker 自动驱动模型更新，必须暴露。
;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI

export interface ModelMeta {
  width: number
  height: number
  motions: Record<string, unknown> // 动作组，如 tap_body / idle
  expressions: Array<{ name: string; file: string }>
}

export class Live2d {
  private app: PIXI.Application | null = null
  // 待核实：精确类型为 Live2DModel；装好依赖后替换为 import 类型，去掉 any。
  private model: any = null

  initApp(canvas: HTMLCanvasElement): void {
    // PIXI v7 用构造器（v8 才改 await app.init()）。backgroundAlpha:0 保证透明。
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
    const motions: Record<string, unknown> = {}
    if (m?.motions) for (const k of Object.keys(m.motions)) motions[k] = m.motions[k]
    const expressions: Array<{ name: string; file: string }> = []
    if (Array.isArray(m?.expressions)) {
      for (const e of m.expressions) {
        expressions.push({ name: e?.name ?? '', file: e?.file ?? '' })
      }
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

  async playMotion(group: string, index: number): Promise<void> {
    // 待核实：返回 Promise<boolean>；模型无该动作组时静默失败，调用方不依赖返回值。
    if (this.model) await this.model.motion(group, index)
  }

  async playExpressions(index: number): Promise<void> {
    // 待核实：expression 接受数字索引或字符串名。
    if (this.model) this.model.expression(index)
  }

  getParameterRange(id: string): { min: number; max: number } {
    // 待核实：pixi-live2d-display 无直接公开 API，走 internalModel.coreModel（Cubism Core）。
    const m = this.model
    try {
      const cm = m?.internalModel?.coreModel
      if (cm?.getParameterMinimumValue && cm?.getParameterMaximumValue) {
        return {
          min: cm.getParameterMinimumValue(id),
          max: cm.getParameterMaximumValue(id),
        }
      }
    } catch {
      /* ignore */
    }
    return { min: 0, max: 1 }
  }

  setParameterValue(id: string, value: number | boolean): void {
    // 待核实：Live2DModel.setParameterValue(id, number) 是否公开；布尔转 0/1。
    if (!this.model) return
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : value
    this.model.setParameterValue?.(id, v)
  }

  destroy(): void {
    if (this.model) {
      this.app?.stage.removeChild(this.model)
      this.model.destroy()
      this.model = null
    }
  }
}
