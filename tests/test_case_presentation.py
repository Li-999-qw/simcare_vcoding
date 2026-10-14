import unittest

from backend.runtime.case_presentation import default_profiles, resolve_asset_path, local_service_url


class CasePresentationTests(unittest.TestCase):
    def test_all_deployed_cases_have_resolvable_scene_and_cover(self):
        profiles = default_profiles()
        self.assertEqual({p["engine_key"] for p in profiles},
                         {"chest", "lumbar", "ascites", "uyghur",
                          "en-chest", "en-lumbar", "en-ascites"})
        for profile in profiles:
            self.assertTrue(resolve_asset_path(profile["scene_image_path"]).is_file())
            self.assertTrue(resolve_asset_path(profile["cover_image_path"]).is_file())

    def test_asset_path_rejects_traversal_and_absolute_paths(self):
        for path in ("../data/mysql.json", "C:/Windows/win.ini", "/etc/passwd", "engines/chest/../../data/mysql.json"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                resolve_asset_path(path)

    def test_missing_asset_is_not_served(self):
        with self.assertRaises(FileNotFoundError):
            resolve_asset_path("engines/chest/public/assets/does-not-exist.png")

    def test_case_service_cannot_be_redirected_outside_local_processes(self):
        self.assertEqual(local_service_url("http://127.0.0.1:28765"), "http://127.0.0.1:28765")
        for url in ("https://example.com", "http://127.0.0.1.evil.test:28765",
                    "http://127.0.0.1:28765/private", "file:///etc/passwd"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                local_service_url(url)


if __name__ == "__main__":
    unittest.main()
