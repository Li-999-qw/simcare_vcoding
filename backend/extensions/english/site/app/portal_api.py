import copy, json, secrets, threading
from pathlib import Path
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, FileResponse
from sqlalchemy import select
from .db import get_db, SessionLocal
from .models import User, AuditEvent
from .portal_models import PortalDocument, PortalAttempt
from .security import read_token, issue_token, verify_password
from .config import settings

router = APIRouter()
lock = threading.RLock()
ROOT = Path(__file__).parent
ENGINES = {1: settings.dialogue_engine_url, 2: 'http://127.0.0.1:28892'}

def engine_url(case_id):
    if case_id in ENGINES:return ENGINES[case_id]
    with SessionLocal() as db:
        case=next((c for c in document(db).data['cases'] if c['id']==case_id),None)
        if case and case.get('sourceCaseId')=='SIM-ASC-20260901':return 'http://127.0.0.1:28893'
    return None

def actor(request: Request, db=Depends(get_db)):
    token = request.cookies.get('clinical_session') or request.headers.get('Authorization','').removeprefix('Bearer ')
    try:
        u = db.get(User, int(read_token(token)['sub']))
        if not u or u.status != 'active': raise ValueError()
    except Exception:
        raise HTTPException(401, 'Please log in again')
    if request.method not in ('GET','HEAD') and request.headers.get('Origin') and request.headers['Origin'] != (request.url.scheme+'://'+request.url.netloc):
        raise HTTPException(403, 'Source mismatch')
    return u

def document(db):
    row=db.get(PortalDocument,1)
    if not row:
        row=PortalDocument(id=1, revision=0, data={'cases':json.loads((ROOT/'catalog.json').read_text(encoding='utf-8')), 'tasks':[], 'teacherGroups':{}, 'teacherStudents':{}})
        from english.seed_access import seed_access
        seed_access(db,row)
        db.add(row);db.commit()
    return row

@router.post('/portal/login')
async def login(request: Request, response: Response, db=Depends(get_db)):
    d=await request.json();u=db.scalar(select(User).where(User.username==d.get('username')))
    if not u or not verify_password(d.get('password',''),u.password_hash): raise HTTPException(401,'Incorrect username or password')
    if u.status!='active': raise HTTPException(403,'Registration application has not yet been approved')
    response.set_cookie('clinical_session',issue_token(u.id,u.role),httponly=True,samesite='strict',secure=request.url.scheme=='https',max_age=43200)
    return {'ok':True}

@router.post('/portal/logout')
def logout(response: Response):
    response.delete_cookie('clinical_session');return {'ok':True}

@router.get('/portal/state')
def state(u=Depends(actor),db=Depends(get_db)):
    row=document(db);d=copy.deepcopy(row.data)
    users=list(db.scalars(select(User)))
    teachers=[v for v in users if v.role=='teacher' and v.status=='active']
    names=[v.display_name for v in teachers]
    if len(names)!=len(set(names)): names=[v.display_name+' ('+v.username+')' for v in teachers]
    teacher_name=dict(zip([v.id for v in teachers],names))
    own=teacher_name.get(u.id,u.display_name)
    if u.role=='student':
        d['tasks']=[t for t in d['tasks'] if u.id in t['ids']]
        for t in d['tasks']:
            t['ids']=[u.id]
            for key in ('progress','notes','feedback','removalRequests'): t[key]={str(u.id):t.get(key,{}).get(str(u.id))} if str(u.id) in t.get(key,{}) else {}
        d['teacherGroups']={n:[{**g,'ids':[u.id]} for g in gs if u.id in g['ids']] for n,gs in d['teacherGroups'].items()}
        d['teacherStudents']={}
    elif u.role=='teacher':
        d['tasks']=[t for t in d['tasks'] if t['owner']==own]
        d['teacherGroups']={own:d['teacherGroups'].get(own,[])}
        d['teacherStudents']={own:d['teacherStudents'].get(own,[])}
    for t in d['tasks']:
        for a in db.scalars(select(PortalAttempt).where(PortalAttempt.task_key==str(t['id']))):
            if a.user_id in t['ids']: t.setdefault('progress',{})[str(a.user_id)]=5 if a.state.get('stage')==4 else max(a.state.get('stage',0)*1.25,0.25 if any(m.get('speaker')=='student' for m in a.state.get('messages',[])) else 0)
    if u.role=='student':
        d['practiceProgress']=[{'caseId':a.case_id,'id':a.id,'stage':a.state.get('stage',0),'percent':100 if a.state.get('stage')==4 else max(a.state.get('stage',0)*25,5 if any(m.get('speaker')=='student' for m in a.state.get('messages',[])) else 0)} for a in db.scalars(select(PortalAttempt).where(PortalAttempt.user_id==u.id))]
    visible=[v for v in users if (u.role=='admin' or v.status=='active') and (u.role!='student' or v.id==u.id)]
    def user(v):
        return {'id':v.id,'name':v.display_name,'studentNo':v.username,'major':(v.profile or {}).get('major',''),'phone':(v.profile or {}).get('phone','') if u.role=='admin' or v.id==u.id else '', 'dept':'Not configured','year':1,'status':{'active':'Pass','pending':'Pending approval review','rejected':'Return for Additional Information'}.get(v.status,v.status),'mine':v.id in d['teacherStudents'].get(own,[]),'role':'Teacher' if v.requested_role=='teacher' else 'Student'}
    d.update(revision=row.revision,students=[user(v) for v in visible if v.role=='student' and v.requested_role=='student'],applicants=[user(v) for v in visible if v.requested_role=='teacher'],teachingNames=names,account={'username':u.username,'name':own,'roles':[u.role],'sid':u.id},role=u.role,sid=u.id)
    return d

