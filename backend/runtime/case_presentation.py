"""MySQL-owned presentation settings for the shared training page."""

import json
import mimetypes
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from sqlalchemy import text

from .engine_store import connection_engine
from .ids import next_id

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = (PROJECT_ROOT / "backend").resolve()
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def default_profiles():
    """Import defaults once; existing database edits always take precedence."""
    common_notes = ["接诊病历书写", "处置与交接记录", "日常病程记录", "出院记录"]
    return [
        dict(engine_key="chest", portal_case_id=1, locale="zh", service_url="http://127.0.0.1:28765",
             ui_variant="cardiac", title="临床思维训练室", subtitle="胸痛患者 · 接诊医生视角",
             ui_stage_names=["接诊", "介入治疗", "病房查房", "出院日", "反馈"],
             scene_names=["急诊诊室", "转运与介入团队交接", "住院病房", "出院日"],
             note_titles=common_notes, intro_quote="医生，我胸口疼得厉害，还一直出汗。",
             scene_image_path="engines/chest/public/assets/patient-scenes-v1.png",
             intervention_image_path="engines/chest/public/assets/cath-lab-v1.png",
             cover_image_path="engines/chest/public/assets/patient-scenes-v1.png", options={}),
        dict(engine_key="lumbar", portal_case_id=2, locale="zh", service_url="http://127.0.0.1:28770",
             ui_variant="lumbar", title="骨科临床思维训练室", subtitle="腰腿痛患者 · 接诊医生视角",
             ui_stage_names=["接诊", "手术治疗", "病房查房", "出院日", "反馈"],
             scene_names=["骨科普通诊室", "转运与手术团队交接", "住院病房", "出院日"],
             note_titles=["门诊初诊病历", *common_notes[1:]], intro_quote="医生，我腰和左腿痛了好一阵，最近左脚抬起来也费劲。",
             scene_image_path="engines/lumbar/public/assets/patient-scenes-v1.png",
             intervention_image_path="engines/lumbar/public/assets/patient-scenes-v1.png",
             cover_image_path="engines/lumbar/public/assets/patient-scenes-v1.png", options={}),
        dict(engine_key="ascites", portal_case_id=33, locale="zh", service_url="http://127.0.0.1:28771",
             ui_variant="ascites", title="消化内科临床思维训练室", subtitle="腹胀患者 · 接诊医生视角",
             ui_stage_names=["接诊", "首日处置", "病房查房", "出院日", "反馈"],
             scene_names=["消化内科接诊室", "首日处置与交接", "住院病房", "出院日"],
             note_titles=["入院接诊记录", *common_notes[1:]], intro_quote="医生，我肚子胀得厉害，腿也肿了，这两天尿少。",
             scene_image_path="engines/ascites/public/assets/patient-scenes-v1.png",
             intervention_image_path=None,
             cover_image_path="engines/ascites/public/assets/patient-scenes-v1.png", options={}),
        dict(engine_key="uyghur", portal_case_id=34, locale="zh", service_url="http://127.0.0.1:28894",
             ui_variant="cardiac", title="临床思维训练室", subtitle="维吾尔语胸痛患者 · 接诊医生视角",
             ui_stage_names=["接诊", "介入治疗", "病房查房", "出院日", "反馈"],
             scene_names=["急诊诊室", "转运与介入团队交接", "住院病房", "出院日"],
             note_titles=common_notes, intro_quote="دوختۇر، كۆكرىكىم بەك ئاغرىۋاتىدۇ، توختىماي تەرلەۋاتىمەن.",
             scene_image_path="engines/uyghur/public/assets/uyghur-patient-scenes.png",
             intervention_image_path="engines/uyghur/public/assets/uyghur-cath-lab.png",
             cover_image_path="engines/uyghur/public/assets/uyghur-patient-scenes.png",
             options={"rtl_patient": True, "patient_input_hint": "输入想问患者的话（请使用维吾尔语，患者不懂其他语言）"}),
        dict(engine_key="en-chest", portal_case_id=1, locale="en", service_url="http://127.0.0.1:28891",
             ui_variant="cardiac", title="Clinical Reasoning Training", subtitle="Chest pain · Doctor view",
             ui_stage_names=["Intake", "Intervention", "Ward round", "Discharge", "Feedback"],
             scene_names=["Emergency room", "Catheterization handover", "Ward", "Discharge"],
             note_titles=["Admission record", "Handover", "Progress note", "Discharge record"],
             intro_quote="Doctor, my chest hurts badly and I keep sweating.",
             scene_image_path="extensions/english/site/chest_engine/public/assets/patient-scenes-v1.png",
             intervention_image_path="extensions/english/site/chest_engine/public/assets/cath-lab-v1.png",
             cover_image_path="extensions/english/site/chest_engine/public/assets/patient-scenes-v1.png", options={}),
        dict(engine_key="en-lumbar", portal_case_id=2, locale="en", service_url="http://127.0.0.1:28892",
             ui_variant="lumbar", title="Orthopedic Clinical Reasoning", subtitle="Low back and leg pain · Doctor view",
             ui_stage_names=["Intake", "Surgery", "Ward round", "Discharge", "Feedback"],
             scene_names=["Orthopedic clinic", "Operating team", "Ward", "Discharge"],
             note_titles=["Outpatient record", "Handover", "Progress note", "Discharge record"],
             intro_quote="Doctor, my back and left leg have been hurting.",
             scene_image_path="extensions/english/site/lumbar_engine/public/assets/patient-scenes-v1.png",
             intervention_image_path="extensions/english/site/lumbar_engine/public/assets/patient-scenes-v1.png",
             cover_image_path="extensions/english/site/lumbar_engine/public/assets/patient-scenes-v1.png", options={}),
        dict(engine_key="en-ascites", portal_case_id=33, locale="en", service_url="http://127.0.0.1:28893",
             ui_variant="ascites", title="Gastroenterology Clinical Reasoning", subtitle="Abdominal distension · Doctor view",
             ui_stage_names=["Intake", "First-day care", "Ward round", "Discharge", "Feedback"],
             scene_names=["Intake room", "Care handover", "Ward", "Discharge"],
             note_titles=["Admission record", "Handover", "Progress note", "Discharge record"],
             intro_quote="Doctor, my abdomen feels swollen.",
             scene_image_path="extensions/english/site/ascites_engine/public/assets/patient-scenes-v1.png",
             intervention_image_path=None,
             cover_image_path="extensions/english/site/ascites_engine/public/assets/patient-scenes-v1.png", options={}),
    ]


