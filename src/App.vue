<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi'
import { Live2d, type ModelMeta } from './core/live2d'
import { PetSocket, type WsStatus } from './core/ws'
import { Chat } from './core/chat'

// 模型放置于 public/models/Hiyori/（Vite 构建时拷进 dist/models/，由 Tauri 资源一并打包）。
const MODEL_URL = '/models/Hiyori/Hiyori.model3.json'
// 后端 WS 地址：默认本机 8000；可用 VITE_WS_URL 覆盖（如打包后改为实际地址）。
const WS_URL = (import.meta as unknown as { env?: { VITE_WS_URL?: string } }).env?.VITE_WS_URL || 'ws://localhost:8000/ws'

const canvas = ref<HTMLCanvasElement | null>(null)
const status = ref('初始化中…')
const clickthrough = ref(false)
const clickthroughBusy = ref(false)
const rightClickTimer = ref<number | undefined>(undefined)
const hasCore = ref(true)
const meta = ref<ModelMeta | null>(null)
const lastInteraction = ref(0)

// M3 对话状态
const wsStatus = ref<WsStatus>('closed')
const subtitle = ref('')
const typing = ref(false)
const inputText = ref('')
const wsError = ref('')
// 调试 HUD 默认隐藏：桌宠画面上不显示任何 UI（此前底部白色面板会挡住模型下半身且碍眼）。
// ── 桌宠交互：仅保留 Hiyori，缩放由滚轮控制 ──
const guideVisible = ref(true)
const reaction = ref<{ text: string; x: number; y: number } | null>(null)
const chatBubbleVisible = ref(false)
const bubblePos = ref({ x: 0, y: 0, side: 'right' as 'left' | 'right' })
const petLabelVisible = ref(false)
const zoomLevel = ref(1)

let pet: Live2d | null = null
let socket: PetSocket | null = null
let chat: Chat | null = null
let idleTimer: number | undefined
let guideTimer: number | undefined
let reactionTimer: number | undefined
let behaviorTimer: number | undefined
let wanderTarget: { x: number; y: number } | null = null
let desktopWanderTarget: { x: number; y: number } | null = null
let desktopPosition: { x: number; y: number } | null = null
let desktopMoveBusy = false
let rightClickCount = 0
let stopPetVisibilityListener: UnlistenFn | undefined
let press: { pointerId: number; clientX: number; clientY: number; x: number; y: number } | null = null
let stopClickthroughListener: UnlistenFn | undefined
let stopWindowMovedListener: UnlistenFn | undefined

async function loadModel() {
  if (!pet) return
  try {
    status.value = '加载模型中…'
    const m = await pet.load(MODEL_URL)
    meta.value = m
    lastInteraction.value = Date.now()
    petLabelVisible.value = true
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
  startBehavior()
  guideTimer = window.setTimeout(() => (guideVisible.value = false), 8000)
  window.addEventListener('keydown', onKey)
  // 浏览器预览没有 Tauri IPC；仅在桌面壳中订阅托盘/原生快捷操作的同步事件。
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    const appWindow = getCurrentWindow()
    const initialPosition = await appWindow.outerPosition().catch(() => null)
    if (initialPosition) desktopPosition = { x: initialPosition.x, y: initialPosition.y }
    stopWindowMovedListener = await appWindow.onMoved(({ payload }) => {
      desktopPosition = { x: payload.x, y: payload.y }
    })
    stopClickthroughListener = await listen<boolean>('clickthrough-changed', (event) => {
      clickthrough.value = event.payload
      status.value = event.payload ? '穿透中：请用托盘关闭' : '可交互（可拖动）'
    })
    stopPetVisibilityListener = await listen('pet-opened', () => {
      petLabelVisible.value = true
      status.value = 'pet 已打开'
      lastInteraction.value = Date.now()
      desktopWanderTarget = null
      startBehavior()
    })
  }
  // M3：建立后端对话通道
  window.addEventListener('resize', positionBubble)
  window.addEventListener('pet-api-action', onApiAction as EventListener)
  ;(window as Window & { petApi?: { dispatch: (action: PetApiAction) => void } }).petApi = {
    dispatch: (action) => window.dispatchEvent(new CustomEvent('pet-api-action', { detail: action })),
  }
  connectChat()
})

