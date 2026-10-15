import tempfile
import unittest
from pathlib import Path

from backend.runtime.mysql_config import load_database_url


class MySQLConfigTests(unittest.TestCase):
    def test_builds_mysql_url_from_application_yaml(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'data') as directory:
            root = Path(directory)
            (root / 'application.yml').write_text('''spring:
  datasource:
    url: jdbc:mysql://192.0.2.25:3307/simcare?useUnicode=true&characterEncoding=UTF-8
    username: simcare
    password: "a@b:c#word"
    driver-class-name: com.mysql.cj.jdbc.Driver
''', encoding='utf-8')
            url = load_database_url(root)
            self.assertEqual(url.drivername, 'mysql+pymysql')
            self.assertEqual(url.host, '192.0.2.25')
            self.assertEqual(url.port, 3307)
            self.assertEqual(url.database, 'simcare')
            self.assertEqual(url.username, 'simcare')
            self.assertEqual(url.password, 'a@b:c#word')
            self.assertEqual(url.query['charset'], 'utf8mb4')

    def test_missing_configuration_is_an_error(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'data') as directory:
            with self.assertRaisesRegex(RuntimeError, 'application.yml'):
                load_database_url(Path(directory))

    def test_incomplete_configuration_is_an_error(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'data') as directory:
            root = Path(directory)
            (root / 'application.yml').write_text('''spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/simcare
    username: root
''', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'password'):
                load_database_url(root)

    def test_invalid_datasource_section_reports_configuration_error(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'data') as directory:
            root = Path(directory)
            (root / 'application.yml').write_text('spring: null\n', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'spring.datasource'):
                load_database_url(root)


if __name__ == "__main__":
    unittest.main()
