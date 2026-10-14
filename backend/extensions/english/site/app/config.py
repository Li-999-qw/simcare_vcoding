from dataclasses import replace
from app.config import settings as original
settings=replace(original,dialogue_engine_url="http://127.0.0.1:28891",dialogue_engine_origin="http://127.0.0.1:28891",dialogue_public_url="http://127.0.0.1:28891")
