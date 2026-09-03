# backend/server.py
# FastAPI + WebSocket 对话服务（契约见 CONTRACTS C2）。
# 当前 M3-Part1：text-input 文本对话走 foxtoken LLM（流式）；audio 通道为桩。
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from service_context import get_service_context

app = FastAPI(title="pet-backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_SYSTEM = "你是桌面上的一只高互动陪伴桌宠，性格活泼、话少而精。用简体中文，每次回复不超过 60 字。"


def _system_prompt() -> str:
    return get_service_context().config.agent.get("system_prompt") or DEFAULT_SYSTEM


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    sc = get_service_context()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                await ws.send_json({"type": "error", "message": "JSON 解析失败"})
                continue

            mtype = msg.get("type")
            if mtype == "ping":
                await ws.send_json({"type": "pong"})
            elif mtype == "text-input":
                await _handle_text(ws, sc, (msg.get("text") or "").strip())
            elif mtype == "audio-end":
                await ws.send_json(
                    {"type": "error", "message": "本地 ASR 未实现（M3 后续）。请先用 text-input 文本对话。"}
                )
            elif mtype == "interrupt":
                pass  # 当前无后台生成任务可中断
            else:
                await ws.send_json({"type": "error", "message": f"未知消息类型: {mtype}"})
    except WebSocketDisconnect:
        pass


async def _handle_text(ws, sc, text: str):
    if not text:
        await ws.send_json({"type": "error", "message": "text-input 缺少 text"})
        return
    sc.history.append({"role": "user", "content": text})
    messages = [{"role": "system", "content": _system_prompt()}] + sc.history[-20:]
    try:
        acc = ""
        async for piece in sc.llm.chat_iter(messages):
            acc += piece
            await ws.send_json({"type": "ai-response", "text": piece, "emotion": "normal"})
        sc.history.append({"role": "assistant", "content": acc})
    except Exception as e:
        await ws.send_json({"type": "error", "message": f"LLM 调用失败: {e}"})