// Esc 关闭气泡；其余交互由鼠标完成
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
  if (e.key === 'Escape') closeBubble()
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  stopClickthroughListener?.()
  stopClickthroughListener = undefined
  stopPetVisibilityListener?.()
  stopPetVisibilityListener = undefined
  stopWindowMovedListener?.()
  stopWindowMovedListener = undefined
  window.removeEventListener('resize', positionBubble)
  window.removeEventListener('pet-api-action', onApiAction as EventListener)
  delete (window as Window & { petApi?: unknown }).petApi
  if (guideTimer) clearTimeout(guideTimer)
  if (rightClickTimer.value) clearTimeout(rightClickTimer.value)
  if (reactionTimer) clearTimeout(reactionTimer)
  stopBehavior()
  stopIdle()
  chat?.destroy()
  socket?.close()
  pet?.destroy()
  pet = null
  socket = null
  chat = null
})

function connectChat() {
  if (!pet) return
  socket = new PetSocket(WS_URL)
  socket.onStatus((s) => {
    wsStatus.value = s
    if (s === 'open') wsError.value = ''
  })
  chat = new Chat(socket, pet, {
    onSubtitle: (t) => {
      subtitle.value = t
      openBubble()
    },
    onTyping: (b) => (typing.value = b),
    onError: (m) => {
      wsError.value = m
      subtitle.value = ''
      openBubble()
    },
  })
  socket.connect()
}

function sendText() {
  const text = inputText.value.trim()
  if (!text || !chat) return
  subtitle.value = ''
  wsError.value = ''
  openBubble()
  chat.sendText(text)
  inputText.value = ''
  lastInteraction.value = Date.now()
}

