import copy, json, secrets, threading, time
from pathlib import Path
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse
from sqlalchemy import select
from .config import settings
from .db import get_db, SessionLocal
from .models import User, AuditEvent
from .portal_models import PortalDocument, PortalAttempt
from .security import verify_password, start_login_session, session_user, end_login_session
from backend.runtime.case_presentation import (
    asset_mime, covered_portal_cases, get_presentation, local_service_url, resolve_asset_path,
)
from backend.runtime.training_ui import STYLE as SHARED_STYLE, render_html

router = APIRouter()
lock = threading.RLock()
tts_usage = {}
ROOT = Path(__file__).parent
SHARED_CARDIAC = ROOT.parents[1] / 'engines/chest/public/app.js'

def engine_url(case_id):
    profile=get_presentation(case_id)
    return local_service_url(profile['service_url']) if profile else None

def actor(request: Request, db=Depends(get_db)):
    token = request.cookies.get('clinical_session') or request.headers.get('Authorization','').removeprefix('Bearer ')
    u = session_user(db, token)
    if request.method not in ('GET','HEAD') and request.headers.get('Origin') and request.headers['Origin'] != str(request.base_url).rstrip('/'):
        raise HTTPException(403, '来源不匹配')
    return u

def document(db):
    row=db.scalar(select(PortalDocument).order_by(PortalDocument.id).limit(1))
    if not row:
        row=PortalDocument(revision=0, data={'cases':json.loads((ROOT/'catalog.json').read_text(encoding='utf-8')), 'tasks':[], 'teacherGroups':{}, 'teacherStudents':{}})
        db.add(row);db.commit()
    return row

@router.get('/portal/case-cover/{case_id}')
def case_cover(case_id:int,u=Depends(actor)):
    from attempt_language import portal_locale
    profile=get_presentation(case_id,portal_locale.get()) or get_presentation(case_id)
    if not profile:raise HTTPException(404,'病例封面不存在')
    try:cover=resolve_asset_path(profile['cover_image_path'])
    except (ValueError,FileNotFoundError):raise HTTPException(404,'病例封面不存在')
    return FileResponse(cover,media_type=asset_mime(profile['cover_image_path']),headers={'Cache-Control':'private, no-store'})

@router.post('/portal/login')
async def login(request: Request, response: Response, db=Depends(get_db)):
    d=await request.json();u=db.scalar(select(User).where(User.username==d.get('username')))
    if not u or not verify_password(d.get('password',''),u.password_hash): raise HTTPException(401,'用户名或密码错误')
    if u.status!='active': raise HTTPException(403,'注册申请尚未审核通过')
    response.set_cookie('clinical_session',start_login_session(db,u),httponly=True,samesite='strict',secure=request.url.scheme=='https',max_age=settings.access_token_hours*3600)
    return {'ok':True}

@router.post('/portal/logout')
def logout(request: Request, response: Response, db=Depends(get_db)):
    if request.headers.get('Origin') and request.headers['Origin'] != str(request.base_url).rstrip('/'):
        raise HTTPException(403, '来源不匹配')
    token = request.cookies.get('clinical_session') or request.headers.get('Authorization','').removeprefix('Bearer ')
    end_login_session(db, token)
    response.delete_cookie('clinical_session');return {'ok':True}


@router.get('/portal/session')
def login_status(response: Response, u=Depends(actor)):
    response.headers['Cache-Control'] = 'no-store'
    return {'ok': True}


@router.get('/session-guard.js')
def session_guard():
    from backend.runtime.login_sessions import GUARD_PATH
    return FileResponse(GUARD_PATH,
                        media_type='text/javascript', headers={'Cache-Control': 'no-store'})

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
        return {'id':v.id,'name':v.display_name,'studentNo':v.username,'major':(v.profile or {}).get('major',''),'phone':(v.profile or {}).get('phone','') if u.role=='admin' or v.id==u.id else '', 'dept':'未设置','year':1,'status':{'active':'通过','pending':'待审核','rejected':'退回补充'}.get(v.status,v.status),'mine':v.id in d['teacherStudents'].get(own,[]),'role':'教师' if v.requested_role=='teacher' else '学生'}
    d.update(revision=row.revision,students=[user(v) for v in visible if v.role=='student' and v.requested_role=='student'],applicants=[user(v) for v in visible if v.requested_role=='teacher'],teachingNames=names,account={'username':u.username,'name':own,'roles':[u.role],'sid':u.id},role=u.role,sid=u.id,coverCaseIds=sorted(covered_portal_cases()))
    return d

