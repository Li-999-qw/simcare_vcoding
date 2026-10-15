"""Read the server-local Spring-style MySQL YAML settings."""

from pathlib import Path
from urllib.parse import urlsplit

from sqlalchemy.engine import URL
import yaml


def load_database_url(project_root: Path) -> URL:
    path = Path(project_root) / "application.yml"
    if not path.is_file():
        raise RuntimeError(f"MySQL configuration is missing: {path}")
    try:
        config = yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}
    except yaml.YAMLError as exc:
        raise RuntimeError(f"Invalid YAML in {path}: {exc}") from exc
    spring = config.get("spring") if isinstance(config, dict) else None
    value = spring.get("datasource") if isinstance(spring, dict) else None
    if not isinstance(value, dict):
        raise RuntimeError("MySQL configuration is incomplete: spring.datasource")
    required = ("url", "username", "password")
    missing = [key for key in required if not value.get(key)]
    if missing:
        raise RuntimeError(f"MySQL configuration is incomplete: {', '.join(missing)}")
    jdbc_url = value["url"]
    if not isinstance(jdbc_url, str) or not jdbc_url.startswith("jdbc:mysql://"):
        raise RuntimeError("MySQL configuration requires a jdbc:mysql:// URL")
    try:
        parsed = urlsplit(jdbc_url.removeprefix("jdbc:"))
        port = parsed.port or 3306
    except ValueError as exc:
        raise RuntimeError("MySQL configuration has an invalid JDBC URL") from exc
    database = parsed.path.removeprefix("/")
    if (parsed.scheme != "mysql" or not parsed.hostname or not database
            or "/" in database or parsed.username or parsed.password or parsed.fragment):
        raise RuntimeError("MySQL configuration has an invalid JDBC URL")
    return URL.create(
        "mysql+pymysql",
        username=value["username"],
        password=value["password"],
        host=parsed.hostname,
        port=port,
        database=database,
        query={"charset": "utf8mb4"},
    )
