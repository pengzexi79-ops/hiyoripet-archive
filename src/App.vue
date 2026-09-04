<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
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
// 按 H 键唤出/收起。
const hudVisible = ref(false)

let pet: Live2d | null = null
let socket: PetSocket | null = null
let chat: Chat | null = null
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
  window.addEventListener('keydown', onKey)
  // M3：建立后端对话通道
  connectChat()
})

// H 键唤出/收起调试 HUD（输入框聚焦时不拦截，避免打字打不出 h）
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
  if (e.key === 'h' || e.key === 'H') hudVisible.value = !hudVisible.value
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
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
    onSubtitle: (t) => (subtitle.value = t),
    onTyping: (b) => (typing.value = b),
    onError: (m) => {
      wsError.value = m
      subtitle.value = ''
    },
  })
  socket.connect()
}

function sendText() {
  const text = inputText.value.trim()
  if (!text || !chat) return
  subtitle.value = ''
  wsError.value = ''
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

// ── M2：点击互动（数据流 A）──
async function onPointerDown(e: PointerEvent) {
  if (clickthrough.value || !pet) return
  const x = e.offsetX
  const y = e.offsetY
  const hits = pet.hitTest(x, y)
  // 宽松命中：精确命中 Body，或落在模型包围盒内 → 都给互动反馈
  // （Hiyori 的 HitAreas 仅 Body 一个且边界紧，纯 hitTest 会导致点身体没反应）
  if (hits.includes('Body') || pet.containsPoint(x, y)) {
    lastInteraction.value = Date.now()
    status.value = hits.includes('Body') ? '被摸到了～' : '戳到啦～'
    pet.playMotionRandom('TapBody').catch(() => {})
    // 注：Hiyori 无表情文件（Expressions 为空），playExpressionRandom 会静默跳过
    if (Math.random() < 0.4) pet.playExpressionRandom().catch(() => {})
  }
  // 任意位置都允许拖动窗口（点在模型上也能拖着走），解决「拖不动」
  await getCurrentWindow().startDragging()
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

function testMotion(group: string) {
  lastInteraction.value = Date.now()
  pet?.playMotionRandom(group)
}
function testExpression() {
  lastInteraction.value = Date.now()
  pet?.playExpressionRandom()
}

const wsDot: Record<WsStatus, string> = {
  connecting: '#f0a020',
  open: '#2ecc71',
  closed: '#999',
  error: '#e74c3c',
}
</script>

<template>
  <div class="wrapper">
    <canvas ref="canvas" class="stage" @pointerdown="onPointerDown"></canvas>

    <div v-if="subtitle" class="subtitle">{{ subtitle }}<span v-if="typing" class="caret">▌</span></div>

    <!-- 调试 HUD：默认隐藏（按 H 唤出）。此前它常驻底部，白色面板既碍眼又挡住模型下半身。 -->
    <div v-if="hudVisible" class="hud" :class="{ disabled: !hasCore }">
      <div class="status">
        {{ status }}
        <span class="ws" :style="{ background: wsDot[wsStatus] }" :title="`后端：${wsStatus}`"></span>
      </div>
      <button v-if="hasCore" @mousedown.stop @click="toggle">切换穿透</button>

      <div v-if="meta" class="row">
        <span class="lbl">动作</span>
        <button v-for="g in Object.keys(meta.motions)" :key="g" @mousedown.stop @click="testMotion(g)">{{ g }}</button>
      </div>
      <div v-if="meta && meta.expressions.length" class="row">
        <span class="lbl">表情</span>
        <button @mousedown.stop @click="testExpression">随机</button>
      </div>

      <div class="row chat">
        <input
          v-model="inputText"
          class="chat-input"
          type="text"
          placeholder="和桌宠说点什么…"
          @mousedown.stop
          @keydown.enter="sendText"
        />
        <button @mousedown.stop @click="sendText">发送</button>
      </div>
      <div v-if="wsError" class="err">⚠ {{ wsError }}</div>

      <div class="tip">点模型→互动 · 任意位置按住可拖窗口 · 按 H 收起本面板 · 右键托盘退出</div>
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
  max-width: 300px;
  pointer-events: auto;
}
.hud.disabled {
  opacity: 0.7;
}
.hud button {
  margin: 3px 2px 0;
  cursor: pointer;
}
.hud .ws {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 6px;
  vertical-align: middle;
}
.row {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  justify-content: center;
  align-items: center;
}
.row.chat {
  margin-top: 6px;
}
.chat-input {
  flex: 1;
  min-width: 120px;
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid #cdd;
  border-radius: 6px;
}
.lbl {
  opacity: 0.6;
  margin-right: 2px;
}
.tip {
  margin-top: 4px;
  opacity: 0.6;
}
.err {
  margin-top: 4px;
  color: #e74c3c;
}
</style>