// ── M2：空闲自播待机动作（数据流 C）──
function startIdle() {
  stopIdle()
  idleTimer = window.setInterval(() => {
    if (clickthrough.value || !pet) return
    const idle = Date.now() - lastInteraction.value > 8000
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

async function stepDesktopWander() {
  if (!pet || desktopMoveBusy) return
  desktopMoveBusy = true
  try {
    const appWindow = getCurrentWindow()
    if (!desktopPosition) {
      const position = await appWindow.outerPosition()
      desktopPosition = { x: position.x, y: position.y }
    }
    if (!desktopWanderTarget) {
      const [monitor, size] = await Promise.all([currentMonitor(), appWindow.outerSize()])
      if (!monitor) return
      const minX = monitor.workArea.position.x
      const minY = monitor.workArea.position.y
      const maxX = Math.max(minX, minX + monitor.workArea.size.width - size.width)
      const maxY = Math.max(minY, minY + monitor.workArea.size.height - size.height)
      desktopWanderTarget = {
        x: Math.round(minX + Math.random() * Math.max(1, maxX - minX)),
        y: Math.round(minY + Math.random() * Math.max(1, maxY - minY)),
      }
      pet.playMotionRandom('Idle').catch(() => {})
      if (Math.random() < 0.65) pet.applyFace(FACES[Math.floor(Math.random() * FACES.length)])
    }
    const dx = desktopWanderTarget.x - desktopPosition.x
    const dy = desktopWanderTarget.y - desktopPosition.y
    const distance = Math.hypot(dx, dy)
    if (distance < 5) {
      desktopWanderTarget = null
      lastInteraction.value = Date.now()
      return
    }
    const step = Math.min(3, distance)
    desktopPosition = {
      x: Math.round(desktopPosition.x + dx / distance * step),
      y: Math.round(desktopPosition.y + dy / distance * step),
    }
    await appWindow.setPosition(new PhysicalPosition(desktopPosition.x, desktopPosition.y))
  } finally {
    desktopMoveBusy = false
  }
}

function startBehavior() {
  stopBehavior()
  behaviorTimer = window.setInterval(() => {
    if (!pet || clickthrough.value || chatBubbleVisible.value || press) return
    if (Date.now() - lastInteraction.value < 12000) return
    if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      void stepDesktopWander()
      return
    }
    const b = pet.getBounds()
    const halfW = Math.max(48, b.width / 2)
    const halfH = Math.max(80, b.height / 2)
    if (!wanderTarget) {
      wanderTarget = {
        x: halfW + 12 + Math.random() * Math.max(1, window.innerWidth - halfW * 2 - 24),
        y: halfH + 12 + Math.random() * Math.max(1, window.innerHeight - halfH * 2 - 24),
      }
      pet.playMotionRandom('Idle').catch(() => {})
    }
    const p = pet.getPosition()
    const dx = wanderTarget.x - p.x
    const dy = wanderTarget.y - p.y
    const distance = Math.hypot(dx, dy)
    if (distance < 8) {
      wanderTarget = null
      lastInteraction.value = Date.now()
    } else pet.setPosition(p.x + dx / distance * 3, p.y + dy / distance * 3)
  }, 120)
}
function stopBehavior() {
  if (behaviorTimer) clearInterval(behaviorTimer)
  behaviorTimer = undefined
  wanderTarget = null
  desktopWanderTarget = null
}

// ── M2：点击互动（数据流 A）──
function randomFace() {
  if (!pet) return
  pet.applyFace(FACES[Math.floor(Math.random() * FACES.length)])
  status.value = '换了个表情～'
  lastInteraction.value = Date.now()
}

function showReaction(x: number, y: number) {
  const marks = ['💗', '✨', '♪', '！']
  reaction.value = { text: marks[Math.floor(Math.random() * marks.length)], x, y }
  if (reactionTimer) clearTimeout(reactionTimer)
  reactionTimer = window.setTimeout(() => (reaction.value = null), 900)
}

type PetApiAction =
  | { type: 'motion'; group: string }
  | { type: 'face'; name: 'smile' | 'surprise' | 'blush' | 'wink' }
  | { type: 'say'; text: string }

function onApiAction(event: Event) {
  const action = (event as CustomEvent<PetApiAction>).detail
  if (!pet || !action) return
  lastInteraction.value = Date.now()
  if (action.type === 'motion') pet.playMotionRandom(action.group).catch(() => {})
  if (action.type === 'face') pet.applyFace(action.name)
  if (action.type === 'say') {
    subtitle.value = action.text
    openBubble()
  }
}

function positionBubble() {
  if (!pet) return
  const b = pet.getBounds()
  const width = 236
  const height = 142
  const gap = 12
  const right = window.innerWidth - (b.x + b.width)
  const side = right >= width + gap ? 'right' : 'left'
  const rawX = side === 'right' ? b.x + b.width + gap : b.x - width - gap
  bubblePos.value = {
    x: Math.max(8, Math.min(rawX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(b.y + b.height * 0.2, window.innerHeight - height - 8)),
    side,
  }
}
function openBubble() {
  petLabelVisible.value = true
  chatBubbleVisible.value = true
  positionBubble()
}
function closeBubble() {
  chatBubbleVisible.value = false
}
async function closePet() {
  closeBubble()
  petLabelVisible.value = false
  stopBehavior()
  desktopWanderTarget = null
  await getCurrentWindow().hide().catch(() => {})
}

async function resizeForZoom(nextZoom: number) {
  if (!pet) return
  zoomLevel.value = Math.max(0.65, Math.min(2.2, nextZoom))
  const targetWidth = Math.round(360 * zoomLevel.value)
  const targetHeight = Math.round(600 * zoomLevel.value)
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    const appWindow = getCurrentWindow()
    const [beforePosition, beforeSize] = await Promise.all([
      appWindow.outerPosition().catch(() => null),
      appWindow.outerSize().catch(() => null),
    ])
    await appWindow.setSize(new LogicalSize(targetWidth, targetHeight)).catch(() => {})
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    pet.setZoom(zoomLevel.value)
    if (meta.value) pet.resizeModel(meta.value)
    if (beforePosition && beforeSize) {
      const afterSize = await appWindow.outerSize().catch(() => null)
      if (afterSize) {
        const nextPosition = {
          x: Math.round(beforePosition.x + (beforeSize.width - afterSize.width) / 2),
          y: Math.round(beforePosition.y + beforeSize.height - afterSize.height),
        }
        await appWindow.setPosition(new PhysicalPosition(nextPosition.x, nextPosition.y)).catch(() => {})
        desktopPosition = nextPosition
      }
    }
  } else {
    pet.setZoom(zoomLevel.value)
  }
  positionBubble()
}

function interactAt(x: number, y: number) {
  if (!pet) return
  const hits = pet.hitTest(x, y)
  if (!hits.length && !pet.containsPoint(x, y)) return
  pet.focus(x, y)
  openBubble()
  showReaction(x, y)
  lastInteraction.value = Date.now()
  status.value = hits.includes('Head') ? '摸摸头～' : hits.includes('Body') ? '被摸到了～' : '戳到啦～'
  pet.playMotionRandom('TapBody').catch(() => {})
  if (meta.value?.expressions.length) pet.playExpressionRandom().catch(() => {})
  else randomFace()
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || clickthroughBusy.value || clickthrough.value || !pet) return
  closeBubble()
  desktopWanderTarget = null
  guideVisible.value = false
  canvas.value?.setPointerCapture(e.pointerId)
  press = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, x: e.offsetX, y: e.offsetY }
  pet.focus(e.offsetX, e.offsetY)
}

