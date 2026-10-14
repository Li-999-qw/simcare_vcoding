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
    raise HTTPException(403,'无权查看该学生的学习记录')

def observations(s):
    messages=s.get('messages',[]);notes=s.get('notes',{})
    missing=[label for key,label in [('history','病史'),('exam','体格检查'),('tests','辅助检查'),('diagnosis','诊断'),('reason','诊断依据'),('plan','处理计划')] if not str(notes.get(key,'')).strip()]
    reviews=[m['text'] for m in messages if m.get('speaker')=='assistant' and m.get('role')=='senior' and (m.get('feedback_review') or m.get('stage')==4)]
    return {'stage':s.get('stage',0),'completed':s.get('stage')==4,
        'patient_questions':sum(m.get('speaker')=='student' and m.get('role')=='patient' for m in messages),
        'consultations':sum(m.get('speaker')=='student' and m.get('role')=='senior' for m in messages),
        'checks':len(s.get('requested_reports',[])),'orders':len(s.get('orders',[])),
        'unrecorded':missing,'reviews':reviews,
        'basis':'基于实际记录统计；空白表示未记录，不等于未实施。对话次数不代表能力分数。'}

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
    if not student:raise HTTPException(404,'学生不存在')
    cases={c['id']:c for c in document(db).data['cases']};attempts=[];topics={};review_extracts=[]
    for a in db.scalars(select(PortalAttempt).where(PortalAttempt.user_id==student_id)):
        attempts.append({'id':a.id,'case':cases.get(a.case_id,{}).get('name','病例'),'task':a.task_key,'summary':observations(a.state)})
        for m in a.state.get('messages',[]):
            if m.get('role')=='senior' and m.get('speaker')=='student':
                for label,words in {'问诊与病史':['问诊','病史','症状'],'检查与解读':['检查','检验','影像','心电'],'诊断与鉴别':['诊断','鉴别'],'治疗与用药':['用药','药物','剂量','治疗','手术'],'病历与复盘':['病历','复盘','总结']}.items():
                    if any(w in m.get('text','') for w in words):topics[label]=topics.get(label,0)+1
        review_extracts.extend({'case':cases.get(a.case_id,{}).get('name','病例'),'attempt':a.id,'text':value} for value in observations(a.state)['reviews'])
    gaps={}
    for a in attempts:
        for item in a['summary']['unrecorded']:gaps[item]=gaps.get(item,0)+1
    return {'student':student.display_name,'attempts':attempts,'completed':sum(a['summary']['completed'] for a in attempts),
        'recurring_gaps':gaps,'topics':topics,'review_extracts':review_extracts,'knowledge':{status:sum(k.content.get('status')==status for k in db.scalars(select(KnowledgeItem).where(KnowledgeItem.user_id==student_id))) for status in ('待确认','待复习','已掌握')},'recommendation':'优先复习多次未记录的诊疗环节，并结合每个病例的上级医师复盘核实原因。' if attempts else '尚无练习记录。',
        'trend':'当前尚无统一评分量表，不以病例次数推断临床能力提升。可逐病例比较记录完整性及复盘意见。'}

@router.get('/learning/attempt/{attempt_id}')
def detail(attempt_id:str,u=Depends(actor),db=Depends(get_db)):
    a=db.get(PortalAttempt,attempt_id)
    if not a:raise HTTPException(404,'练习不存在')
    permitted(u,a.user_id,db);live=refresh_attempt(a);db.commit()
    case=next((c for c in document(db).data['cases'] if c['id']==a.case_id),{})
    return {'id':a.id,'case':case.get('name','病例'),'summary':observations(a.state),'record':a.state,'live':live}

@router.get('/learning/knowledge')
def knowledge(u=Depends(actor),db=Depends(get_db)):
    if u.role!='student':raise HTTPException(403,'仅学生可管理个人知识库')
    cases={c['id']:c for c in document(db).data['cases']}
    for a in db.scalars(select(PortalAttempt).where(PortalAttempt.user_id==u.id)):
        candidates=[]
        for m in a.state.get('messages',[]):
            if m.get('role')!='senior':continue
            if m.get('speaker')=='student':
                candidates.append({'key':str(m.get('id',m.get('text'))),'question':m.get('text',''),'text':'','stage':m.get('stage',0),'source':'待解答问题'})
            elif m.get('speaker')=='assistant':
                if not candidates:candidates.append({'key':str(m.get('id',m.get('text'))),'question':'复盘记录','text':'','stage':m.get('stage',0)})
                item=candidates[-1];item['text']+=(('\n\n' if item['text'] else '')+m.get('text',''))
                item['source']='上级医师复盘' if m.get('feedback_review') or m.get('stage')==4 else '上级医师请教'
        for item in candidates:
            key=hashlib.sha256((a.id+':'+item.pop('key')).encode()).hexdigest()
            existing=db.scalar(select(KnowledgeItem).where(KnowledgeItem.item_key==key))
            content={**item,'case':cases.get(a.case_id,{}).get('name','病例')}
            if existing:
                existing.content={**existing.content,**content}
            else:
                db.add(KnowledgeItem(item_key=key,user_id=u.id,attempt_id=a.id,content={**content,'status':'待确认','note':''}))
    db.commit()
    return [{'id':k.id,'attempt_id':k.attempt_id,**k.content} for k in db.scalars(select(KnowledgeItem).where(KnowledgeItem.user_id==u.id))]

@router.get('/learning/asset/{attempt_id}')
def asset(attempt_id:str,report:str='',attachment:str='',u=Depends(actor),db=Depends(get_db)):
    a=db.get(PortalAttempt,attempt_id)
    if not a:raise HTTPException(404,'练习不存在')
    permitted(u,a.user_id,db)
    if report and not attachment and report in a.state.get('reports',[]):
        path='api/report-image';params={'id':a.engine_id,'report':report}
    elif attachment and not report and attachment in {v for m in a.state.get('messages',[]) for v in m.get('attachments',[])}:
        path='api/attachment';params={'id':a.engine_id,'attachment':attachment}
    else:raise HTTPException(404,'此练习未记录该附件')
    r=engine(a.case_id,'GET',path,params=params)
    return Response(r.content,status_code=r.status_code,media_type=r.headers.get('content-type','application/octet-stream'),headers={'Cache-Control':'no-store'})

@router.post('/learning/knowledge/{item_id}')
async def update_knowledge(item_id:str,request:Request,u=Depends(actor),db=Depends(get_db)):
    k=db.get(KnowledgeItem,item_id)
    if not k or k.user_id!=u.id:raise HTTPException(404,'知识条目不存在')
    d=await request.json()
    if d.get('status') not in ('待确认','待复习','已掌握','已忽略'):raise HTTPException(400,'状态无效')
    k.content={**k.content,'status':d['status'],'note':str(d.get('note',k.content.get('note','')))[:3000]};db.commit()
    return {'ok':True}
