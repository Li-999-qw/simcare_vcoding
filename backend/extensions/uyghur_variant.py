"""Register an independent Chinese-portal case with Uyghur patient dialogue."""
import copy
def install():
    from app.migrations import upgrade_schema
    upgrade_schema()
    from app.db import SessionLocal
    from app.portal_api import document
    with SessionLocal() as db:
        row=document(db);data=copy.deepcopy(row.data)
        original=next(c for c in data['cases'] if c.get('sourceCaseId')=='SIM-AMI-20260901')
        variant=next((c for c in data['cases'] if c.get('sourceCaseId')=='SIM-AMI-20260901-UG'),None)
        if variant is None:
            variant=copy.deepcopy(original)
            variant.update(id=max(c['id'] for c in data['cases'])+1,sourceCaseId='SIM-AMI-20260901-UG',name='胸痛患者接诊（维吾尔语）',trainingAvailable=True,
                sourceNote='共享胸痛病例的全部中文医学资料。仅患者对话使用维吾尔语；界面、上级医师和复盘均为中文。患者情境图为虚构维吾尔族形象，姓名与病历保持原设定。维吾尔语表达待语言教师审阅。')
            data['cases'].append(variant);row.data=data;row.revision+=1;db.commit()
        note='沿用胸痛病例医学资料；虚构患者阿不都热依木·艾合买提，维吾尔族，58岁，企业行政人员，籍贯新疆喀什，现居乌鲁木齐。患者只懂维吾尔语；上级医师按提问语言使用维吾尔语、中文或英文，自动复盘默认维吾尔语。界面及报告为中文。维吾尔语表达待语言教师审阅。'
        if variant.get('sourceNote')!=note:
            variant['sourceNote']=note
            row.data=data;row.revision+=1;db.commit()