@router.post('/portal/save')
async def save(request: Request,u=Depends(actor),db=Depends(get_db)):
    incoming=await request.json()
    with lock:
        row=document(db)
        if incoming.get('revision')!=row.revision: raise HTTPException(409,'其他设备已更新数据，请刷新后重试')
        d=copy.deepcopy(row.data);view=state(u,db);name=view['account']['name']
        valid_students={v.id for v in db.scalars(select(User).where(User.role=='student',User.status=='active'))}
        if u.role=='admin':
            proposed=incoming.get('cases',[])
            if {c['id'] for c in proposed}!={c['id'] for c in d['cases']}: raise HTTPException(400,'新病例请通过病例资料导入流程添加')
            for c in d['cases']:
                p=next(v for v in proposed if v['id']==c['id'])
                c.update(state=p['state'],selfPractice=bool(p.get('selfPractice')),teachers=[n for n in p.get('teachers',[]) if n in view['teachingNames']])
        elif u.role=='teacher':
            gs=incoming.get('teacherGroups',{}).get(name,[])
            if any(not set(g['ids'])<=valid_students for g in gs): raise HTTPException(400,'无效学生')
            d['teacherGroups'][name]=gs
            d['teacherStudents'][name]=[i for i in incoming.get('teacherStudents',{}).get(name,[]) if i in valid_students]
            for p in incoming.get('tasks',[]):
                old=next((t for t in d['tasks'] if t['id']==p['id']),None)
                if old:
                    if old['owner']!=name: raise HTTPException(403,'无权修改其他教师任务')
                    old['feedback']={k:str(v)[:1000] for k,v in p.get('feedback',{}).items() if int(k) in old['ids']}
                    for k,r in old.get('removalRequests',{}).items():
                        decision=p.get('removalRequests',{}).get(k,{})
                        if r['status']=='pending' and decision.get('status') in ('approved','rejected'): r.update(status=decision['status'],reviewedBy=name)
                else:
                    c=next((c for c in d['cases'] if c['id']==p['caseId'] and c['state']=='已发布' and name in c['teachers']),None)
                    if not c or not p['ids'] or not set(p['ids'])<=valid_students: raise HTTPException(403,'病例或学生不可分配')
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
    if u.role!='admin':raise HTTPException(403,'需要管理员权限')
    v=db.get(User,user_id)
    if not v or v.status not in ('pending','rejected') or decision not in ('approve','reject'):raise HTTPException(400,'申请状态无效')
    v.status='active' if decision=='approve' else 'rejected'
    if decision=='approve':v.role=v.requested_role
    db.add(AuditEvent(actor_id=u.id,action=decision,target=f'user:{user_id}'));db.commit();return {'ok':True}

def engine(case,method,path,**kwargs):
    url=engine_url(case)
    if not url:raise HTTPException(400,'该病例尚未接入训练')
    url=url.rstrip('/')
    try:return httpx.request(method,url+'/'+path,headers={'Origin':url},timeout=60,trust_env=False,**kwargs)
    except httpx.HTTPError:raise HTTPException(503,'病例服务未启动，请联系管理员')

@router.post('/portal/start/{case_id}')
def start(case_id:int,task:str='',u=Depends(actor),db=Depends(get_db)):
    if u.role!='student' or not engine_url(case_id):raise HTTPException(403,'仅学生可开始训练')
    with lock:
        d=document(db).data;c=next(c for c in d['cases'] if c['id']==case_id)
        if task:
            t=next((t for t in d['tasks'] if str(t['id'])==task and t['caseId']==case_id and u.id in t['ids']),None)
            if not t or t.get('removalRequests',{}).get(str(u.id),{}).get('status')=='approved':raise HTTPException(403,'该任务不可用')
        elif not c.get('selfPractice'):raise HTTPException(403,'未开放自主练习')
        key=task or 'practice:'+str(case_id)
        a=db.scalar(select(PortalAttempt).where(PortalAttempt.user_id==u.id,PortalAttempt.task_key==key))
        if not a:
            r=engine(case_id,'POST','api/session',json={'mode':'exam' if task and t['mode']=='考试' else 'practice'})
            if r.status_code!=200:raise HTTPException(502,'病例服务未能创建会话')
            s=r.json();a=PortalAttempt(user_id=u.id,task_key=key,case_id=case_id,engine_id=s['id'],state=s);db.add(a);db.commit()
        return {'url':'/training/'+a.id+'/'}

