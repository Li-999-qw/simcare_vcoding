"""MySQL persistence shared by the seven case engines."""

import json
from pathlib import Path

from sqlalchemy import create_engine, text

from .mysql_config import load_database_url
from .ids import next_id

PROJECT_ROOT = Path(__file__).resolve().parents[2]
_engine = None


def connection_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(load_database_url(PROJECT_ROOT), pool_pre_ping=True)
        with _engine.begin() as conn:
            conn.execute(text('''CREATE TABLE IF NOT EXISTS engine_sessions (
                id BIGINT NOT NULL PRIMARY KEY,
                engine_key VARCHAR(64) NOT NULL,
                session_id VARCHAR(128) NOT NULL,
                state JSON NOT NULL,
                create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_engine_session (engine_key, session_id),
                INDEX ix_engine_sessions_updated (updated_at)
            ) CHARACTER SET utf8mb4'''))
            conn.execute(text('''CREATE TABLE IF NOT EXISTS engine_attempt_links (
                id BIGINT NOT NULL PRIMARY KEY,
                engine_key VARCHAR(64) NOT NULL,
                student_task VARCHAR(128) NOT NULL,
                session_id VARCHAR(128) NOT NULL,
                create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_engine_attempt_link (engine_key, student_task),
                INDEX ix_engine_attempt_session (engine_key, session_id)
            ) CHARACTER SET utf8mb4'''))
            conn.execute(text('''CREATE TABLE IF NOT EXISTS engine_imports (
                id BIGINT NOT NULL PRIMARY KEY,
                engine_key VARCHAR(64) NOT NULL UNIQUE,
                create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) CHARACTER SET utf8mb4'''))
    return _engine


def load_sessions(engine_key: str, legacy_file: Path) -> dict:
    engine = connection_engine()
    with engine.begin() as conn:
        imported = conn.execute(text('SELECT 1 FROM engine_imports WHERE engine_key=:key'), {'key': engine_key}).scalar()
        legacy = json.loads(legacy_file.read_text(encoding='utf-8')) if not imported and legacy_file.is_file() else {}
        rows = conn.execute(text('SELECT session_id, state FROM engine_sessions WHERE engine_key=:key'), {'key': engine_key}).mappings().all()
        sessions = {row['session_id']: json.loads(row['state']) if isinstance(row['state'], str) else row['state'] for row in rows}
        for session_id, state in legacy.items():
            if session_id not in sessions:
                conn.execute(text('INSERT INTO engine_sessions (id,engine_key,session_id,state) VALUES (:row_id,:key,:sid,:state)'),
                             {'row_id': next_id(), 'key': engine_key, 'sid': session_id, 'state': json.dumps(state, ensure_ascii=False)})
                sessions[session_id] = state
        if not imported:
            conn.execute(text('INSERT INTO engine_imports (id,engine_key) VALUES (:id,:key)'), {'id': next_id(), 'key': engine_key})
    return sessions


def save_sessions(engine_key: str, sessions: dict):
    engine = connection_engine()
    with engine.begin() as conn:
        for session_id, state in sessions.items():
            conn.execute(text('''INSERT INTO engine_sessions (id,engine_key,session_id,state)
                VALUES (:row_id,:key,:sid,:state) ON DUPLICATE KEY UPDATE state=VALUES(state)'''),
                {'row_id': next_id(), 'key': engine_key, 'sid': session_id, 'state': json.dumps(state, ensure_ascii=False, default=list)})


def save_attempt_link(engine_key: str, student: str, task: str, session_id: str):
    with connection_engine().begin() as conn:
        conn.execute(text('''INSERT INTO engine_attempt_links (id,engine_key,student_task,session_id)
            VALUES (:id,:key,:student_task,:session_id) ON DUPLICATE KEY UPDATE session_id=VALUES(session_id)'''),
            {'id': next_id(), 'key': engine_key, 'student_task': student + ':' + task, 'session_id': session_id})
