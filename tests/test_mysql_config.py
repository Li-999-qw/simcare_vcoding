import json
import tempfile
import unittest
from pathlib import Path

from backend.runtime.mysql_config import load_database_url


class MySQLConfigTests(unittest.TestCase):
    def test_builds_mysql_url_from_local_config(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'data') as directory:
            root = Path(directory)
            (root / "data").mkdir()
            (root / "data" / "mysql.json").write_text(json.dumps({
                "host": "127.0.0.1", "port": 3306, "database": "simcare",
                "username": "simcare", "password": "a@b:c",
            }), encoding="utf-8")
            url = load_database_url(root)
            self.assertEqual(url.drivername, "mysql+pymysql")
            self.assertEqual(url.password, "a@b:c")
            self.assertEqual(url.query["charset"], "utf8mb4")

    def test_missing_configuration_is_an_error(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'data') as directory:
            with self.assertRaisesRegex(RuntimeError, "mysql.json"):
                load_database_url(Path(directory))


if __name__ == "__main__":
    unittest.main()
