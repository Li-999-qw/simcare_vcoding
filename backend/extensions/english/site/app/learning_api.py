"""Owner-scoped learning records and evidence-linked revision notes."""
import hashlib
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from .db import get_db
from .models import User
from .portal_models import PortalAttempt, KnowledgeItem
from .portal_api import actor, document, state as portal_state, engine

router=APIRouter()

def permitted(u, student_id, db):
    if u.role=='admin' or u.role=='student' and u.id==student_id:return
    if u.role=='teacher':
        d=portal_state(u,db);name=d['account']['name']
        ids=set(d['teacherStudents'].get(name,[]))
        ids.update(i for g in d['teacherGroups'].get(name,[]) for i in g['ids'])
        ids.update(i for t in d['tasks'] for i in t['ids'])
        if student_id in ids:return
    raise HTTPException(403,'You do not have permission to view this Student’s learning records')

def observations(s):
    messages=s.get('messages',[]);notes=s.get('notes',{})
    missing=[label for key,label in [('history','Medical history'),('exam','Physical examination'),('tests','Ancillary Investigations'),('diagnosis','Diagnosis'),('reason','Diagnostic Basis'),('plan','Management Plan')] if not str(notes.get(key,'')).strip()]
    reviews=[m['text'] for m in messages if m.get('speaker')=='assistant' and m.get('role')=='senior' and (m.get('feedback_review') or m.get('stage')==4)]
    return {'stage':s.get('stage',0),'completed':s.get('stage')==4,
        'patient_questions':sum(m.get('speaker')=='student' and m.get('role')=='patient' for m in messages),
        'consultations':sum(m.get('speaker')=='student' and m.get('role')=='senior' for m in messages),
        'checks':len(s.get('requested_reports',[])),'orders':len(s.get('orders',[])),
        'unrecorded':missing,'reviews':reviews,
        'basis':'Statistics are based on actual records. A blank means not recorded, not necessarily not performed. Dialogue counts are not competency scores.。'}

def refresh_attempt(a):
    try:
        r=engine(a.case_id,'GET','api/state',params={'id':a.engine_id})
        if r.status_code==200:a.state=r.json();return True
    except HTTPException:pass
    return False

@router.get('/learning/student/{student_id}')
def student_report(student_id:int,u=Depends(actor),db=Depends(get_db)):
    permitted(u,student_id,db)
    student=db.get(User,student_id)
    if not student:raise HTTPException(404,'Student not found')
    cases={c['id']:c for c in document(db).data['cases']};attempts=[];topics={};review_extracts=[]
    for a in db.scalars(select(PortalAttempt).where(PortalAttempt.user_id==student_id)):
        attempts.append({'id':a.id,'case':cases.get(a.case_id,{}).get('name','Clinical case'),'task':a.task_key,'summary':observations(a.state)})
        for m in a.state.get('messages',[]):
            if m.get('role')=='senior' and m.get('speaker')=='student':
                for label,words in {'History taking and medical history':['History taking','Medical history','Symptoms'],'Tests and interpretation':['Examination','Laboratory testing','Imaging','Electrocardiography'],'Diagnosis and differential diagnosis':['Diagnosis','Differentiation'],'Treatment and medication':['Medication','Medication','Dose','Treatment','Surgery'],'Medical records and debriefing':['Medical record','Debrief','Summary']}.items():
                    if any(w.casefold() in m.get('text','').casefold() for w in words):topics[label]=topics.get(label,0)+1
        review_extracts.extend({'case':cases.get(a.case_id,{}).get('name','Clinical case'),'attempt':a.id,'text':value} for value in observations(a.state)['reviews'])
    gaps={}
    for a in attempts:
        for item in a['summary']['unrecorded']:gaps[item]=gaps.get(item,0)+1
    return {'student':student.display_name,'attempts':attempts,'completed':sum(a['summary']['completed'] for a in attempts),
        'recurring_gaps':gaps,'topics':topics,'review_extracts':review_extracts,'knowledge':{status:sum(k.content.get('status')==status for k in db.scalars(select(KnowledgeItem).where(KnowledgeItem.user_id==student_id))) for status in ('Pending confirmation','Pending review','Mastered')},'recommendation':'Prioritize reviewing clinical care steps repeatedly missing from records, and verify the reasons using the Supervising Physician’s debriefing for each case.。' if attempts else 'No practice records yet。',
        'trend':'There is currently no standardized scoring rubric. Do not infer improvement in clinical competence from case counts. Record completeness and debriefing feedback may be compared case by case.。'}

