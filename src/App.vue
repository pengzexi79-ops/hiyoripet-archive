<script setup lang="ts">
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

const clickthrough = ref(false)
const status = ref('可交互（可拖动）')

// 前端 invoke Rust 命令：切换穿透（验证前端→后端命令链路）
async function toggle() {
  clickthrough.value = !clickthrough.value
  await invoke('toggle_clickthrough', { enabled: clickthrough.value })
  status.value = clickthrough.value ? '穿透中（鼠标可点桌面）' : '可交互（可拖动）'
}

// 拖动窗口（仅非穿透时有效）
async function startDrag() {
  if (clickthrough.value) return
  await getCurrentWindow().startDragging()
}
</script>

<template>
  <div class="wrapper">
    <div class="pet" @mousedown="startDrag">🐾</div>
    <div class="hud">
      <div>{{ status }}</div>
      <button @mousedown.stop @click="toggle">切换穿透</button>
      <div class="tip">右键托盘图标可退出 / 切换穿透</div>
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.pet {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #6cf, #39f);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 64px;
  cursor: grab;
  user-select: none;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
}
.pet:active {
  cursor: grabbing;
}
.hud {
  color: #234;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.75);
  padding: 6px 10px;
  border-radius: 8px;
  text-align: center;
  max-width: 220px;
}
.tip {
  margin-top: 4px;
  opacity: 0.6;
}
</style>
