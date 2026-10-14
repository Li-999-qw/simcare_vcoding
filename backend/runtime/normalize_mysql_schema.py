"""One-time, repeatable normalization of the existing simcare MySQL tables.

Run backup_mysql first and stop application writers before running this script.
Existing IDs and row contents are retained; only tables without an id receive
new application-generated IDs.
"""

from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from backend.runtime.ids import next_id
from backend.runtime.mysql_config import load_database_url

ROOT = Path(__file__).resolve().parents[2]
NATURAL_KEYS = {
    "application_settings": ("setting_key",),
    "attempt_language": ("attempt_id",),
    "case_content": ("engine_key",),
    "engine_attempt_links": ("engine_key", "student_task"),
    "engine_imports": ("engine_key",),
    "engine_sessions": ("engine_key", "session_id"),
    "language_unification": ("attempt_id",),
}
BIGINT_FOREIGN_COLUMNS = {
    "assignments": ("case_id", "student_id", "teacher_id"),
    "audit_events": ("actor_id",),
    "cases": ("created_by",),
    "knowledge_items": ("user_id",),
    "portal_attempts": ("user_id",),
    "training_sessions": ("assignment_id", "student_id"),
}
EXPECTED_FOREIGN_KEYS = (
    ("assignments", "assignments_ibfk_1", "case_id", "cases", "id"),
    ("assignments", "assignments_ibfk_2", "student_id", "users", "id"),
    ("assignments", "assignments_ibfk_3", "teacher_id", "users", "id"),
    ("audit_events", "audit_events_ibfk_1", "actor_id", "users", "id"),
    ("cases", "cases_ibfk_1", "created_by", "users", "id"),
    ("training_sessions", "training_sessions_ibfk_1", "assignment_id", "assignments", "id"),
    ("training_sessions", "training_sessions_ibfk_2", "student_id", "users", "id"),
)


def quote(name):
    if not name.replace("_", "").isalnum():
        raise ValueError(f"Unexpected SQL identifier: {name}")
    return f"`{name}`"


def execute(connection, statement, params=None):
    connection.execute(text(statement), params or {})


def current_columns(connection, table):
    rows = connection.execute(text(f"SHOW COLUMNS FROM {quote(table)}")).mappings()
    return {row["Field"]: row for row in rows}


def foreign_keys(connection):
    return connection.execute(text("""
        SELECT k.TABLE_NAME AS table_name, k.CONSTRAINT_NAME AS constraint_name,
               k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_NAME AS reference_table,
               k.REFERENCED_COLUMN_NAME AS reference_column,
               r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA
         AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
         AND r.TABLE_NAME=k.TABLE_NAME
        WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION
    """)).mappings().all()


def add_id(connection, table, keys):
    columns = current_columns(connection, table)
    if "id" not in columns:
        execute(connection, f"ALTER TABLE {quote(table)} ADD COLUMN id BIGINT NULL FIRST")
    rows = connection.execute(text(
        f"SELECT {','.join(quote(key) for key in keys)} FROM {quote(table)} WHERE id IS NULL"
    )).mappings().all()
    for row in rows:
        predicate = " AND ".join(f"{quote(key)}=:{key}" for key in keys)
        execute(connection, f"UPDATE {quote(table)} SET id=:new_id WHERE {predicate}",
                {"new_id": next_id(), **dict(row)})
    unique_name = "uq_" + table + "_natural"
    indexes = connection.execute(text(f"SHOW INDEX FROM {quote(table)}")).mappings().all()
    if unique_name not in {row["Key_name"] for row in indexes}:
        execute(connection, f"ALTER TABLE {quote(table)} ADD UNIQUE KEY {quote(unique_name)} "
                            f"({','.join(quote(key) for key in keys)})")
    primary = [row["Column_name"] for row in indexes if row["Key_name"] == "PRIMARY"]
    if primary != ["id"]:
        execute(connection, f"ALTER TABLE {quote(table)} MODIFY COLUMN id BIGINT NOT NULL, "
                            "DROP PRIMARY KEY, ADD PRIMARY KEY (id)")


