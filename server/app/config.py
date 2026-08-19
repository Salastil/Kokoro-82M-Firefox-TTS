"""Loads (or creates, on first run) the server config file. Kept
outside the repo entirely (under XDG_CONFIG_HOME) so the generated
auth token can never accidentally end up committed to git.
"""
import json
import os
import secrets
from dataclasses import dataclass, asdict
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "kokoro-reader-server"
CONFIG_PATH = CONFIG_DIR / "config.json"


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8787
    token: str = ""
    # Minutes of no synthesis requests before the model is unloaded from
    # memory/VRAM, mirroring Ollama's default keep_alive behavior. 0
    # disables auto-unload (model stays resident indefinitely, the old
    # behavior).
    idle_unload_minutes: float = 5.0


def load_config() -> tuple[Config, Path, bool]:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    is_new = False
    if CONFIG_PATH.exists():
        data = json.loads(CONFIG_PATH.read_text())
        config = Config(**{**asdict(Config()), **data})
    else:
        is_new = True
        config = Config(token=secrets.token_hex(32))

    if not config.token:
        is_new = True
        config.token = secrets.token_hex(32)

    if is_new:
        CONFIG_PATH.write_text(json.dumps(asdict(config), indent=2) + "\n")
        os.chmod(CONFIG_PATH, 0o600)

    # Env overrides are mainly for the systemd unit / quick local testing
    # without hand-editing the config file.
    if os.environ.get("KOKORO_PORT"):
        config.port = int(os.environ["KOKORO_PORT"])
    if os.environ.get("KOKORO_HOST"):
        config.host = os.environ["KOKORO_HOST"]
    if os.environ.get("KOKORO_IDLE_UNLOAD_MINUTES"):
        config.idle_unload_minutes = float(os.environ["KOKORO_IDLE_UNLOAD_MINUTES"])

    return config, CONFIG_PATH, is_new
