# backend/server.py
# FastAPI + WebSocket conversation service (contract: docs/CONTRACTS.md C2).
import json
from datetime import datetime

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


def _local_reply(text: str, degraded: bool = False) -> str:
    """No-key/offline fallback so the packaged pet remains conversational."""
    normalized = text.strip().lower()
    if any(word in normalized for word in ("你好", "嗨", "hello", "hi")):
        return "你好呀，我是日和～今天也会在桌面上陪着你。"
    if any(word in normalized for word in ("时间", "几点", "日期", "今天几号")):
        return f"现在是 {datetime.now():%Y年%m月%d日 %H:%M}，别忘了休息一下呀。"
    if any(word in normalized for word in ("累", "困", "烦", "难过", "不开心")):
        return "辛苦啦。先慢慢呼吸一下，我会安静陪着你，也可以再和我说说。"
    if any(word in normalized for word in ("谢谢", "再见", "晚安")):
        return "不用客气～我就在桌面边上，想我时再点一下。"
    if degraded:
        return "联网对话暂时不可用，我先用本地陪伴模式陪你。再点点我，也许会有新动作哦～"
    return "我听见啦～现在是本地陪伴模式；配置 FOXTOKEN_KEY 后，我还能回答更多问题。"


def _llm_available(sc) -> bool:
    cfg = sc.config.llm_configs.get(sc.config.default_llm)
    return bool(cfg and cfg.api_key)


@app.get("/health")
async def health():
    sc = get_service_context()
    return {"status": "ok", "llm": "remote" if _llm_available(sc) else "local"}


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
                    {"type": "error", "message": "本地 ASR 暂未启用，请先直接输入文字。"}
                )
            elif mtype == "interrupt":
                pass
            else:
                await ws.send_json({"type": "error", "message": f"未知消息类型: {mtype}"})
    except WebSocketDisconnect:
        pass


async def _handle_text(ws, sc, text: str):
    if not text:
        await ws.send_json({"type": "error", "message": "请输入想说的话"})
        return
    sc.history.append({"role": "user", "content": text})
    if not _llm_available(sc):
        reply = _local_reply(text)
        sc.history.append({"role": "assistant", "content": reply})
        await ws.send_json({"type": "ai-response", "text": reply, "emotion": "normal"})
        return

    messages = [{"role": "system", "content": _system_prompt()}] + sc.history[-20:]
    try:
        acc = ""
        async for piece in sc.llm.chat_iter(messages):
            acc += piece
            await ws.send_json({"type": "ai-response", "text": piece, "emotion": "normal"})
        sc.history.append({"role": "assistant", "content": acc})
    except Exception:
        reply = _local_reply(text, degraded=True)
        sc.history.append({"role": "assistant", "content": reply})
        await ws.send_json({"type": "ai-response", "text": reply, "emotion": "normal"})
