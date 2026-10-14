"""Check the live schema and rollback trial application inserts."""

import os
import sys
from pathlib import Path

from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import Session

from backend.runtime.ids import MAX_ID
from backend.runtime.mysql_config import load_database_url

ROOT = Path(__file__).resolve().parents[2]
os.environ["DATABASE_URL"] = load_database_url(ROOT).render_as_string(hide_password=False)
sys.path.insert(0, str(ROOT / "backend" / "main"))
from app.models import User  # noqa: E402
from app.portal_models import KnowledgeItem, PortalAttempt  # noqa: E402


def main():
    engine = create_engine(load_database_url(ROOT), pool_pre_ping=True)
    inspector = inspect(engine)
    names = inspector.get_table_names()
    with engine.connect() as connection:
        for name in names:
            pk = inspector.get_pk_constraint(name)["constrained_columns"]
            columns = {column["name"] for column in inspector.get_columns(name)}
            if pk != ["id"] or not {"create_time", "update_time"} <= columns:
                raise AssertionError(f"Invalid schema: {name}")
            nulls = connection.execute(text(
                f"SELECT COUNT(*) FROM `{name}` WHERE id IS NULL OR create_time IS NULL OR update_time IS NULL"
            )).scalar_one()
            if nulls:
                raise AssertionError(f"Incomplete rows in {name}: {nulls}")
        connection.commit()
        transaction = connection.begin()
        try:
            with Session(bind=connection) as session:
                user = User(username="__simcare_schema_check__", display_name="Schema Check",
                            password_hash="test", role="student", requested_role="student", status="active")
                session.add(user)
                session.flush()
                assert isinstance(user.id, int) and 0 < user.id <= MAX_ID
                attempt = PortalAttempt(user_id=user.id, task_key="schema-check", case_id=1,
                                        engine_id="schema-check", state={})
                session.add(attempt)
                session.flush()
                assert attempt.id.isdecimal() and 0 < int(attempt.id) <= MAX_ID
                item = KnowledgeItem(item_key="schema-check:" + attempt.id, user_id=user.id,
                                     attempt_id=attempt.id, content={})
                session.add(item)
                session.flush()
                assert item.id.isdecimal() and 0 < int(item.id) <= MAX_ID
                assert session.scalar(select(User).where(User.id == user.id)) is not None
                for table, row_id in (("users", user.id), ("portal_attempts", attempt.id),
                                      ("knowledge_items", item.id)):
                    times = connection.execute(text(
                        f"SELECT create_time,update_time FROM `{table}` WHERE id=:id"
                    ), {"id": row_id}).one()
                    assert all(times)
        finally:
            transaction.rollback()
    print(f"Verified {len(names)} tables, existing timestamps, and rollback-only ORM inserts")


if __name__ == "__main__":
    main()
