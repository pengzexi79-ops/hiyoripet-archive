<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi'
import { Live2d, type ModelMeta } from './core/live2d'
import { PetSocket, type WsStatus } from './core/ws'
import { Chat } from './core/chat'
import { clearApiConfig, fetchApiStatus, saveApiConfig, type ApiProtocol, type ApiStatus } from './core/api'

// 模型放置于 public/models/Hiyori/（Vite 构建时拷进 dist/models/，由 Tauri 资源一并打包）。
const MODEL_URL = '/models/Hiyori/Hiyori.model3.json'
// 后端 WS 地址：默认本机 8000；可用 VITE_WS_URL 覆盖（如打包后改为实际地址）。
const WS_URL = (import.meta as unknown as { env?: { VITE_WS_URL?: string } }).env?.VITE_WS_URL || 'ws://localhost:8000/ws'

const canvas = ref<HTMLCanvasElement | null>(null)
const status = ref('初始化中…')
const clickthrough = ref(false)
const clickthroughBusy = ref(false)
const hasCore = ref(true)
const meta = ref<ModelMeta | null>(null)
const lastUserInteraction = ref(0)

// M3 对话状态
const wsStatus = ref<WsStatus>('closed')
const subtitle = ref('')
const typing = ref(false)
const inputText = ref('')
const wsError = ref('')
const apiStatus = ref<ApiStatus>({ configured: false, protocol: 'openai-compatible', base_url: '', model: '', source: 'local' })
const apiPanelVisible = ref(false)
const apiSaving = ref(false)
const apiError = ref('')
type ApiPreset = { id: string; label: string; protocol: ApiProtocol; baseUrl: string }
const API_PRESETS: ApiPreset[] = [
  { id: 'custom', label: '自定义接口（其他官方 / 中转）', protocol: 'openai-compatible', baseUrl: '' },
  { id: 'openai', label: '国外 · OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: '国外 · Anthropic Claude', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: '国外 · Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'openrouter', label: '国外 / 聚合 · OpenRouter', protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', label: '国内 · DeepSeek', protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com' },
  { id: 'dashscope', label: '国内 · 通义千问 / 百炼', protocol: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'zhipu', label: '国内 · 智谱 GLM', protocol: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'siliconflow', label: '国内 / 聚合 · 硅基流动', protocol: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1' },
]
const apiPreset = ref('custom')
const apiForm = ref({ protocol: 'openai-compatible' as ApiProtocol, base_url: '', api_key: '', model: '' })
// 调试 HUD 默认隐藏：桌宠画面上不显示任何 UI（此前底部白色面板会挡住模型下半身且碍眼）。
// ── 桌宠交互：仅保留 Hiyori，缩放由滚轮控制 ──
const guideVisible = ref(true)
const reaction = ref<{ text: string; x: number; y: number } | null>(null)
const chatBubbleVisible = ref(false)
const bubblePos = ref({ x: 0, y: 0, side: 'right' as 'left' | 'right' })
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
let nextWanderAt = 0
let tapCount = 0
let stopPetVisibilityListener: UnlistenFn | undefined
let stopPetHiddenListener: UnlistenFn | undefined
let press: { pointerId: number; clientX: number; clientY: number; x: number; y: number } | null = null
let stopClickthroughListener: UnlistenFn | undefined
let stopWindowMovedListener: UnlistenFn | undefined

async function loadModel() {
  if (!pet) return
  try {
    status.value = '加载模型中…'
    const m = await pet.load(MODEL_URL)
    meta.value = m
    lastUserInteraction.value = Date.now()
    nextWanderAt = Date.now() + 12000
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
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
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
      status.value = event.payload ? '穿透中：在日和区域再次右键可退出' : '可交互（可拖动）'
    })
    stopPetVisibilityListener = await listen('pet-opened', () => {
      status.value = '桌宠已打开'
      lastUserInteraction.value = Date.now()
      nextWanderAt = Date.now() + 12000
      desktopWanderTarget = null
      startBehavior()
    })
    stopPetHiddenListener = await listen('pet-hidden', () => {
      closeBubble()
      stopBehavior()
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
  stopPetHiddenListener?.()
  stopPetHiddenListener = undefined
  stopWindowMovedListener?.()
  stopWindowMovedListener = undefined
  window.removeEventListener('resize', positionBubble)
  window.removeEventListener('pet-api-action', onApiAction as EventListener)
  delete (window as Window & { petApi?: unknown }).petApi
  if (guideTimer) clearTimeout(guideTimer)
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
    onApiStatus: applyApiStatus,
  })
  socket.connect()
  void fetchApiStatus().then(applyApiStatus).catch(() => {})
}

