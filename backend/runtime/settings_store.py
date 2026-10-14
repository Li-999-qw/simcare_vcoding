"""Editable non-secret application settings in MySQL."""

import json
from pathlib import Path

from sqlalchemy import text

from .engine_store import connection_engine
from .ids import next_id


def read_setting(key: str, seed_file: Path | None = None, default=None):
    with connection_engine().begin() as conn:
        conn.execute(text('''CREATE TABLE IF NOT EXISTS application_settings (
            id BIGINT NOT NULL PRIMARY KEY,
            setting_key VARCHAR(100) NOT NULL UNIQUE,
            value JSON NOT NULL,
            create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) CHARACTER SET utf8mb4'''))
        value = conn.execute(text('SELECT value FROM application_settings WHERE setting_key=:key'), {'key': key}).scalar()
        if value is None:
            seed = json.loads(seed_file.read_text(encoding='utf-8')) if seed_file and seed_file.is_file() else default
            conn.execute(text('INSERT INTO application_settings (id,setting_key,value) VALUES (:id,:key,:value)'),
                         {'id': next_id(), 'key': key, 'value': json.dumps(seed, ensure_ascii=False)})
            return seed
        return json.loads(value) if isinstance(value, str) else value


def save_setting(key: str, value):
    with connection_engine().begin() as conn:
        conn.execute(text('''INSERT INTO application_settings (id,setting_key,value)
            VALUES (:id,:key,:value) ON DUPLICATE KEY UPDATE value=VALUES(value)'''),
            {'id': next_id(), 'key': key, 'value': json.dumps(value, ensure_ascii=False)})