def resolve_asset_path(relative_path):
    if not isinstance(relative_path, str) or not relative_path or "\\" in relative_path:
        raise ValueError("Invalid case asset path")
    path = PurePosixPath(relative_path)
    if path.is_absolute() or ".." in path.parts or ":" in relative_path or path.suffix.lower() not in IMAGE_EXTENSIONS:
        raise ValueError("Case assets must be relative images inside backend/")
    resolved = (BACKEND_ROOT / Path(*path.parts)).resolve()
    if not resolved.is_relative_to(BACKEND_ROOT):
        raise ValueError("Case asset escapes backend/")
    if not resolved.is_file():
        raise FileNotFoundError(relative_path)
    return resolved


def asset_mime(relative_path):
    return mimetypes.guess_type(relative_path)[0] or "application/octet-stream"


def local_service_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost")
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
            or parsed.port is None):
        raise ValueError("Case service URL must be a local HTTP origin")
    return value


DDL = """CREATE TABLE IF NOT EXISTS case_presentations (
    id BIGINT NOT NULL PRIMARY KEY,
    case_content_id BIGINT NOT NULL UNIQUE,
    portal_case_id INT NOT NULL,
    locale VARCHAR(8) NOT NULL,
    service_url VARCHAR(255) NOT NULL,
    ui_variant VARCHAR(32) NOT NULL,
    title VARCHAR(160) NOT NULL,
    subtitle VARCHAR(255) NOT NULL,
    stage_names JSON NOT NULL,
    ui_stage_names JSON NOT NULL,
    scene_names JSON NOT NULL,
    note_titles JSON NOT NULL,
    stage_times JSON NOT NULL,
    intro_quote TEXT,
    scene_image_path VARCHAR(512) NOT NULL,
    intervention_image_path VARCHAR(512),
    cover_image_path VARCHAR(512) NOT NULL,
    options JSON NOT NULL,
    create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_case_presentation_portal_locale (portal_case_id, locale),
    CONSTRAINT fk_case_presentation_content FOREIGN KEY (case_content_id) REFERENCES case_content(id)
) CHARACTER SET utf8mb4"""