function applyApiStatus(next: ApiStatus) {
  apiStatus.value = next
  if (next.configured) {
    apiForm.value.protocol = (next.protocol as ApiProtocol) || 'openai-compatible'
    apiForm.value.base_url = next.base_url
    apiForm.value.model = next.model
    const normalized = next.base_url.replace(/\/$/, '')
    apiPreset.value = API_PRESETS.find((preset) => preset.baseUrl === normalized)?.id ?? 'custom'
  }
}

function openApiPanel() {
  apiError.value = ''
  apiPanelVisible.value = true
  lastUserInteraction.value = Date.now()
}

function closeApiPanel() {
  apiPanelVisible.value = false
  apiError.value = ''
}

function selectApiPreset() {
  const preset = API_PRESETS.find((item) => item.id === apiPreset.value)
  if (!preset) return
  apiForm.value.protocol = preset.protocol
  apiForm.value.base_url = preset.baseUrl
  apiForm.value.model = ''
}

async function saveApi() {
  apiSaving.value = true
  apiError.value = ''
  try {
    applyApiStatus(await saveApiConfig(apiForm.value))
    closeApiPanel()
    wsError.value = ''
    subtitle.value = 'API 已保存，下次对话会使用新配置。'
  } catch (e) {
    apiError.value = (e as Error)?.message ?? String(e)
  } finally {
    apiSaving.value = false
  }
}

async function clearApi() {
  apiSaving.value = true
  apiError.value = ''
  try {
    applyApiStatus(await clearApiConfig())
    apiForm.value.api_key = ''
    closeApiPanel()
    subtitle.value = '已清除 API，当前使用本地陪伴模式。'
  } catch (e) {
    apiError.value = (e as Error)?.message ?? String(e)
  } finally {
    apiSaving.value = false
  }
}

function sendText() {
  const text = inputText.value.trim()
  if (!text || !chat) return
  subtitle.value = ''
  wsError.value = ''
  openBubble()
  chat.sendText(text)
  inputText.value = ''
  lastUserInteraction.value = Date.now()
}

