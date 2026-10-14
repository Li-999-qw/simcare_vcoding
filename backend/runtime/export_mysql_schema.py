"""Export the verified live MySQL DDL to docs/mysql-schema.sql."""

from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from backend.runtime.mysql_config import load_database_url

ROOT = Path(__file__).resolve().parents[2]


def main():
    engine = create_engine(load_database_url(ROOT), pool_pre_ping=True)
    if engine.url.database != "simcare":
        raise RuntimeError("DDL export only supports simcare")
    lines = ["-- SimCare MySQL schema exported from the verified simcare database.",
             "CREATE DATABASE IF NOT EXISTS `simcare` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
             "USE `simcare`;", "SET FOREIGN_KEY_CHECKS=0;"]
    with engine.connect() as connection:
        for name in sorted(inspect(engine).get_table_names()):
            ddl = connection.execute(text(f"SHOW CREATE TABLE `{name}`")).one()[1]
            lines.append(ddl.replace("CREATE TABLE `", "CREATE TABLE IF NOT EXISTS `", 1) + ";")
    lines.append("SET FOREIGN_KEY_CHECKS=1;")
    output = ROOT / "docs" / "mysql-schema.sql"
    output.write_text("\n\n".join(lines) + "\n", encoding="utf-8")
    print(f"Exported {len(lines) - 5} tables to {output}")


if __name__ == "__main__":
    main()