@router.get('/learning/attempt/{attempt_id}')
def detail(attempt_id:str,u=Depends(actor),db=Depends(get_db)):
    a=db.get(PortalAttempt,attempt_id)
    if not a:raise HTTPException(404,'Practice session not found')
    permitted(u,a.user_id,db);live=refresh_attempt(a);db.commit()
    case=next((c for c in document(db).data['cases'] if c['id']==a.case_id),{})
    return {'id':a.id,'case':case.get('name','Clinical case'),'summary':observations(a.state),'record':a.state,'live':live}

@router.get('/learning/knowledge')
def knowledge(u=Depends(actor),db=Depends(get_db)):
    if u.role!='student':raise HTTPException(403,'Only Students can manage personal knowledge bases')
    cases={c['id']:c for c in document(db).data['cases']}
    for a in db.scalars(select(PortalAttempt).where(PortalAttempt.user_id==u.id)):
        candidates=[]
        for m in a.state.get('messages',[]):
            if m.get('role')!='senior':continue
            if m.get('speaker')=='student':
                candidates.append({'key':str(m.get('id',m.get('text'))),'question':m.get('text',''),'text':'','stage':m.get('stage',0),'source':'Questions awaiting answers'})
            elif m.get('speaker')=='assistant':
                if not candidates:candidates.append({'key':str(m.get('id',m.get('text'))),'question':'Debriefing Records','text':'','stage':m.get('stage',0)})
                item=candidates[-1];item['text']+=(('\n\n' if item['text'] else '')+m.get('text',''))
                item['source']='Supervising Physician Debrief' if m.get('feedback_review') or m.get('stage')==4 else 'Consult Supervising Physician'
        for item in candidates:
            key=hashlib.sha256((a.id+':'+item.pop('key')).encode()).hexdigest()
            existing=db.get(KnowledgeItem,key)
            content={**item,'case':cases.get(a.case_id,{}).get('name','Clinical case')}
            if existing:
                existing.content={**existing.content,**content}
            else:
                db.add(KnowledgeItem(id=key,user_id=u.id,attempt_id=a.id,content={**content,'status':'Pending confirmation','note':''}))
    db.commit()
    return [{'id':k.id,'attempt_id':k.attempt_id,**k.content} for k in db.scalars(select(KnowledgeItem).where(KnowledgeItem.user_id==u.id))]

@router.get('/learning/asset/{attempt_id}')
def asset(attempt_id:str,report:str='',attachment:str='',u=Depends(actor),db=Depends(get_db)):
    a=db.get(PortalAttempt,attempt_id)
    if not a:raise HTTPException(404,'Practice session not found')
    permitted(u,a.user_id,db)
    if report and not attachment and report in a.state.get('reports',[]):
        path='api/report-image';params={'id':a.engine_id,'report':report}
    elif attachment and not report and attachment in {v for m in a.state.get('messages',[]) for v in m.get('attachments',[])}:
        path='api/attachment';params={'id':a.engine_id,'attachment':attachment}
    else:raise HTTPException(404,'This attachment was not recorded for this exercise')
    r=engine(a.case_id,'GET',path,params=params)
    return Response(r.content,status_code=r.status_code,media_type=r.headers.get('content-type','application/octet-stream'),headers={'Cache-Control':'no-store'})

@router.post('/learning/knowledge/{item_id}')
async def update_knowledge(item_id:str,request:Request,u=Depends(actor),db=Depends(get_db)):
    k=db.get(KnowledgeItem,item_id)
    if not k or k.user_id!=u.id:raise HTTPException(404,'Knowledge entry does not exist')
    d=await request.json()
    if d.get('status') not in ('Pending confirmation','Pending review','Mastered','Ignored'):raise HTTPException(400,'Invalid Status')
    k.content={**k.content,'status':d['status'],'note':str(d.get('note',k.content.get('note','')))[:3000]};db.commit()
    return {'ok':True}
