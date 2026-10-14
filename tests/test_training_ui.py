import unittest

from backend.runtime.training_ui import render_html


class SharedTrainingPageTests(unittest.TestCase):
    def test_uses_one_shell_and_escapes_database_text(self):
        html = render_html({"title": "病例 <script>alert(1)</script>",
                            "subtitle": "胸痛 & 接诊", "scene_image_path": "unused",
                            "ui_stage_names": ["接诊"], "scene_names": ["诊室"],
                            "note_titles": ["病历"], "intro_quote": "</script><script>alert(2)</script>",
                            "options": {}, "ui_variant": "cardiac"}, "/training/123/")
        self.assertIn("病例 &lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertIn("胸痛 &amp; 接诊", html)
        self.assertIn('href="/training/123/style.css"', html)
        self.assertIn('src="/training/123/app.js"', html)
        self.assertIn('href="/training/123/case-asset/scene"', html)
        self.assertNotIn("</script><script>alert(2)</script>", html)


if __name__ == "__main__":
    unittest.main()