// 移动超过阈值才拖窗；短按到 pointerup 才互动，避免 startDragging 吞掉单击/右键。
function onPointerMove(e: PointerEvent) {
  if (clickthroughBusy.value || clickthrough.value || !pet) return
  pet.focus(e.offsetX, e.offsetY)
  if (!press || press.pointerId !== e.pointerId) return
  if (Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY) < 7) return
  press = null
  desktopWanderTarget = null
  lastInteraction.value = Date.now()
  void getCurrentWindow().startDragging().catch(() => {})
}
function onPointerUp(e: PointerEvent) {
  if (canvas.value?.hasPointerCapture(e.pointerId)) canvas.value.releasePointerCapture(e.pointerId)
  if (!press || press.pointerId !== e.pointerId) return
  const p = press
  press = null
  if (Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) < 7) interactAt(p.x, p.y)
}
function onPointerCancel(e: PointerEvent) {
  if (canvas.value?.hasPointerCapture(e.pointerId)) canvas.value.releasePointerCapture(e.pointerId)
  press = null
}

function onWheel(e: WheelEvent) {
  void resizeForZoom(zoomLevel.value * (e.deltaY > 0 ? 0.9 : 1.1))
  lastInteraction.value = Date.now()
}

function onContextMenu() {
  rightClickCount += 1
  if (rightClickTimer.value) clearTimeout(rightClickTimer.value)
  rightClickTimer.value = window.setTimeout(() => { rightClickCount = 0 }, 360)
  if (rightClickCount === 2) {
    rightClickCount = 0
    if (clickthrough.value) void toggle()
    return
  }
  if (!clickthrough.value) void toggle()
}

async function toggle() {
  if (clickthroughBusy.value) return
  const next = !clickthrough.value
  clickthroughBusy.value = true
  closeBubble()
  try {
    await invoke('toggle_clickthrough', { enabled: next })
    clickthrough.value = next
    status.value = next ? '穿透中：请用托盘关闭（窗口暂不可点击）' : '可交互（可拖动）'
    guideVisible.value = !next
    lastInteraction.value = Date.now()
  } catch (e) {
    status.value = `穿透切换失败：${(e as Error)?.message ?? e}`
  } finally {
    clickthroughBusy.value = false
  }
}

</script>