POSTS={'api/ward-next','api/tick','api/retry','api/message','api/notes','api/checks','api/wait-results','api/report','api/import','api/medication-orders','api/operation-orders','api/order','api/advance','api/feedback','api/intervention/start','api/intervention/confirm','api/attachment'}

@router.api_route('/training/{attempt_id}/{path:path}',methods=['GET','POST'])
async def training(attempt_id:str,path:str,request:Request,u=Depends(actor),db=Depends(get_db)):
    a=db.get(PortalAttempt,attempt_id)
    if not a or a.user_id!=u.id:raise HTTPException(404,'训练不存在')
    prefix='/training/'+a.id
    locale='en' if request.url.path.startswith('/en/') or request.scope.get('root_path','').startswith('/en') else 'zh'
    presentation=get_presentation(a.case_id,locale) or get_presentation(a.case_id)
    if not presentation:raise HTTPException(404,'病例展示配置不存在')
    if request.method=='GET' and path in ('','index.html'):
        return HTMLResponse(render_html(presentation,prefix+'/'),headers={'Cache-Control':'no-store'})
    if request.method=='GET' and path=='style.css':
        return FileResponse(SHARED_STYLE,media_type='text/css',headers={'Cache-Control':'no-store'})
    if request.method=='GET' and path.startswith('case-asset/'):
        key=path.removeprefix('case-asset/')
        column={'scene':'scene_image_path','intervention':'intervention_image_path'}.get(key)
        if not column or not presentation.get(column):raise HTTPException(404,'病例图片不存在')
        try:image=resolve_asset_path(presentation[column])
        except (ValueError,FileNotFoundError):raise HTTPException(404,'病例图片不存在')
        return FileResponse(image,media_type=asset_mime(presentation[column]),headers={'Cache-Control':'private, no-store'})
    if path in ('api/tts', 'api/tts/status'):
        from tencent_tts import authorized_text, credentials, pcm_stream, voice_for_case, SAMPLE_RATE
        case=next((c for c in document(db).data['cases'] if c['id']==a.case_id),None)
        if not case:raise HTTPException(404,'病例不存在')
        source=case.get('sourceCaseId','')
        if request.method=='GET' and path=='api/tts/status':
            return {'configured':bool(credentials()),'patient_voice':voice_for_case(a.case_id,source,'patient'),
                    'senior_voice':voice_for_case(a.case_id,source,'senior')}
        if request.method!='POST' or path!='api/tts':raise HTTPException(405,'方法不支持')
        try:data=await request.json()
        except (ValueError,TypeError):raise HTTPException(400,'语音请求格式错误')
        role=data.get('role');spoken=data.get('text')
        voice=voice_for_case(a.case_id,source,role)
        if voice is None:raise HTTPException(403,'此角色的语音暂不支持')
        if not authorized_text(a.state,role,spoken):raise HTTPException(403,'只能朗读当前病例中的角色回复')
        configured=credentials()
        if not configured:raise HTTPException(503,'请先配置腾讯云语音合成凭据')
        with lock:
            since,used=tts_usage.get(a.id,(time.monotonic(),0))
            if time.monotonic()-since>3600:since,used=time.monotonic(),0
            if used+len(spoken)>12000:raise HTTPException(429,'本次训练的语音额度已达上限')
            tts_usage[a.id]=(since,used+len(spoken))
        return StreamingResponse(pcm_stream(spoken,voice,configured),media_type='application/octet-stream',
                                 headers={'Cache-Control':'no-store','X-Audio-Sample-Rate':str(SAMPLE_RATE),
                                          'X-Content-Type-Options':'nosniff'})
    if request.method=='GET' and path=='voice-worklet.js':
        return FileResponse(ROOT/'voice-worklet.js',media_type='text/javascript',headers={'Cache-Control':'no-store'})
    if request.method=='POST':
        if path=='api/voice/transcribe':
            role=request.query_params.get('role')
            if role not in ('patient','senior','team') or (role=='team' and a.state.get('stage')!=1) or (a.state.get('stage')==4 and (role!='senior' or a.state.get('mode')=='exam')):
                raise HTTPException(403,'当前输入框不开放语音输入')
            from .voice_input import transcribe
            return await transcribe(request)
        if path=='api/new-practice':
            if not a.task_key.startswith('practice:'):raise HTTPException(403,'教师任务请从学习平台进入，不能在这里重开')
            c=next((c for c in document(db).data['cases'] if c['id']==a.case_id),None)
            if not c or not c.get('selfPractice'):raise HTTPException(403,'该病例未开放自主练习')
            r=engine(a.case_id,'POST','api/session',json={'mode':'practice'})
            if r.status_code!=200:raise HTTPException(502,'创建练习失败，请重试')
            state=r.json()
            active=db.scalar(select(PortalAttempt).where(PortalAttempt.user_id==u.id,PortalAttempt.task_key=='practice:'+str(a.case_id)))
            if active:active.task_key+=':archived:'+active.id
            new=PortalAttempt(user_id=u.id,task_key='practice:'+str(a.case_id),case_id=a.case_id,engine_id=state['id'],state=state)
            db.add(new);db.commit()
            return {'url':'/training/'+new.id+'/'}
        if path=='api/attempt-link':return {'ok':True}
        if path not in POSTS:raise HTTPException(403,'操作不可用')
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
                if isinstance(v,dict):return {k:(str(x).replace('（虚构）','').replace('(虚构)','') if k in ('name','patient','patient_name') and isinstance(x,str) else clean_names(x)) for k,x in v.items()}
                if isinstance(v,list):return [clean_names(x) for x in v]
                return v
            data=clean_names(data)
        return Response(json.dumps(data,ensure_ascii=False),status_code=r.status_code,media_type='application/json')
    content=r.content
    if 'text/html' in kind:
        text=r.text
        text=text.replace('情景','情境').replace('挂号资料齐备，尚未办理住院','').replace('挂号资料齐备尚未办理住院','')
        for attr in ('src','href'):text=text.replace(attr+'="/',attr+'="'+prefix+'/')
        content=text.encode()
    elif path=='app.js':
        text=SHARED_CARDIAC.read_text(encoding='utf-8') if presentation['ui_variant']=='cardiac' else r.text
        text=text.replace(' · 挂号资料齐备，尚未入院','').replace('李志强（虚构）','李志强').replace('张建国（虚构）','张建国')
        # New attempts must be persisted and owned by the authenticated student.
        text=text.replace("const next=await api('/api/session',{mode});", "const created=await api('/api/new-practice',{mode});location.assign(created.url);return;")
        text=text.replace('约1分钟后自动返回并同步推进模拟时间','按预计报告时间返回；可点击“等待结果”快进模拟时间').replace('约1分钟后自动返回','到预计报告时间返回，也可点击“等待结果”快进')
        text=text.replace('情景','情境').replace('挂号资料齐备，尚未办理住院','').replace('挂号资料齐备尚未办理住院','')
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
        text="const portalGateway="+json.dumps(prefix)+";\n"+text+'\n'+(ROOT/'training-extra.js').read_text(encoding='utf-8')+'\n'+(ROOT/'hold-voice.js').read_text(encoding='utf-8')+'\n'+(ROOT/'speech-segments.js').read_text(encoding='utf-8')+'\n'+(ROOT/'speech-output.js').read_text(encoding='utf-8')
        content=text.encode()
    return Response(content,status_code=r.status_code,media_type=kind,headers={'Cache-Control':'no-store'})

@router.get('/case-materials/{path:path}')
def materials(path:str,u=Depends(actor)):
    if u.role not in ('admin','teacher'):raise HTTPException(403,'完整教学资料仅供教师与管理员查看')
    root=(ROOT.parent/'materials').resolve();file=(root/path).resolve()
    if not file.is_relative_to(root) or not file.is_file():raise HTTPException(404)
    return FileResponse(file)