@router.post('/portal/save')
async def save(request: Request,u=Depends(actor),db=Depends(get_db)):
    incoming=await request.json()
    with lock:
        row=document(db)
        if incoming.get('revision')!=row.revision: raise HTTPException(409,'Data have been updated on another device. Refresh and try again')
        d=copy.deepcopy(row.data);view=state(u,db);name=view['account']['name']
        valid_students={v.id for v in db.scalars(select(User).where(User.role=='student',User.status=='active'))}
        if u.role=='admin':
            proposed=incoming.get('cases',[])
            if {c['id'] for c in proposed}!={c['id'] for c in d['cases']}: raise HTTPException(400,'Add new cases through the case material import workflow')
            for c in d['cases']:
                p=next(v for v in proposed if v['id']==c['id'])
                c.update(state=p['state'],selfPractice=bool(p.get('selfPractice')),teachers=[n for n in p.get('teachers',[]) if n in view['teachingNames']])
        elif u.role=='teacher':
            gs=incoming.get('teacherGroups',{}).get(name,[])
            if any(not set(g['ids'])<=valid_students for g in gs): raise HTTPException(400,'Invalid Student')
            d['teacherGroups'][name]=gs
            d['teacherStudents'][name]=[i for i in incoming.get('teacherStudents',{}).get(name,[]) if i in valid_students]
            for p in incoming.get('tasks',[]):
                old=next((t for t in d['tasks'] if t['id']==p['id']),None)
                if old:
                    if old['owner']!=name: raise HTTPException(403,'Not authorized to modify another Teacher’s tasks')
                    old['feedback']={k:str(v)[:1000] for k,v in p.get('feedback',{}).items() if int(k) in old['ids']}
                    for k,r in old.get('removalRequests',{}).items():
                        decision=p.get('removalRequests',{}).get(k,{})
                        if r['status']=='pending' and decision.get('status') in ('approved','rejected'): r.update(status=decision['status'],reviewedBy=name)
                else:
                    c=next((c for c in d['cases'] if c['id']==p['caseId'] and c['state']=='Published' and name in c['teachers']),None)
                    if not c or not p['ids'] or not set(p['ids'])<=valid_students: raise HTTPException(403,'Case or Student is unavailable for assignment')
                    d['tasks'].append({k:p[k] for k in ('id','name','caseId','ids','due','mode')}|{'owner':name,'progress':{},'notes':{},'feedback':{}})
        elif u.role=='student':
            for p in incoming.get('tasks',[]):
                t=next((t for t in d['tasks'] if t['id']==p['id'] and u.id in t['ids']),None)
                r=p.get('removalRequests',{}).get(str(u.id))
                if t and r and r.get('status')=='pending' and r.get('reason','').strip():
                    old=t.setdefault('removalRequests',{}).get(str(u.id),{})
                    if old.get('status')!='approved':t['removalRequests'][str(u.id)]={'reason':r['reason'][:500],'status':'pending'}
        row.data=d;row.revision+=1
        db.add(AuditEvent(actor_id=u.id,action='portal_save',target='portal',detail={'revision':row.revision}))
        db.commit();return {'revision':row.revision}

@router.post('/portal/review/{user_id}/{decision}')
def review(user_id:int,decision:str,u=Depends(actor),db=Depends(get_db)):
    if u.role!='admin':raise HTTPException(403,'Administrator privileges required')
    v=db.get(User,user_id)
    if not v or v.status not in ('pending','rejected') or decision not in ('approve','reject'):raise HTTPException(400,'Invalid application status')
    v.status='active' if decision=='approve' else 'rejected'
    if decision=='approve':v.role=v.requested_role
    db.add(AuditEvent(actor_id=u.id,action=decision,target=f'user:{user_id}'));db.commit();return {'ok':True}