def _decode(row):
    if row is None:
        return None
    result = dict(row)
    for key in ("stage_names", "ui_stage_names", "scene_names", "note_titles", "stage_times", "options"):
        if isinstance(result[key], str):
            result[key] = json.loads(result[key])
    return result


def load_presentation(engine_key, stages, times):
    seed = next((profile for profile in default_profiles() if profile["engine_key"] == engine_key), None)
    if seed is None:
        raise KeyError(f"Unknown engine presentation: {engine_key}")
    with connection_engine().begin() as connection:
        connection.execute(text(DDL))
        row = connection.execute(text("""SELECT p.*,c.engine_key FROM case_presentations p
            JOIN case_content c ON c.id=p.case_content_id WHERE c.engine_key=:engine_key"""),
            {"engine_key": engine_key}).mappings().first()
        if row is not None:
            return _decode(row)
        for key in ("scene_image_path", "cover_image_path"):
            resolve_asset_path(seed[key])
        if seed["intervention_image_path"]:
            resolve_asset_path(seed["intervention_image_path"])
        content_id = connection.execute(text(
            "SELECT id FROM case_content WHERE engine_key=:engine_key"
        ), {"engine_key": engine_key}).scalar_one()
        values = {**seed, "id": next_id(), "case_content_id": content_id,
                  "stage_names": json.dumps(stages, ensure_ascii=False),
                  "stage_times": json.dumps(times, ensure_ascii=False)}
        for key in ("ui_stage_names", "scene_names", "note_titles", "options"):
            values[key] = json.dumps(values[key], ensure_ascii=False)
        connection.execute(text("""INSERT IGNORE INTO case_presentations
            (id,case_content_id,portal_case_id,locale,service_url,ui_variant,title,subtitle,
             stage_names,ui_stage_names,scene_names,note_titles,stage_times,intro_quote,
             scene_image_path,intervention_image_path,cover_image_path,options)
            VALUES (:id,:case_content_id,:portal_case_id,:locale,:service_url,:ui_variant,:title,:subtitle,
             :stage_names,:ui_stage_names,:scene_names,:note_titles,:stage_times,:intro_quote,
             :scene_image_path,:intervention_image_path,:cover_image_path,:options)"""), values)
        row = connection.execute(text("""SELECT p.*,c.engine_key FROM case_presentations p
            JOIN case_content c ON c.id=p.case_content_id WHERE c.engine_key=:engine_key"""),
            {"engine_key": engine_key}).mappings().one()
    return _decode(row)


def get_presentation(portal_case_id, locale="zh"):
    with connection_engine().connect() as connection:
        row = connection.execute(text("""SELECT p.*,c.engine_key FROM case_presentations p
            JOIN case_content c ON c.id=p.case_content_id
            WHERE p.portal_case_id=:case_id AND p.locale=:locale"""),
            {"case_id": portal_case_id, "locale": locale}).mappings().first()
    return _decode(row)


def covered_portal_cases(locale="zh"):
    with connection_engine().connect() as connection:
        rows = connection.execute(text(
            "SELECT portal_case_id FROM case_presentations WHERE locale=:locale AND cover_image_path IS NOT NULL"
        ), {"locale": locale}).scalars().all()
    return set(rows)
