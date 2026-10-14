"""Render the shared training shell with database-controlled display text."""

import html
import json
from pathlib import Path

TEMPLATE = (Path(__file__).resolve().parents[1] / "main/app/training_ui/index.html")
STYLE = TEMPLATE.with_name("style.css")


def render_html(profile, prefix):
    if not prefix.startswith("/training/") or not prefix.endswith("/"):
        raise ValueError("Invalid training URL prefix")
    public = {key: profile.get(key) for key in (
        "ui_variant", "ui_stage_names", "scene_names", "note_titles", "intro_quote", "options"
    )}
    public["scene_image_url"] = prefix + "case-asset/scene"
    public["intervention_image_url"] = prefix + "case-asset/intervention" if profile.get("intervention_image_path") else None
    public["case_label"] = profile.get("subtitle", "")
    payload = json.dumps(public, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return (TEMPLATE.read_text(encoding="utf-8")
            .replace("__CASE_TITLE__", html.escape(profile["title"], quote=True))
            .replace("__CASE_SUBTITLE__", html.escape(profile["subtitle"], quote=True))
            .replace("__CASE_PREFIX__", html.escape(prefix, quote=True))
            .replace("__CASE_CONFIG__", payload))