// ── M2：空闲自播待机动作（数据流 C）──
function startIdle() {
  stopIdle()
  idleTimer = window.setInterval(() => {
    if (clickthrough.value || !pet) return
    const idle = Date.now() - lastUserInteraction.value > 8000
    if (idle) {
      pet.playMotionRandom('Idle').catch(() => {})
      if (Math.random() < 0.45) pet.applyFace(FACES[Math.floor(Math.random() * FACES.length)])
      if (Math.random() < 0.3) {
        const b = pet.getBounds()
        showReaction(b.x + b.width / 2, b.y + b.height * 0.18)
      }
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
      if (Date.now() < nextWanderAt) return
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
      nextWanderAt = Date.now() + 3000 + Math.random() * 6000
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
    if (Date.now() - lastUserInteraction.value < 12000) return
    if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      void stepDesktopWander()
      return
    }
    const b = pet.getBounds()
    const halfW = Math.max(48, b.width / 2)
    const halfH = Math.max(80, b.height / 2)
    if (!wanderTarget) {
      if (Date.now() < nextWanderAt) return
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
      nextWanderAt = Date.now() + 3000 + Math.random() * 6000
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
  lastUserInteraction.value = Date.now()
}

function showReaction(x: number, y: number) {
  const marks = ['💗', '✨', '♪', '！', '🌸', '😊', '～']
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
  lastUserInteraction.value = Date.now()
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
  const width = Math.min(236, Math.max(120, window.innerWidth - 16))
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
  chatBubbleVisible.value = true
  positionBubble()
}
function closeBubble() {
  chatBubbleVisible.value = false
  apiPanelVisible.value = false
}
async function closePet() {
  closeBubble()
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
  lastUserInteraction.value = Date.now()
  status.value = hits.includes('Head') ? '摸摸头～' : hits.includes('Body') ? '被摸到了～' : '戳到啦～'
  tapCount += 1
  pet.playMotionRandom(tapCount % 3 === 0 || Math.random() < 0.35 ? 'Idle' : 'TapBody').catch(() => {})
  if (meta.value?.expressions.length && Math.random() < 0.35) pet.playExpressionRandom().catch(() => {})
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
  lastUserInteraction.value = Date.now()
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
  lastUserInteraction.value = Date.now()
}

function onContextMenu() {
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
    status.value = next ? '穿透中：在日和区域再次右键可退出' : '可交互（可拖动）'
    guideVisible.value = !next
    lastUserInteraction.value = Date.now()
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

    <div v-if="apiPanelVisible" class="api-panel" @pointerdown.stop @click.stop>
      <div class="panel-head">
        <strong>连接 AI 对话</strong>
        <button type="button" class="icon-button" aria-label="关闭 API 设置" @click="closeApiPanel">×</button>
      </div>
      <label>服务 / 模型来源
        <select v-model="apiPreset" @change="selectApiPreset">
          <option v-for="preset in API_PRESETS" :key="preset.id" :value="preset.id">{{ preset.label }}</option>
        </select>
      </label>
      <label>协议
        <select v-model="apiForm.protocol">
          <option value="openai-compatible">OpenAI / 中转（兼容接口）</option>
          <option value="anthropic-messages">Anthropic Messages</option>
          <option value="gemini">Google Gemini</option>
        </select>
      </label>
      <label>接口地址
        <input v-model="apiForm.base_url" type="url" placeholder="https://api.openai.com/v1" />
      </label>
      <label>模型名称
        <input v-model="apiForm.model" type="text" placeholder="填写该服务控制台中的模型 ID" />
      </label>
      <label>API Key
        <input v-model="apiForm.api_key" type="password" placeholder="已保存可留空" autocomplete="off" />
      </label>
      <div class="api-actions">
        <button type="button" class="primary-action" :disabled="apiSaving" @click="saveApi">保存连接</button>
        <button type="button" class="secondary-action" :disabled="apiSaving || !apiStatus.configured" @click="clearApi">清除 API</button>
      </div>
      <div v-if="apiError" class="bubble-error">⚠ {{ apiError }}</div>
      <small>内置常用国内外服务；“自定义接口”可填写其他官方或中转地址。模型 ID 始终可自行输入。</small>
    </div>

    <div
      v-if="reaction"
      class="reaction"
      :style="{ left: reaction.x + 'px', top: reaction.y + 'px' }"
    >{{ reaction.text }}</div>
    <div
      v-if="chatBubbleVisible"
      class="chat-bubble"
      :class="bubblePos.side"
      :style="{ left: bubblePos.x + 'px', top: bubblePos.y + 'px' }"
      @pointerdown.stop
      @click.stop
    >
      <div class="bubble-head"><strong>日和</strong><button type="button" @click="closeBubble">×</button></div>
      <button v-if="!apiStatus.configured" type="button" class="api-status" @click="openApiPanel">
        <span>当前未接入 API</span><span>添加 API ›</span>
      </button>
      <button v-else type="button" class="api-status connected" @click="openApiPanel">
        <span>API 已接入 · {{ apiStatus.model }}</span><span>修改 ›</span>
      </button>
      <div v-if="subtitle" class="bubble-text">{{ subtitle }}<span v-if="typing" class="caret">▌</span></div>
      <div class="bubble-input-row">
        <input v-model="inputText" type="text" placeholder="和日和聊聊…" @keydown.enter="sendText" />
        <button type="button" @click="sendText">发送</button>
      </div>
      <button class="dismiss-pet" type="button" @click="closePet">隐藏桌宠</button>
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
.chat-bubble {
  position: absolute;
  z-index: 60;
  width: min(236px, calc(100vw - 16px));
  box-sizing: border-box;
  padding: 9px;
  border: 1px solid rgba(91, 117, 145, 0.18);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.96);
  color: #2f435a;
  box-shadow: 0 8px 24px rgba(31, 55, 78, 0.2);
}
.api-panel { position: absolute; z-index: 80; left: 50%; top: 50%; width: min(286px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: auto; box-sizing: border-box; transform: translate(-50%, -50%); padding: 14px; border: 1px solid rgba(91, 117, 145, 0.2); border-radius: 16px; background: rgba(255, 255, 255, 0.98); color: #2f435a; box-shadow: 0 10px 30px rgba(31, 55, 78, 0.24); }
.panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.icon-button { border: 0; background: transparent; color: #8493a3; font-size: 20px; cursor: pointer; }
.api-panel label { display: block; margin: 8px 0; color: #637489; font-size: 11px; }
.api-panel input, .api-panel select { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 7px 8px; border: 1px solid #d7e0e8; border-radius: 8px; outline: none; color: #2f435a; background: white; }
.api-actions { display: flex; gap: 8px; margin-top: 10px; }
.api-actions button { flex: 1; border: 0; border-radius: 9px; padding: 7px 8px; cursor: pointer; }
.primary-action { background: #6f9bc5; color: white; }
.secondary-action { background: #eef2f6; color: #637489; }
.api-actions button:disabled { cursor: wait; opacity: 0.55; }
.api-panel small { display: block; margin-top: 9px; color: #8a98a6; font-size: 10px; line-height: 1.4; }
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
.api-status { display: flex; width: 100%; justify-content: space-between; gap: 8px; margin: 0 0 8px; padding: 6px 8px; border: 1px solid #f0d9a6; border-radius: 8px; background: #fff8e8; color: #9a6d24; font-size: 11px; text-align: left; cursor: pointer; }
.api-status.connected { border-color: #c7e4d2; background: #f0faf4; color: #3f8058; }
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
