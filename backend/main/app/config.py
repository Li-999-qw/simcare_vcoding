from dataclasses import dataclass
import os
import sys
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[1] / ".env")
PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))
from backend.runtime.mysql_config import load_database_url


def database_url():
    value = os.getenv("DATABASE_URL") or load_database_url(PROJECT_ROOT).render_as_string(hide_password=False)
    if not value.startswith("mysql+pymysql://"):
        raise RuntimeError("SimCare requires the simcare MySQL database")
    return value


@dataclass(frozen=True)
class Settings:
    database_url: str = database_url()
    app_secret: str = os.getenv("APP_SECRET", "development-only-change-before-deploying")
    access_token_hours: int = int(os.getenv("ACCESS_TOKEN_HOURS", "12"))
    dialogue_engine_url: str = os.getenv("DIALOGUE_ENGINE_URL", "http://127.0.0.1:28765")
    dialogue_engine_origin: str = os.getenv("DIALOGUE_ENGINE_ORIGIN", "http://127.0.0.1:28765")
    dialogue_public_url: str = os.getenv("DIALOGUE_PUBLIC_URL", "http://127.0.0.1:28765")


settings = Settings()
