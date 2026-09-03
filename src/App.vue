<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Live2d, type ModelMeta } from './core/live2d'

// 模型放置于 public/models/Hiyori/（Vite 构建时拷进 dist/models/，由 Tauri 资源一并打包）。
// 资产获取见 docs/DECISIONS.md D7（从 Live2D 官方 SDK 解出的 Cubism 4 样例 Hiyori）。
const MODEL_URL = '/models/Hiyori/Hiyori.model3.json'

const canvas = ref<HTMLCanvasElement | null>(null)
const status = ref('初始化中…')
const clickthrough = ref(false)
const hasCore = ref(true)
const meta = ref<ModelMeta | null>(null)
const lastInteraction = ref(0)

let pet: Live2d | null = null
let idleTimer: number | undefined

async function loadModel() {
  if (!pet) return
  try {
    status.value = '加载模型中…'
    const m = await pet.load(MODEL_URL)
    meta.value = m
    lastInteraction.value = Date.now()
    status.value = `已加载：${Object.keys(m.motions).length} 组动作 / ${m.expressions.length} 个表情`
  } catch (e) {
    status.value = `模型加载失败：${(e as Error)?.message ?? e}（请确认 public/models/Hiyori 已放入资产）`
  }
}

onMounted(async () => {
  if (!canvas.value) return
  // pixi-live2d-display 的 Cubism 4 入口要求全局 window.Live2DCubismCore 已就绪。
  hasCore.value = !!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore
  if (!hasCore.value) {
    status.value = 'Cubism Core 未加载（缺 public/cubism-core/live2dcubismcore.min.js）'
    return
  }
  pet = new Live2d()
  pet.initApp(canvas.value)
  await loadModel()
  startIdle()
})

onBeforeUnmount(() => {
  stopIdle()
  pet?.destroy()
  pet = null
})

// ── M2：空闲自播待机动作（数据流 C）──
function startIdle() {
  stopIdle()
  idleTimer = window.setInterval(() => {
    if (clickthrough.value || !pet) return
    const idle = (Date.now() - lastInteraction.value) > 8000
    if (idle) {
      pet.playMotionRandom('Idle').catch(() => {})
      lastInteraction.value = Date.now()
    }
  }, 8000)
}
function stopIdle() {
  if (idleTimer) {
    clearInterval(idleTimer)
    idleTimer = undefined
  }
}

// ── M2：点击互动（数据流 A）──
async function onPointerDown(e: PointerEvent) {
  if (clickthrough.value || !pet || !canvas.value) return
  const x = e.offsetX
  const y = e.offsetY
  const hits = pet.hitTest(x, y)
  if (hits.includes('Body')) {
    // 戳到身体 → 播放 TapBody 互动动作，偶尔加个表情
    lastInteraction.value = Date.now()
    status.value = '被摸到了～'
    pet.playMotionRandom('TapBody').catch(() => {})
    if (Math.random() < 0.4) pet.playExpressionRandom().catch(() => {})
  } else {
    // 点空白处 → 拖动窗口
    await getCurrentWindow().startDragging()
  }
}

async function toggle() {
  clickthrough.value = !clickthrough.value
  await invoke('toggle_clickthrough', { enabled: clickthrough.value })
  status.value = clickthrough.value ? '穿透中（鼠标可点桌面）' : '可交互（可拖动）'
  lastInteraction.value = Date.now()
}

async function startDrag() {
  if (clickthrough.value) return
  await getCurrentWindow().startDragging()
}

// 手动测试按钮（同时是桌面验收工具）
function testMotion(group: string) {
  lastInteraction.value = Date.now()
  pet?.playMotionRandom(group)
}
function testExpression() {
  lastInteraction.value = Date.now()
  pet?.playExpressionRandom()
}
</script>

<template>
  <div class="wrapper">
    <canvas ref="canvas" class="stage" @pointerdown="onPointerDown"></canvas>
    <div class="hud" :class="{ disabled: !hasCore }">
      <div class="status">{{ status }}</div>
      <button v-if="hasCore" @mousedown.stop @click="toggle">切换穿透</button>
      <div v-if="meta" class="row">
        <span class="lbl">动作</span>
        <button v-for="g in Object.keys(meta.motions)" :key="g" @mousedown.stop @click="testMotion(g)">
          {{ g }}
        </button>
      </div>
      <div v-if="meta && meta.expressions.length" class="row">
        <span class="lbl">表情</span>
        <button @mousedown.stop @click="testExpression">随机</button>
      </div>
      <div class="tip">点模型身体→互动 · 点空白→拖窗口 · 右键托盘退出</div>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
}
body {
  background: transparent;
  overflow: hidden;
  font-family: system-ui, sans-serif;
}
.wrapper {
  width: 100vw;
  height: 100vh;
  position: relative;
}
.stage {
  width: 100%;
  height: 100%;
  display: block;
}
.hud {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  color: #234;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.75);
  padding: 6px 10px;
  border-radius: 8px;
  text-align: center;
  max-width: 280px;
  pointer-events: auto;
}
.hud.disabled {
  opacity: 0.7;
}
.hud button {
  margin: 3px 2px 0;
  cursor: pointer;
}
.row {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  justify-content: center;
  align-items: center;
}
.lbl {
  opacity: 0.6;
  margin-right: 2px;
}
.tip {
  margin-top: 4px;
  opacity: 0.6;
}
</style>
