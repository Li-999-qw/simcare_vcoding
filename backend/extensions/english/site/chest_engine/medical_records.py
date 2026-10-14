"""Structured teaching documents; archive only student-authored content."""
import copy

ADMISSION = [('general','General information / History provided by'),('chief','Chief complaint'),('history','History of present illness'),('past_history','Past medical history'),('allergy_history','Allergy history'),('personal_history','Personal history'),('marriage_history','Marital and reproductive history'),('family_history','Family history'),('exam','Physical examination'),('specialist_exam','Specialty-specific findings'),('tests','Ancillary Investigations'),('diagnosis','Provisional diagnosis'),('author','Documenting clinician (trainee）')]
FIRST = [('case_features','Case features'),('first_diagnosis','Provisional diagnosis'),('reason','Diagnostic Basis'),('differential','Differential diagnosis'),('initial_plan','Diagnostic and treatment plan')]
DAILY = [('daily','Changes in clinical condition / Assess / Today’s plan'),('tests','Ancillary Investigations')]
DISCHARGE = [('discharge','Condition on admission / Clinical course / Condition at discharge'),('discharge_diagnosis','Discharge diagnosis'),('discharge_advice','Discharge orders / Follow-up')]
EXTRA_KEYS = tuple(k for k,_ in ADMISSION+FIRST)

def definitions(stage):
    return [('admission','Admission note',ADMISSION),('first','Initial progress note',FIRST)] if stage==0 else [('daily','Daily progress notes',DAILY)] if stage==2 else [('discharge','Discharge summary',DISCHARGE)] if stage==3 else []

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
            if kind=='admission':fields=fields+[('reason','Rationale for the original intake diagnosis'),('plan','Original management plan')]
            content={k:snapshot.get('notes',{}).get(k,'') for k,_ in fields}
            if not any(content.values()):continue
            result.append(dict(id=key,title=title,stage=int(stage),created_at=None,updated_at=None,fields=fields,content=content,versions=[],legacy=True))
    return sorted(result,key=lambda d:(d['stage'],d['created_at'] or '',d['id']))
