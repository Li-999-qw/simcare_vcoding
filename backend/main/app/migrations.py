"""轻量级启动迁移：为试运行阶段的 SQLite/PostgreSQL 数据库补齐新增列。"""
from sqlalchemy import inspect, text

from .db import Base, engine


REQUIRED_COLUMNS = {
    "users": {"requested_role": "VARCHAR(16) DEFAULT 'student' NOT NULL", "profile": "JSON DEFAULT '{}'"},
    "cases": {"engine_key": "VARCHAR(48)"},
    "training_sessions": {"engine_session_id": "VARCHAR(128)"},
}


def upgrade_schema():
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    with engine.begin() as connection:
        if engine.dialect.name == "mysql":
            for table in Base.metadata.tables:
                columns = {column["name"] for column in inspector.get_columns(table)}
                if not {"id", "create_time", "update_time"} <= columns:
                    raise RuntimeError(
                        f"{table} uses an old MySQL schema. Stop services and run "
                        "python -m backend.runtime.normalize_mysql_schema"
                    )
                row = connection.execute(text(f"SHOW COLUMNS FROM `{table}` LIKE 'update_time'")).mappings().one()
                if "on update" not in row["Extra"].lower():
                    connection.execute(text(
                        f"ALTER TABLE `{table}` MODIFY COLUMN update_time DATETIME(6) NOT NULL "
                        "DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
                    ))
        for table, columns in REQUIRED_COLUMNS.items():
            existing = {column["name"] for column in inspector.get_columns(table)}
            for name, definition in columns.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {definition}"))