<template>
  <div class="wrapper">
    <canvas
      ref="canvas"
      class="stage"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @contextmenu.prevent.stop="onContextMenu"
      @wheel.prevent.stop="onWheel"
    ></canvas>

    <div
      v-if="reaction"
      class="reaction"
      :style="{ left: reaction.x + 'px', top: reaction.y + 'px' }"
    >{{ reaction.text }}</div>
    <div v-if="petLabelVisible" class="pet-label">pet</div>
    <div
      v-if="chatBubbleVisible"
      class="chat-bubble"
      :class="bubblePos.side"
      :style="{ left: bubblePos.x + 'px', top: bubblePos.y + 'px' }"
      @pointerdown.stop
      @click.stop
    >
      <div class="bubble-head"><strong>pet</strong><button type="button" @click="closeBubble">×</button></div>
      <div v-if="subtitle" class="bubble-text">{{ subtitle }}<span v-if="typing" class="caret">▌</span></div>
      <div class="bubble-input-row">
        <input v-model="inputText" type="text" placeholder="和日和聊聊…" @keydown.enter="sendText" />
        <button type="button" @click="sendText">发送</button>
      </div>
      <button class="dismiss-pet" type="button" @click="closePet">取消宠物</button>
      <div v-if="wsError" class="bubble-error">⚠ {{ wsError }}</div>
    </div>
    <div v-if="guideVisible" class="guide">点击宠物互动 · 按住拖动 · 滚轮缩放 · 右键开启穿透</div>

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
  background: transparent !important;
}
.stage {
  width: 100%;
  height: 100%;
  display: block;
  background: transparent !important;
  touch-action: none;
}
.pet-label {
  position: absolute;
  left: 10px;
  top: 10px;
  z-index: 20;
  padding: 4px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  color: #3d526b;
  font-size: 11px;
  letter-spacing: 0.08em;
  pointer-events: none;
}
.chat-bubble {
  position: absolute;
  z-index: 60;
  width: 236px;
  box-sizing: border-box;
  padding: 9px;
  border: 1px solid rgba(91, 117, 145, 0.18);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.96);
  color: #2f435a;
  box-shadow: 0 8px 24px rgba(31, 55, 78, 0.2);
}
.chat-bubble::after {
  content: '';
  position: absolute;
  top: 28px;
  width: 12px;
  height: 12px;
  background: inherit;
  border-left: inherit;
  border-bottom: inherit;
  transform: rotate(45deg);
}
.chat-bubble.right::after { left: -7px; }
.chat-bubble.left::after { right: -7px; transform: rotate(225deg); }
.bubble-head, .bubble-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bubble-head { justify-content: space-between; margin-bottom: 6px; }
.bubble-head button {
  border: 0; background: transparent; color: #8493a3; font-size: 18px; cursor: pointer;
}
.bubble-text {
  min-height: 28px;
  max-height: 72px;
  overflow: auto;
  margin-bottom: 7px;
  font-size: 13px;
  line-height: 1.45;
}
.bubble-input-row input {
  min-width: 0; flex: 1; padding: 6px 8px; border: 1px solid #d7e0e8; border-radius: 9px; outline: none;
}
.bubble-input-row button, .dismiss-pet {
  border: 0; border-radius: 9px; padding: 6px 8px; background: #6f9bc5; color: white; cursor: pointer;
}
.dismiss-pet {
  margin-top: 7px; background: transparent; color: #8898a8; font-size: 11px; padding: 2px 0;
}
.bubble-error { margin-top: 5px; color: #e74c3c; font-size: 11px; }
.subtitle {
  position: absolute;
  left: 50%;
  top: 12%;
  transform: translateX(-50%);
  max-width: 80%;
  background: rgba(255, 255, 255, 0.85);
  color: #234;
  padding: 6px 12px;
  border-radius: 12px;
  font-size: 14px;
  text-align: center;
  pointer-events: none;
}
.caret {
  opacity: 0.5;
}
.reaction {
  position: absolute;
  z-index: 40;
  transform: translate(-50%, -70%);
  font-size: 26px;
  pointer-events: none;
  animation: pop-away 0.9s ease-out forwards;
}
@keyframes pop-away {
  0% { opacity: 0; transform: translate(-50%, -40%) scale(0.6); }
  25% { opacity: 1; transform: translate(-50%, -80%) scale(1.15); }
  100% { opacity: 0; transform: translate(-50%, -150%) scale(0.9); }
}
.guide {
  position: absolute;
  z-index: 50;
  left: 50%;
  bottom: 48px;
  transform: translateX(-50%);
  width: max-content;
  max-width: calc(100vw - 56px);
  padding: 5px 9px;
  border-radius: 12px;
  background: rgba(35, 45, 58, 0.78);
  color: white;
  font-size: 11px;
  text-align: center;
  pointer-events: none;
}
</style>
