"""Read-only check of shared training pages against the running local preview."""

import json
import os
import sys
from pathlib import Path

import httpx
from sqlalchemy import text

from backend.runtime.case_presentation import get_presentation, resolve_asset_path
from backend.runtime.engine_store import connection_engine

ROOT = Path(__file__).resolve().parents[2]
os.environ["APP_SECRET"] = json.loads((ROOT / "data/server.json").read_text(encoding="utf-8"))["app_secret"]
sys.path.insert(0, str(ROOT / "backend/main"))
from app.security import issue_token  # noqa: E402


def main():
    with connection_engine().connect() as connection:
        profiles = connection.execute(text("""SELECT c.engine_key,p.portal_case_id,p.locale
            FROM case_presentations p JOIN case_content c ON c.id=p.case_content_id""")).all()
        patients = connection.execute(text("""SELECT c.engine_key,p.name,p.sex,p.age
            FROM case_patients p JOIN case_content c ON c.id=p.case_content_id""")).all()
        attempts = connection.execute(text("""SELECT a.id,a.case_id,a.user_id,u.role
            FROM portal_attempts a JOIN users u ON u.id=a.user_id
            WHERE u.status='active' ORDER BY a.case_id""")).all()
    assert len(profiles) == 7, profiles
    assert len(patients) == 7 and all(name and sex and age for _, name, sex, age in patients)
    for engine_key, case_id, locale in profiles:
        profile = get_presentation(case_id, locale)
        assert profile and profile["engine_key"] == engine_key
        resolve_asset_path(profile["scene_image_path"])
        resolve_asset_path(profile["cover_image_path"])
    assert attempts, "No historical attempts are available for read-only route checks"
    base_url = os.environ.get("SIMCARE_VERIFY_BASE_URL", "http://127.0.0.1:8080")
    with httpx.Client(base_url=base_url, trust_env=False, timeout=20) as client:
        for case_id in (1, 2, 33, 34):
            row = next((item for item in attempts if item.case_id == case_id), attempts[0])
            client.cookies.set("clinical_session", issue_token(row.user_id, row.role))
            response = client.get(f"/portal/case-cover/{case_id}")
            assert (response.status_code == 200 and response.headers["content-type"].startswith("image/")), \
                f"cover {case_id}: {response.status_code}"
            if case_id != 34:
                english_cover = client.get(f"/en/portal/case-cover/{case_id}")
                assert english_cover.status_code == 200 and english_cover.headers["content-type"].startswith("image/"), \
                    f"English cover {case_id}: {english_cover.status_code}"
                expected = resolve_asset_path(get_presentation(case_id, "en")["cover_image_path"])
                assert english_cover.content == expected.read_bytes(), f"English cover {case_id} did not use its database path"
        checked = set()
        for row in attempts:
            if row.case_id in checked:
                continue
            checked.add(row.case_id)
            client.cookies.set("clinical_session", issue_token(row.user_id, row.role))
            base = f"/training/{row.id}/"
            html = client.get(base)
            assert html.status_code == 200 and "SIMCARE_CASE_PRESENTATION" in html.text
            assert (base + "case-asset/scene") in html.text
            for path, kind in (("style.css", "text/css"), ("app.js", "javascript"),
                               ("case-asset/scene", "image/")):
                result = client.get(base + path)
                assert (result.status_code == 200 and kind in result.headers["content-type"]), \
                    f"{base + path}: {result.status_code}"
        if base_url.endswith(":8080"):
            assert client.get("/ui/zh-chest/index.html").status_code == 404
    print(f"Verified {len(patients)} patient records, {len(profiles)} presentation profiles, four covers, and {len(checked)} historical training pages")


if __name__ == "__main__":
    main()
