import os
import unittest
from unittest.mock import patch

from backend.runtime.ids import MAX_ID, next_id


class SnowflakeIdTests(unittest.TestCase):
    def test_unique_monotonic_and_javascript_safe(self):
        with patch.dict(os.environ, {"SIMCARE_WORKER_ID": "7"}):
            values = [next_id() for _ in range(100)]
        self.assertEqual(len(values), len(set(values)))
        self.assertEqual(values, sorted(values))
        self.assertTrue(all(0 < value <= MAX_ID for value in values))

    def test_worker_bounds(self):
        with patch.dict(os.environ, {"SIMCARE_WORKER_ID": "1024"}):
            with self.assertRaises(ValueError):
                next_id()


if __name__ == "__main__":
    unittest.main()
