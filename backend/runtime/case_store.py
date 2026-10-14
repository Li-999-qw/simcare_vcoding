"""Versioned editable case content, seeded once from the bundled teaching cases."""

import copy
import json

from sqlalchemy import text

from .engine_store import connection_engine
from .ids import next_id

PATIENT_FIELDS = (
    'name', 'sex', 'age', 'marital_status', 'occupation', 'ethnicity',
    'birthplace', 'address', 'history_source', 'admission_status',
)

PATIENT_DDL = '''CREATE TABLE IF NOT EXISTS case_patients (
    id BIGINT NOT NULL PRIMARY KEY,
    case_content_id BIGINT NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL,
    sex VARCHAR(32) NOT NULL,
    age VARCHAR(32) NOT NULL,
    marital_status VARCHAR(64),
    occupation VARCHAR(255),
    ethnicity VARCHAR(160),
    birthplace VARCHAR(255),
    address VARCHAR(512),
    history_source VARCHAR(255),
    admission_status VARCHAR(255),
    create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_case_patient_content FOREIGN KEY (case_content_id) REFERENCES case_content(id)
) CHARACTER SET utf8mb4'''


def load_case(engine_key, case_id, registration, facts, reports):
    engine = connection_engine()
    with engine.begin() as conn:
        conn.execute(text('''CREATE TABLE IF NOT EXISTS case_content (
            id BIGINT NOT NULL PRIMARY KEY,
            engine_key VARCHAR(64) NOT NULL UNIQUE,
            case_id VARCHAR(100) NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            registration JSON NOT NULL,
            facts JSON NOT NULL,
            reports JSON NOT NULL,
            create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_case_content_id (case_id)
        ) CHARACTER SET utf8mb4'''))
        conn.execute(text('''INSERT IGNORE INTO case_content
            (id,engine_key,case_id,registration,facts,reports) VALUES (:row_id,:key,:case_id,:registration,:facts,:reports)'''),
            {'row_id': next_id(), 'key': engine_key, 'case_id': case_id,
             'registration': json.dumps(registration, ensure_ascii=False),
             'facts': json.dumps(facts, ensure_ascii=False),
             'reports': json.dumps(reports, ensure_ascii=False)})
        row = conn.execute(text('SELECT id,registration,facts,reports FROM case_content WHERE engine_key=:key'), {'key': engine_key}).mappings().one()
        conn.execute(text(PATIENT_DDL))
        initial = json.loads(row['registration']) if isinstance(row['registration'], str) else row['registration']
        patient_values = {'id': next_id(), 'case_content_id': row['id']}
        patient_values.update({key: initial.get(key, '') for key in PATIENT_FIELDS})
        conn.execute(text('''INSERT IGNORE INTO case_patients
            (id,case_content_id,name,sex,age,marital_status,occupation,ethnicity,
             birthplace,address,history_source,admission_status)
            VALUES (:id,:case_content_id,:name,:sex,:age,:marital_status,:occupation,:ethnicity,
                    :birthplace,:address,:history_source,:admission_status)'''), patient_values)
        patient = conn.execute(text('''SELECT name,sex,age,marital_status,occupation,ethnicity,
            birthplace,address,history_source,admission_status FROM case_patients
            WHERE case_content_id=:case_content_id'''), {'case_content_id': row['id']}).mappings().one()
    result = {}
    result['registration'] = dict(patient)
    for name in ('facts', 'reports'):
        value = row[name]
        result[name] = copy.deepcopy(json.loads(value) if isinstance(value, str) else value)
    registration = result['registration']
    identity_parts = [str(registration.get(key, '')).strip() for key in
                      ('name', 'sex', 'age', 'marital_status', 'occupation')]
    if all(identity_parts[:3]) and 'identity' in result['facts']:
        separator, stop = (', ', '.') if engine_key.startswith('en-') else ('，', '。')
        result['facts']['identity'] = separator.join(part for part in identity_parts if part) + stop
    return result
