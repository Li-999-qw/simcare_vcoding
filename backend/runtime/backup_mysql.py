"""Save a complete, local JSON snapshot before changing the MySQL schema."""

import gzip
import json
from datetime import date, datetime, time
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from backend.runtime.mysql_config import load_database_url

ROOT = Path(__file__).resolve().parents[2]


def _json_default(value):
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return {"__bytes_hex__": value.hex()}
    raise TypeError(type(value).__name__)


def main():
    engine = create_engine(load_database_url(ROOT), pool_pre_ping=True)
    if engine.url.database != "simcare":
        raise RuntimeError("Backups are restricted to the simcare database")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output = ROOT / "data" / f"simcare-before-id-migration-{stamp}.json.gz"
    output.parent.mkdir(exist_ok=True)
    names = sorted(inspect(engine).get_table_names())
    with engine.connect() as connection, gzip.open(output, "wt", encoding="utf-8") as backup:
        backup.write('{"database":"simcare","tables":{')
        for index, name in enumerate(names):
            ddl = connection.execute(text(f"SHOW CREATE TABLE `{name}`")).one()[1]
            rows = connection.execute(text(f"SELECT * FROM `{name}`")).mappings().all()
            if index:
                backup.write(",")
            backup.write(json.dumps(name, ensure_ascii=False) + ":")
            backup.write(json.dumps({"ddl": ddl, "rows": [dict(row) for row in rows]},
                                    ensure_ascii=False, default=_json_default))
        backup.write("}}")
    print(f"Backup saved: {output} ({len(names)} tables)")


if __name__ == "__main__":
    main()
