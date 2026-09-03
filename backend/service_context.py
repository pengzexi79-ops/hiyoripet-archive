# backend/service_context.py
# 服务定位器：加载配置并构建 LLM/TTS/ASR 单例（工厂 + Protocol，见 ARCHITECTURE L2/L1）。
from config_manager import load_config, AppConfig
from llm.llm_factory import build_llm
from tts.tts_factory import build_tts
from asr.asr_factory import build_asr


class ServiceContext:
    def __init__(self, config: AppConfig | None = None):
        self.config = config or load_config()
        llm_cfg = self.config.llm_configs.get(self.config.default_llm)
        tts_cfg = self.config.tts_configs.get(self.config.default_tts)
        asr_cfg = self.config.asr_configs.get(self.config.default_asr)
        if llm_cfg is None or tts_cfg is None or asr_cfg is None:
            raise RuntimeError("配置缺失：default_llm/tts/asr 必须对应已定义的 configs")
        self.llm = build_llm(self.config.default_llm, llm_cfg)
        self.tts = build_tts(self.config.default_tts, tts_cfg)
        self.asr = build_asr(self.config.default_asr, asr_cfg)
        # 短期对话历史（M3 后续移入 backend/memory SQLite）
        self.history: list[dict] = []


_sc: "ServiceContext | None" = None


def get_service_context() -> ServiceContext:
    global _sc
    if _sc is None:
        _sc = ServiceContext()
    return _sc
