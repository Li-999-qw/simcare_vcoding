"""Read the server-local MySQL connection settings without committing secrets."""

import json
from pathlib import Path

from sqlalchemy.engine import URL


def load_database_url(project_root: Path) -> URL:
    path = Path(project_root) / "data" / "mysql.json"
    if not path.is_file():
        raise RuntimeError(f"MySQL configuration is missing: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    required = ("host", "database", "username", "password")
    missing = [key for key in required if not value.get(key)]
    if missing:
        raise RuntimeError(f"MySQL configuration is incomplete: {', '.join(missing)}")
    return URL.create(
        "mysql+pymysql",
        username=value["username"],
        password=value["password"],
        host=value["host"],
        port=int(value.get("port", 3306)),
        database=value["database"],
        query={"charset": "utf8mb4"},
    )
