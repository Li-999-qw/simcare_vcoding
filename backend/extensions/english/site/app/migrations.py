"""Startup migration for pilot SQLite/PostgreSQL database columns。"""
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
        for table, columns in REQUIRED_COLUMNS.items():
            existing = {column["name"] for column in inspector.get_columns(table)}
            for name, definition in columns.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {definition}"))