def add_times(connection, table):
    columns = current_columns(connection, table)
    if "create_time" not in columns:
        execute(connection, f"ALTER TABLE {quote(table)} ADD COLUMN create_time DATETIME(6) "
                            "NOT NULL DEFAULT CURRENT_TIMESTAMP(6)")
        original = "created_at" if "created_at" in columns else "imported_at" if "imported_at" in columns else None
        if original:
            execute(connection, f"UPDATE {quote(table)} SET create_time={quote(original)}")
    if "update_time" not in columns:
        execute(connection, f"ALTER TABLE {quote(table)} ADD COLUMN update_time DATETIME(6) "
                            "NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)")
        original = "updated_at" if "updated_at" in columns else "created_at" if "created_at" in columns else "imported_at" if "imported_at" in columns else None
        if original:
            execute(connection, f"UPDATE {quote(table)} SET update_time={quote(original)}")


def normalize():
    engine = create_engine(load_database_url(ROOT), pool_pre_ping=True)
    if engine.url.database != "simcare":
        raise RuntimeError("This migration only targets simcare")
    with engine.connect() as connection:
        tables = sorted(inspect(engine).get_table_names())
        if set(NATURAL_KEYS) - set(tables):
            raise RuntimeError("Expected tables are missing; initialize the application first")
        before = {table: connection.execute(text(f"SELECT COUNT(*) FROM {quote(table)}")).scalar_one()
                  for table in tables}
        constraints = foreign_keys(connection)
        groups = {}
        for row in constraints:
            groups.setdefault((row["table_name"], row["constraint_name"]), []).append(row)
        for table, name in groups:
            execute(connection, f"ALTER TABLE {quote(table)} DROP FOREIGN KEY {quote(name)}")
        for table in tables:
            add_times(connection, table)
            if table in NATURAL_KEYS:
                add_id(connection, table, NATURAL_KEYS[table])
            columns = current_columns(connection, table)
            if "id" in columns and columns["id"]["Type"].lower().startswith("int"):
                execute(connection, f"ALTER TABLE {quote(table)} MODIFY COLUMN id BIGINT NOT NULL")
            for column in BIGINT_FOREIGN_COLUMNS.get(table, ()):
                if column in columns and columns[column]["Type"].lower().startswith("int"):
                    nullable = "NULL" if columns[column]["Null"] == "YES" else "NOT NULL"
                    execute(connection, f"ALTER TABLE {quote(table)} MODIFY COLUMN {quote(column)} BIGINT {nullable}")
            if table == "knowledge_items":
                if "item_key" not in columns:
                    execute(connection, "ALTER TABLE knowledge_items ADD COLUMN item_key VARCHAR(64) NULL")
                execute(connection, "UPDATE knowledge_items SET item_key=id WHERE item_key IS NULL")
                indexes = {row["Key_name"] for row in connection.execute(text("SHOW INDEX FROM knowledge_items")).mappings()}
                if "uq_knowledge_items_item_key" not in indexes:
                    execute(connection, "ALTER TABLE knowledge_items MODIFY COLUMN item_key VARCHAR(64) NOT NULL, "
                                        "ADD UNIQUE KEY uq_knowledge_items_item_key (item_key)")
        for (table, name), rows in groups.items():
            columns = ",".join(quote(row["column_name"]) for row in rows)
            references = ",".join(quote(row["reference_column"]) for row in rows)
            first = rows[0]
            execute(connection, f"ALTER TABLE {quote(table)} ADD CONSTRAINT {quote(name)} "
                                f"FOREIGN KEY ({columns}) REFERENCES {quote(first['reference_table'])} ({references}) "
                                f"ON UPDATE {first['update_rule']} ON DELETE {first['delete_rule']}")
        current_fks = {(row["table_name"], row["constraint_name"]) for row in foreign_keys(connection)}
        for table, name, column, reference_table, reference_column in EXPECTED_FOREIGN_KEYS:
            if (table, name) not in current_fks and table in tables:
                execute(connection, f"ALTER TABLE {quote(table)} ADD CONSTRAINT {quote(name)} "
                                    f"FOREIGN KEY ({quote(column)}) REFERENCES {quote(reference_table)} "
                                    f"({quote(reference_column)})")
        after = {table: connection.execute(text(f"SELECT COUNT(*) FROM {quote(table)}")).scalar_one()
                 for table in tables}
        if before != after:
            raise RuntimeError(f"Row counts changed: {before} -> {after}")
        inspector = inspect(engine)
        for table in tables:
            pk = inspector.get_pk_constraint(table)["constrained_columns"]
            cols = {column["name"] for column in inspector.get_columns(table)}
            if pk != ["id"] or not {"create_time", "update_time"} <= cols:
                raise RuntimeError(f"Nonstandard table after migration: {table}")
        print(f"Normalized {len(tables)} tables; all row counts preserved: {after}")


if __name__ == "__main__":
    normalize()
