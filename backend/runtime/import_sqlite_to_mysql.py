"""One-time, insert-only migration from the deployed SQLite portal database."""

import json
import os
import sqlite3
import sys
from pathlib import Path

from sqlalchemy import MetaData, Table, create_engine, inspect, select, text

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'backend' / 'main'))
from backend.runtime.mysql_config import load_database_url
from backend.runtime.ids import next_id

os.environ['DATABASE_URL'] = load_database_url(ROOT).render_as_string(hide_password=False)
from app.db import Base, engine
from app import models, portal_models  # register mapped tables


def main():
    source_path = ROOT / 'data' / 'clinical.db'
    if not source_path.is_file():
        raise RuntimeError(f'Legacy SQLite database is missing: {source_path}')
    if engine.url.database != 'simcare':
        raise RuntimeError('The importer only targets the simcare database')
    source = sqlite3.connect(f'file:{source_path.as_posix()}?mode=ro', uri=True)
    source.row_factory = sqlite3.Row
    tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    counts = {}
    try:
        Base.metadata.create_all(engine)
        with engine.begin() as destination:
            destination.execute(text('CREATE TABLE IF NOT EXISTS language_unification (id BIGINT NOT NULL PRIMARY KEY, attempt_id VARCHAR(64) NOT NULL UNIQUE, engine_id VARCHAR(128), engine_url VARCHAR(255), create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6))'))
            destination.execute(text('CREATE TABLE IF NOT EXISTS attempt_language (id BIGINT NOT NULL PRIMARY KEY, attempt_id VARCHAR(64) NOT NULL UNIQUE, language VARCHAR(8) NOT NULL, case_version VARCHAR(32), case_name VARCHAR(255), english_package JSON, provenance VARCHAR(128), create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6))'))
        metadata = MetaData()
        order = ('users', 'cases', 'assignments', 'training_sessions', 'audit_events',
                 'portal_documents', 'portal_attempts', 'knowledge_items',
                 'language_unification', 'attempt_language')
        with engine.begin() as destination:
            for name in order:
                if name not in tables:
                    continue
                table = Table(name, metadata, autoload_with=engine)
                natural_key = 'attempt_id' if name in ('language_unification', 'attempt_language') else 'item_key' if name == 'knowledge_items' else 'id'
                existing = destination.execute(select(table.c[natural_key])).scalars().all()
                existing = set(existing)
                json_fields = {column.name for column in table.columns if column.type.__class__.__name__ == 'JSON'}
                transferred = 0
                for row in source.execute(f'SELECT * FROM {name}'):
                    values = dict(row)
                    if (values['id'] if name == 'knowledge_items' else values[natural_key]) in existing:
                        continue
                    if name == 'knowledge_items':
                        values['item_key'], values['id'] = values['id'], str(next_id())
                    elif name in ('language_unification', 'attempt_language'):
                        values['id'] = next_id()
                    for key in json_fields & values.keys():
                        if isinstance(values[key], str):
                            values[key] = json.loads(values[key])
                    destination.execute(table.insert().values(**values))
                    existing.add(values[natural_key])
                    transferred += 1
                counts[name] = transferred
    finally:
        source.close()
    print('Imported rows:', counts)


if __name__ == '__main__':
    main()