def engine(case,method,path,**kwargs):
    url=engine_url(case)
    if not url:raise HTTPException(400,'This case has not yet been integrated into training')
    url=url.rstrip('/')
    try:return httpx.request(method,url+'/'+path,headers={'Origin':url},timeout=60,trust_env=False,**kwargs)
    except httpx.HTTPError:raise HTTPException(503,'Case service not started. Please contact the Administrator.')

@router.post('/portal/start/{case_id}')
def start(case_id:int,task:str='',u=Depends(actor),db=Depends(get_db)):
    if u.role!='student' or not engine_url(case_id):raise HTTPException(403,'Only Students can start training')
    with lock:
        d=document(db).data;c=next(c for c in d['cases'] if c['id']==case_id)
        if task:
            t=next((t for t in d['tasks'] if str(t['id'])==task and t['caseId']==case_id and u.id in t['ids']),None)
            if not t or t.get('removalRequests',{}).get(str(u.id),{}).get('status')=='approved':raise HTTPException(403,'This task is unavailable')
        elif not c.get('selfPractice'):raise HTTPException(403,'Self-directed practice not enabled')
        key=task or 'practice:'+str(case_id)
        a=db.scalar(select(PortalAttempt).where(PortalAttempt.user_id==u.id,PortalAttempt.task_key==key))
        if not a:
            r=engine(case_id,'POST','api/session',json={'mode':'exam' if task and t['mode']=='Exam' else 'practice'})
            if r.status_code!=200:raise HTTPException(502,'Case service could not create a session')
            s=r.json();a=PortalAttempt(id=secrets.token_urlsafe(24),user_id=u.id,task_key=key,case_id=case_id,engine_id=s['id'],state=s);db.add(a);db.commit()
        return {'url':'/training/'+a.id+'/'}

POSTS={'api/ward-next','api/tick','api/retry','api/message','api/notes','api/checks','api/wait-results','api/report','api/import','api/medication-orders','api/operation-orders','api/order','api/advance','api/feedback','api/intervention/start','api/intervention/confirm','api/attachment'}

