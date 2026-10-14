"""Structured teaching documents; archive only student-authored content."""
import copy

ADMISSION = [('general','一般资料 / 病史陈述者'),('chief','主诉'),('history','现病史'),('past_history','既往史'),('allergy_history','过敏史'),('personal_history','个人史'),('marriage_history','婚育史'),('family_history','家族史'),('exam','体格检查'),('specialist_exam','专科情况'),('tests','辅助检查'),('diagnosis','初步诊断'),('author','记录医师（学员）')]
FIRST = [('case_features','病例特点'),('first_diagnosis','初步诊断'),('reason','诊断依据'),('differential','鉴别诊断'),('initial_plan','诊疗计划')]
DAILY = [('daily','病情变化 / 判断 / 今日计划'),('tests','辅助检查')]
DISCHARGE = [('discharge','入院情况 / 诊疗经过 / 出院情况'),('discharge_diagnosis','出院诊断'),('discharge_advice','出院医嘱 / 随访')]
EXTRA_KEYS = tuple(k for k,_ in ADMISSION+FIRST)

def definitions(stage):
    return [('admission','入院记录',ADMISSION),('first','首次病程记录',FIRST)] if stage==0 else [('daily','日常病程记录',DAILY)] if stage==2 else [('discharge','出院记录',DISCHARGE)] if stage==3 else []

def capture(session, changed, stamp):
    documents=session.setdefault('medical_documents',[])
    for kind,title,fields in definitions(session['stage']):
        if not set(changed).intersection(k for k,_ in fields): continue
        content={k:session['notes'].get(k,'') for k,_ in fields}
        if not any(content.values()): continue
        key=f'{session["stage"]}:{kind}'
        doc=next((d for d in documents if d['id']==key),None)
        if doc is None:
            doc=dict(id=key,title=title,stage=session['stage'],created_at=stamp,updated_at=stamp,fields=fields,content={},versions=[])
            documents.append(doc)
        if doc['content']==content: continue
        if doc['content']:doc['versions'].append({'time':doc['updated_at'],'content':copy.deepcopy(doc['content'])})
        doc.update(content=content,updated_at=stamp)

def documents(session):
    result=copy.deepcopy(session.get('medical_documents',[]))
    # Existing stage snapshots are historical evidence, not newly authored documents.
    for stage,snapshot in session.get('snapshots',{}).items():
        for kind,title,fields in definitions(int(stage)):
            key=f'{stage}:{kind}'
            if any(d['id']==key for d in result):continue
            if kind=='first' and not any(snapshot.get('notes',{}).get(k) for k in ('case_features','first_diagnosis','differential','initial_plan')):continue
            if kind=='admission':fields=fields+[('reason','原接诊诊断依据'),('plan','原处置计划')]
            content={k:snapshot.get('notes',{}).get(k,'') for k,_ in fields}
            if not any(content.values()):continue
            result.append(dict(id=key,title=title,stage=int(stage),created_at=None,updated_at=None,fields=fields,content=content,versions=[],legacy=True))
    return sorted(result,key=lambda d:(d['stage'],d['created_at'] or '',d['id']))
