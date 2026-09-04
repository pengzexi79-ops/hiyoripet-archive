# backend/main.py
# Frozen sidecar entry point used by the Tauri desktop application.
import multiprocessing

import uvicorn

from config_manager import load_config
from server import app


def main() -> None:
    config = load_config()
    uvicorn.run(
        app,
        host=config.server.host,
        port=config.server.port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