@router.api_route('/training/{attempt_id}/{path:path}',methods=['GET','POST'])
async def training(attempt_id:str,path:str,request:Request,u=Depends(actor),db=Depends(get_db)):
    a=db.get(PortalAttempt,attempt_id)
    if not a or a.user_id!=u.id:raise HTTPException(404,'Training not found')
    prefix='/training/'+a.id
    if request.method=='GET' and path=='voice-worklet.js':
        return FileResponse(ROOT/'voice-worklet.js',media_type='text/javascript',headers={'Cache-Control':'no-store'})
    if request.method=='POST':
        if path=='api/voice/transcribe':
            role=request.query_params.get('role')
            if role not in ('patient','senior','team') or (role=='team' and a.state.get('stage')!=1) or (a.state.get('stage')==4 and (role!='senior' or a.state.get('mode')=='exam')):
                raise HTTPException(403,'Voice input is not available in the current text field')
            from .voice_input import transcribe
            return await transcribe(request)
        if path=='api/new-practice':
            if not a.task_key.startswith('practice:'):raise HTTPException(403,'Access Teacher-assigned tasks through the learning platform; they cannot be restarted here.')
            c=next((c for c in document(db).data['cases'] if c['id']==a.case_id),None)
            if not c or not c.get('selfPractice'):raise HTTPException(403,'This case is not available for self-directed practice')
            r=engine(a.case_id,'POST','api/session',json={'mode':'practice'})
            if r.status_code!=200:raise HTTPException(502,'Failed to create practice session. Please try again')
            state=r.json()
            active=db.scalar(select(PortalAttempt).where(PortalAttempt.user_id==u.id,PortalAttempt.task_key=='practice:'+str(a.case_id)))
            if active:active.task_key+=':archived:'+active.id
            new=PortalAttempt(id=secrets.token_urlsafe(24),user_id=u.id,task_key='practice:'+str(a.case_id),case_id=a.case_id,engine_id=state['id'],state=state)
            db.add(new);db.commit()
            return {'url':'/training/'+new.id+'/'}
        if path=='api/attempt-link':return {'ok':True}
        if path not in POSTS:raise HTTPException(403,'Action unavailable')
        data=await request.json();data['id']=a.engine_id
        r=engine(a.case_id,'POST',path,json=data)
    else:
        q=dict(request.query_params)
        if path.startswith(('api/','pacs/')):q['id']=a.engine_id
        r=engine(a.case_id,'GET',path,params=q)
    kind=r.headers.get('content-type','application/octet-stream')
    if 'application/json' in kind:
        data=r.json()
        s=data.get('state',data)
        if isinstance(s,dict) and s.get('id')==a.engine_id and 'messages' in s:a.state=s;db.commit()
        # Presentation-only cleanup; retain provenance and original clinical records.
        if path=='api/report':
            def clean_names(v):
                if isinstance(v,dict):return {k:(str(x).replace('（Fictional）','').replace('(Fictional)','') if k in ('name','patient','patient_name') and isinstance(x,str) else clean_names(x)) for k,x in v.items()}
                if isinstance(v,list):return [clean_names(x) for x in v]
                return v
            data=clean_names(data)
        return Response(json.dumps(data,ensure_ascii=False),status_code=r.status_code,media_type='application/json')
    content=r.content
    if 'text/html' in kind:
        text=r.text
        text=text.replace('Scenario','Scenario').replace('Registration information complete; admission not yet processed','').replace('Registration information complete; admission not yet processed','')
        for attr in ('src','href'):text=text.replace(attr+'="/',attr+'="'+prefix+'/')
        content=text.encode()
    elif path=='app.js':
        text=r.text
        text=text.replace(' · Registration information is complete; not yet admitted','').replace('Li Zhiqiang (fictional）','Li Zhiqiang').replace('Zhang Jianguo (fictional）','Zhang Jianguo')
        text=text.replace('approximately 1 Automatically returns after minutes and advances the simulated time accordingly','Results return at the expected reporting time; click “Wait for Results” to fast-forward simulated time.').replace('approximately 1 Automatically return after minutes','Results return at the expected reporting time; you can also click “Wait for Results” to fast-forward.')
        text=text.replace('Scenario','Scenario').replace('Registration information complete; admission not yet processed','').replace('Registration information complete; admission not yet processed','')
        text=text.replace('result.error ||', 'result.error || result.detail ||')
        text=text.replace('/style.css?v=rx-native-3',prefix+'/style.css?v=rx-native-4')
        text=text.replace('!Object.values(state.notes||{}).some(Boolean)',"!Object.entries(state.notes||{}).some(([k,v])=>k!=='general'&&Boolean(v))")
        text=text.replace("case 'reconnect':if(state)await refresh();else await initialize();break;", "case 'reconnect':localError='';if(state){accept(await api('/api/retry',{id:state.id}));schedulePoll();}else await initialize();break;")
        text=text.replace("portalParams.get('portalTask')",json.dumps(None if a.task_key.startswith('practice:') else a.task_key))
        text=text.replace("portalParams.get('portalMode')",json.dumps(a.state.get('mode','practice')))
        text=text.replace("portalParams.get('portalStudent')", json.dumps(u.username)).replace("portalParams.get('portalName')",json.dumps(u.display_name))
        text=text.replace("'http://127.0.0.1:8876/portal.html?return='", "'/portal.html?return='")
        text=text.replace("location.protocol+'//'+location.hostname+':8876/portal.html?return='", "'/portal.html?return='")
        # All API calls and image URLs stay behind the authenticated gateway.
        text=text.replace("'/api/", "'"+prefix+"/api/").replace('"/api/', '"'+prefix+'/api/')
        for folder in ('assets','pacs'):
            text=text.replace('"/'+folder+'/', '"'+prefix+'/'+folder+'/').replace("'/"+folder+'/',"'"+prefix+'/'+folder+'/')
        text=text.replace("const sid=restoreId||sessionStorage.getItem(rehearsalStorageKey);", "const sid="+json.dumps(a.engine_id)+";")
        text=text.replace("crypto.randomUUID()", "(globalThis.crypto?.randomUUID?.()||Date.now().toString(16)+Math.random().toString(16).slice(2))")
        text="const portalGateway="+json.dumps(prefix)+";\n"+text+'\n'+(ROOT/'training-extra.js').read_text(encoding='utf-8')+'\n'+(ROOT/'hold-voice.js').read_text(encoding='utf-8')
        content=text.encode()
    return Response(content,status_code=r.status_code,media_type=kind,headers={'Cache-Control':'no-store'})

@router.get('/case-materials/{path:path}')
def materials(path:str,u=Depends(actor)):
    if u.role not in ('admin','teacher'):raise HTTPException(403,'Complete teaching materials are available only to Teachers and Administrators')
    root=(ROOT.parent/'materials').resolve();file=(root/path).resolve()
    if not file.is_relative_to(root) or not file.is_file():raise HTTPException(404)
    return FileResponse(file)
