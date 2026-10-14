"""Disposable dialogue test: no student sessions or case state are written."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent
ENGINE = ROOT.parent / 'engines' / 'chest'
sys.path.insert(0, str(ENGINE))
import agent
from role_runtime import generate

def main():
    d = json.load(sys.stdin)
    role = d['role']
    facts = {'test_case': '固定测试场景：患者张先生，45岁，腰痛3天，搬重物后出现；无下肢麻木。其他医学事实未设定。'}
    context = {'role':'患者' if role=='patient' else '上级医师', 'stage':'初诊', 'mode':'practice',
               'student_text':d['text'], 'history':d['history'], 'allowed_facts':facts if role=='patient' else {},
               'known_facts':facts if role=='senior' else {}, 'reports':{}}
    if d.get('image_data'):context['uploaded_images']={'test_image':'管理员测试图片，不是病例已核验结果'}
    context['valid_fact_ids'] = sorted(agent.allowed_ids(context))
    rules = agent.RULES + (agent.PATIENT_RULES if role=='patient' else agent.SENIOR_RULES)
    raw, timing = generate(agent.CONNECTION, context, json.dumps(context,ensure_ascii=False), rules, agent.SCHEMA,
                           lambda _:None, None, override={**d['config'],**({'persona':d['persona']} if d.get('persona') is not None else {})},image_paths=[d['image_data']] if d.get('image_data') else None)
    reply = json.loads(raw)
    if not isinstance(reply.get('reply'),str) or not agent.valid_metadata(reply,context):
        raise RuntimeError('模型回答格式或来源标记不合格。')
    print(json.dumps({'reply':reply['reply'],'timing':timing},ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error':str(exc)[:250]},ensure_ascii=False))
    finally:
        agent.CONNECTION.close()
