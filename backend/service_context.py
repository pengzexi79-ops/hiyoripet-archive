# Service locator for AI capabilities and runtime user API settings.
from api_provider import ApiSettings, UniversalLLM, clear_user_settings, load_user_settings, save_user_settings
from asr.asr_factory import build_asr
from config_manager import AppConfig, load_config
from llm.llm_factory import build_llm
from tts.tts_factory import build_tts


class ServiceContext:
    def __init__(self, config: AppConfig | None = None):
        self.config = config or load_config()
        tts_cfg = self.config.tts_configs.get(self.config.default_tts)
        asr_cfg = self.config.asr_configs.get(self.config.default_asr)
        if tts_cfg is None or asr_cfg is None:
            raise RuntimeError("配置缺失：default_tts/asr 必须对应已定义的 configs")
        self.tts = build_tts(self.config.default_tts, tts_cfg)
        self.asr = build_asr(self.config.default_asr, asr_cfg)
        self.history: list[dict] = []
        self.user_api = load_user_settings()
        self._load_llm()

    def _load_llm(self) -> None:
        if self.user_api:
            self.llm = UniversalLLM(self.user_api)
            return
        cfg = self.config.llm_configs.get(self.config.default_llm)
        if cfg is None:
            raise RuntimeError("配置缺失：default_llm 必须对应已定义的 configs")
        self.llm = build_llm(self.config.default_llm, cfg)

    def api_status(self) -> dict:
        if self.user_api:
            return {
                "configured": True,
                "protocol": self.user_api.protocol,
                "base_url": self.user_api.base_url,
                "model": self.user_api.model,
                "source": "user",
            }
        cfg = self.config.llm_configs.get(self.config.default_llm)
        configured = bool(cfg and cfg.api_key)
        return {
            "configured": configured,
            "protocol": cfg.provider if configured else "openai-compatible",
            "base_url": cfg.base_url if configured else "",
            "model": cfg.model if configured else "",
            "source": "environment" if configured else "local",
        }

    def save_api(self, protocol: str, base_url: str, api_key: str, model: str) -> dict:
        if not api_key.strip() and self.user_api:
            api_key = self.user_api.api_key
        settings = ApiSettings(protocol, base_url, api_key, model).validate()
        save_user_settings(settings)
        self.user_api = settings
        self.llm = UniversalLLM(settings)
        return self.api_status()

    def clear_api(self) -> dict:
        clear_user_settings()
        self.user_api = None
        self._load_llm()
        return self.api_status()


_sc: "ServiceContext | None" = None


def get_service_context() -> ServiceContext:
    global _sc
    if _sc is None:
        _sc = ServiceContext()
    return _sc
