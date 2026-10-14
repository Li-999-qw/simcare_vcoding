"""Local single-user rehearsal server, using official logged-in Codex CLI."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor
import json, secrets, threading, time, argparse, subprocess, copy
from case import REGISTRATION, CASE_ID, VERSION, STAGES, TIMES, FACTS, REPORTS, LEGACY_REPORTS, PATIENT_BASE, TEACHING
from agent import generate
from codex_transport import CONNECTION
from report_catalog import import_excerpt, display_info
from feedback import overview, REVIEW_PROMPT
from attachments import save_image, path_for
import local_voice
from pacs_gateway import serve_pacs
from medical_records import EXTRA_KEYS, capture as capture_document, documents as medical_documents
from operation_orders import catalogue as operation_catalogue, validate as validate_operations
from timeline import clock as clinical_clock, available as available_checks, allocate as allocate_checks, ready as report_ready, wait_for_results, release_due

ROOT = Path(__file__).resolve().parent
from sys import path as _sys_path
_sys_path.insert(0, str(next(p for p in ROOT.parents if (p / 'backend/runtime/engine_store.py').is_file())))
from backend.runtime.engine_store import load_sessions, save_sessions, save_attempt_link
from backend.runtime.case_store import load_case
from backend.runtime.case_presentation import load_presentation
ENGINE_KEY = 'lumbar'
_case_content=load_case(ENGINE_KEY, CASE_ID, REGISTRATION, FACTS, REPORTS)
_presentation=load_presentation(ENGINE_KEY, STAGES, TIMES)
STAGES[:]=_presentation['stage_names']
TIMES[:]=_presentation['stage_times']
REGISTRATION.clear(); REGISTRATION.update(_case_content['registration'])
FACTS.clear(); FACTS.update(_case_content['facts'])
REPORTS.clear(); REPORTS.update(_case_content['reports'])
SESSIONS = {}
SESSION_FILE=ROOT/'runtime'/'sessions.json'
AUDIO=ROOT/'runtime'/'audio'
try:
    SESSIONS=load_sessions(ENGINE_KEY, SESSION_FILE)
    for saved in SESSIONS.values():
        saved['known']=dict(saved['known']);saved['request_ids']=set(saved['request_ids']);saved['busy']=False;saved['streaming']=None
except (OSError,ValueError,TypeError):SESSIONS={}
LOCK = threading.RLock()
POOL = ThreadPoolExecutor(max_workers=1)
MAX_SESSIONS = 50
NOTE_KEYS = ('history','exam','tests','diagnosis','reason','plan','daily','discharge','discharge_diagnosis','discharge_advice') + EXTRA_KEYS
OPENERS = ['医生，我腰和左腿痛了好一阵，最近左脚抬起来也费劲。','请完成术前决策，选择手术后接收团队回报。','医生，左腿比之前不那么痛了，脚背还有点麻。','医生，回去后怎么活动、什么时候复查？','演练已提交。']

def persist():
    save_sessions(ENGINE_KEY, SESSIONS)

def normalize(s):
    s.setdefault('registration',copy.deepcopy(REGISTRATION))
    if s.get('notes',{}).get('general'):
        s['notes']['general']=s['notes']['general'].replace('姓名：李某某','姓名：'+s['registration']['name'])
    if s.get('stage')==0 and '入院登记：' in s.get('notes',{}).get('general',''):
        s['notes']['general']=s['notes']['general'].split('入院登记：')[0]+'门诊登记：骨科普通门诊；挂号资料齐备，尚未办理入院。'
    if not s.setdefault('notes',{}).get('general','').strip():
        r=s['registration']
        s['notes']['general']=f"姓名：{r['name']}；性别：{r['sex']}；年龄：{r['age']}；民族：{r['ethnicity']}\n婚姻：{r['marital_status']}；职业：{r['occupation']}；籍贯：{r['birthplace']}\n现住址：{r['address']}\n病史陈述者：{r['history_source']}\n门诊登记：{r['admission_status']}"
    s.setdefault('attachments',{})
    s.setdefault('check_batches',[])
    if release_due(s):persist()
    s.setdefault('intervention',{'status':'none'})
    s.setdefault('streaming',None)
    s.setdefault('feedback',{'status':'ready' if any(m.get('role')=='senior' and m.get('stage')==4 and m.get('speaker')=='assistant' for m in s.get('messages',[])) else 'none'})
    if s['feedback']['status']=='ready' and s['feedback'].get('version')!=2:s['feedback']={'status':'none'}
    if 'report_payloads' not in s:
        # An expanded catalogue must not retrospectively expand evidence in old attempts.
        s['report_payloads']={key:copy.deepcopy(LEGACY_REPORTS.get(key,REPORTS[key])) for key in s.get('reports',[])}
    for report in s['report_payloads'].values():
        if report.get('category')=='心电' and report.get('positive','').startswith('窦性心律'):
            report['positive']=report['positive'].split('。',1)[-1]
    s.setdefault('orders', [])
    s.setdefault('snapshots', {})
    s.setdefault('requested_reports', list(s['reports']))
    if s.get('note_schema', 1) < 2:
        # Keep legacy free text intact; stage-specific fields start from existing work.
        notes=s['notes']
        if s['stage'] >= 2: notes.setdefault('daily', notes.get('plan',''))
        if s['stage'] >= 3: notes.setdefault('discharge_diagnosis', notes.get('diagnosis',''))
        s['note_schema']=2

def treatment_summary(s):
    meds = [{'time':o.get('clinical_time','时间未记录'),'text':o['text']} for o in s.get('orders',[]) if o.get('kind')=='medication']
    checks = [{'time':e.get('clinical_time','时间未记录'),'text':e['name']} for e in s.get('events',[]) if e.get('action')=='申请检查']
    operations=[{'time':o.get('clinical_time','时间未记录'),'text':o['text']} for o in s.get('orders',[]) if o.get('kind')=='operation']
    return {'operations':sorted(operations,key=lambda x:x['time']), 'medications':sorted(meds,key=lambda x:x['time']), 'checks':sorted(checks,key=lambda x:x['time'])}


def public(s):
    normalize(s)
    return {k:copy.deepcopy(s[k]) for k in ('id','mode','stage','messages','reports','requested_reports','orders','notes','snapshots','busy','streaming','error','hint_count','events','feedback','intervention','check_batches')} | {
      'registration':copy.deepcopy(s['registration']),'medical_documents':medical_documents(s),'treatment_summary':treatment_summary(s),'operation_catalog':operation_catalogue(),
      'intervention_report':copy.deepcopy(REPORTS['handoff']) if s['stage']==1 and s['intervention'].get('status')=='started' and time.time()>=s['intervention']['ready_at'] else None,
      'report_status':{k:{'ready':report_ready(s,k),'reported':s.get('report_payloads',{}).get(k,{}).get('sheet',{}).get('reported','见报告')} for k in s['requested_reports']},
      'record_review':overview(s) if s['stage']==4 else [],
      'case_id':CASE_ID,'version':VERSION,'stages':STAGES,'time':('模拟时间 '+clinical_clock(s)) if s['stage']<4 else '演练结束',
      'catalog':[{'id':k,'name':v['name'],'category':v['category'],'stage':v['stage'],'orderable':k in available_checks(s,REPORTS).values(),**display_info(k,s['report_payloads'].get(k,v))} for k,v in REPORTS.items() if v['stage'] <= s['stage']],
      'report_results':{k:copy.deepcopy(s['report_payloads'][k]) for k in s['reports']},
      'engine':'Codex · 当前账号', 'role_names':{'patient':'患者','senior':'上级医师'}}

def context(s,role,text,attachment_ids=None):
    stage = s['stage']
    normalize(s)
    allowed = {k:FACTS[k] for k in PATIENT_BASE}
    allowed['registration']=s['notes']['general']
    allowed['pain' if stage<2 else 'ward_patient' if stage==2 else 'discharge_patient'] = FACTS['pain' if stage<2 else 'ward_patient' if stage==2 else 'discharge_patient']
    # Keep teacher answers completely outside the patient's context.
    history = [m for m in s['messages'] if m.get('role') == role][-16:]
    result = {'role':'患者' if role=='patient' else '上级医师','case_version':VERSION,
              'stage':STAGES[stage],'time':('模拟时间 '+clinical_clock(s)) if stage<4 else '演练结束','mode':s['mode'],
              'time_policy':'检查使用对应病程阶段的病例模板；申请、采样与报告时间为模拟调度，原始病例时间单独保留。同批抽血同一采样时间，点击等待后模拟时钟推进，真实等待时间不等于临床时间。本轮不评价真实操作时效。',
              'reply_language':s.get('reply_language','zh'),'student_text':text,'history':history,'allowed_facts':{},'known_facts':{},'reports':{}}
    if role=='patient':
        result['allowed_facts'] = allowed
        result['everyday_background']={'称呼':'可以叫我'+s['registration']['name']+'。','现居地':s['registration']['address'],'生活背景':FACTS['daily_life']}
        result['patient_continuity']=[m['text'] for m in s['messages'] if m.get('role')=='patient' and m.get('speaker')=='assistant']
    else:
        image_ids=list(dict.fromkeys([a for m in s['messages'] if m.get('role')=='senior' for a in m.get('attachments',[])]+list(attachment_ids or [])))[-3:]
        result['image_paths']=[str(path_for(s,a)) for a in image_ids]
        result['uploaded_images']={a:'学生上传的截图，非自动核验病例证据' for a in image_ids}
        result['known_facts'] = copy.deepcopy(s['known'])
        result['known_facts']['registration']=s['notes']['general']
        result['registration_policy']='一般资料由门诊挂号预填。当前接诊为骨科普通门诊，尚未入院；建议住院或手术不等于已经办理或执行。'
        result['reports'] = {k:s.get('report_payloads',{}).get(k,LEGACY_REPORTS.get(k,REPORTS[k]))['text'] for k in s['reports']}
        result['notes'] = s['notes']
        result['medical_documents'] = medical_documents(s)
        result['history'] = copy.deepcopy(s['messages'])
        result['snapshots'] = copy.deepcopy(s.get('snapshots',{}))
        result['events'] = s['events']
        result['orders'] = copy.deepcopy(s.get('orders',[]))
        result['treatment_summary'] = treatment_summary(s)
        result['medication_review_instruction']='你一直跟进本次演练。回答前结合完整问诊、各阶段病历、已查看检查、全部药品与操作医嘱及当前模拟时间。先回应学生的具体问题，引用实际记录，不要求重复提供已有信息。没有开立记录仅表示尚未开立，不妨碍给出明确的教学建议；建议和已执行治疗严格区分。'
        if s['mode']=='practice':
            drug_data=json.loads((ROOT/'drug-catalog.json').read_text(encoding='utf-8'))
            ordered_names={o.get('name') for o in s.get('orders',[]) if o.get('kind')=='medication'}
            result['medication_reference']={d['id']:{'name':d['name'],'regimen':d.get('common_regimen',{}),'template':d.get('case_template',{}),'review_status':d.get('dose_review_status','')} for d in drug_data['items'] if d.get('case_medication') or d.get('catalog_role')=='guideline' or d['name'] in ordered_names}
            result['reference_policy']='medication_reference是教学用药参考，不是患者已用药记录。结合阶段、适应证及禁忌选择，不要照抄全部药物或把负荷量当维持量。可用其中有依据的药名、剂量、途径、频次回答具体用药问题；不自动开立处方。参考缺少剂量时明确该项需核对，不否定所有可用参考。'

        result['intervention']=s.get('intervention',{'status':'none'})
        result['patient_detail_policy']='生活交流细节可能是教学补充，不能据此推断临床风险、医学事实或已执行治疗。'
        result['stage2_scope']='第二阶段是脊柱手术决策，不要求学生扮演术者。原病例手术过程为预设，应核对定位、手术指征及风险沟通，不能算作学生实际手术。'
        result['teaching_reference'] = TEACHING[stage] if s['mode']=='practice' else '考试：只受理临床上报，不给教学答案、分数或通过结论，不声称请求已执行。'
        if stage==4 and s['mode']=='practice':
            result['history']=copy.deepcopy(s['messages'])
            if text==REVIEW_PROMPT:result['history']=[m for m in result['history'] if m.get('stage',0)<4]
            result['snapshots']=copy.deepcopy(s.get('snapshots',{}))
            result['teaching_reference']=copy.deepcopy(TEACHING)
    if role=='senior':
        from lumbar_supervision import enrich
        enrich(result,s,ROOT)
    return copy.deepcopy(result)

def work(sid,role,text,ctx=None,queued_at=None,feedback=False):
    start=queued_at or time.monotonic()
    if ctx is None:
        with LOCK:ctx=context(SESSIONS[sid],role,text)
    def preview(value):
        with LOCK:SESSIONS[sid]['streaming']={'role':role,'text':value,'stage':SESSIONS[sid]['stage']}
    try:
        reply=generate(ctx,on_preview=preview,session_key=(sid,role,ctx['stage'],ctx['mode'],VERSION))
        with LOCK:
            s=SESSIONS[sid]
            if role=='patient' and not reply.get('gap'):
                # Only the words actually disclosed become known, never a whole hidden fact bundle.
                s['known']['disclosure_'+secrets.token_hex(4)] = reply['reply']
            hint = bool(reply.get('hint')) and role=='senior' and s['mode']=='practice'
            s['hint_count'] += int(hint)
            s['messages'].append({'id':secrets.token_hex(8),'speaker':'assistant','role':role,'text':reply['reply'],
                                  'stage':s['stage'],'seconds':round(time.monotonic()-start,1),'gap':bool(reply.get('gap')),'hint':hint,'timing':reply.get('timing',{}),'feedback_review':feedback})
            s['error']=''
            if feedback:s['feedback']={'status':'ready','version':2}
    except Exception as exc:
        with LOCK:
            SESSIONS[sid]['error'] = '模型回复超时，请重试。' if isinstance(exc,(subprocess.TimeoutExpired,TimeoutError)) else str(exc)[:200]
            if feedback:SESSIONS[sid]['feedback']={'status':'error'}
    finally:
        with LOCK:
            SESSIONS[sid]['busy']=False
            SESSIONS[sid]['streaming']=None
            persist()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,data,code=200,kind='application/json; charset=utf-8'):
        body = json.dumps(data,ensure_ascii=False).encode() if isinstance(data,(dict,list)) else data
        self.send_response(code)
        self.send_header('Content-Type',kind)
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'self'")
        self.end_headers()
        self.wfile.write(body)
    def good_host(self):
        return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}')
    def do_GET(self):
        if not self.good_host(): return self.send({'error':'Invalid host'},403)
        p=urlparse(self.path)
        if p.path.startswith('/pacs/'):
            return serve_pacs(self,p,SESSIONS,LOCK)
        if p.path in ('/assets/patient-scenes-v1.png','/assets/cath-lab-v1.png'):
            return self.send((ROOT/'public'/'assets'/Path(p.path).name).read_bytes(),kind='image/png')
        if p.path in ('/','/app.js','/style.css','/order-entry.html','/order-drug-catalog.js'):
            filename={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/order-entry.html':'order-entry.html','/order-drug-catalog.js':'order-drug-catalog.js'}[p.path]
            kind={'/':'text/html; charset=utf-8','/app.js':'text/javascript; charset=utf-8','/style.css':'text/css; charset=utf-8','/order-entry.html':'text/html; charset=utf-8','/order-drug-catalog.js':'text/javascript; charset=utf-8'}[p.path]
            return self.send((ROOT/'public'/filename).read_bytes(),kind=kind)
        if p.path=='/api/health': return self.send({'ok':True,'engine':'Codex CLI','case':CASE_ID})
        if p.path=='/api/report-image':
            query=parse_qs(p.query);sid=query.get('id',[''])[0];key=query.get('report',[''])[0]
            with LOCK:
                s=SESSIONS.get(sid)
                if not s or key not in s.get('reports',[]):return self.send({'error':'请先查看当前可用报告。'},403)
                filename=s.get('report_payloads',{}).get(key,{}).get('sheet',{}).get('image')
            if not filename:return self.send({'error':'该报告无图像。'},404)
            return self.send((ROOT/'report-assets'/filename).read_bytes(),kind='image/png')
        if p.path.startswith('/audio/'):
            name=p.path[len('/audio/'):]
            if len(name)==36 and name.endswith('.wav') and all(c in '0123456789abcdef' for c in name[:-4]):
                audio=AUDIO/name
                if audio.is_file():return self.send(audio.read_bytes(),kind='audio/wav')
            return self.send({'error':'Audio not found'},404)
        if p.path in ('/api/attachment','/api/voice/status'):
            sid=parse_qs(p.query).get('id',[''])[0]
            with LOCK:
                s=SESSIONS.get(sid)
                if not s:return self.send({'error':'会话不存在'},404)
                if p.path=='/api/voice/status':return self.send(local_voice.public(sid))
                try:
                    path=path_for(s,parse_qs(p.query).get('attachment',[''])[0])
                    return self.send(path.read_bytes(),kind='image/png')
                except (ValueError,OSError):return self.send({'error':'截图不存在'},404)
        if p.path=='/api/state':
            sid=parse_qs(p.query).get('id',[''])[0]
            with LOCK:
                if sid not in SESSIONS: return self.send({'error':'会话不存在，请新建演练。'},404)
                return self.send(public(SESSIONS[sid]))
        return self.send({'error':'Not found'},404)
    def do_POST(self):
        if not self.good_host(): return self.send({'error':'Invalid host'},403)
        origin=self.headers.get('Origin')
        if origin not in (f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'):
            return self.send({'error':'仅允许本地演练页发送请求'},403)
        try:
            size=int(self.headers.get('Content-Length','0'))
            limit=6*1024*1024 if urlparse(self.path).path=='/api/attachment' else 240000
            if not 0 < size <= limit: return self.send({'error':'请求过大'},413)
            data=json.loads(self.rfile.read(size))
            if not isinstance(data,dict): raise ValueError()
        except (ValueError,TypeError): return self.send({'error':'请求格式错误'},400)
        path=urlparse(self.path).path
        if path in ('/api/recognize','/api/speech'):
            with LOCK:
                s=SESSIONS.get(data.get('id',''))
                if not s:return self.send({'error':'会话不存在'},404)
                if s['busy']:return self.send({'error':'请等待当前对话完成'},409)
                if path=='/api/recognize' and s['stage']==4 and s['mode']=='exam':return self.send({'error':'考试已经提交'},403)
                if path=='/api/speech':
                    msg=next((m for m in s['messages'] if m['id']==data.get('message_id') and m['speaker']=='assistant'),None)
                    if not msg:return self.send({'error':'请选择已有的角色回复'},400)
                    AUDIO.mkdir(parents=True,exist_ok=True);name=secrets.token_hex(16)+'.wav'
                    command=['powershell.exe','-NoProfile','-File',str(ROOT/'voice.ps1'),'-Action','synthesize','-OutputPath',str(AUDIO/name)]
                    payload=json.dumps({'text':msg['text']},ensure_ascii=False)
                else:
                    command=['powershell.exe','-NoProfile','-File',str(ROOT/'voice.ps1'),'-Action','recognize'];payload=''
                s['busy']=True
            try:
                done=subprocess.run(command,input=payload,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=35,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                result=json.loads(done.stdout.strip())
                if done.returncode or result.get('error'):
                    result={'error':'没有识别到语音，请检查默认麦克风后重试。' if result.get('error')=='no_speech' else '本机中文语音组件未完成操作，请检查音频设备。'}
                elif path=='/api/speech':result={'audio':'/audio/'+name}
            except Exception:result={'error':'语音处理超时或设备不可用，请重试。'}
            finally:
                with LOCK:s['busy']=False
            return self.send(result,400 if result.get('error') else 200)
        with LOCK:
            if path=='/api/attempt-link':
                student=data.get('student');task=str(data.get('task',''));sid=data.get('session')
                if not isinstance(student,str) or not 0<len(student)<=80 or not task.isdigit() or sid not in SESSIONS:return self.send({'error':'Invalid attempt'},400)
                save_attempt_link(ENGINE_KEY,student,task,sid)
                return self.send({'ok':True})
            if path=='/api/session':
                if len(SESSIONS)>=MAX_SESSIONS: return self.send({'error':'本次服务会话数已满，请重启。'},429)
                mode=data.get('mode','practice')
                if mode not in ('practice','exam'): return self.send({'error':'模式无效'},400)
                sid=secrets.token_urlsafe(24)
                s={'id':sid,'mode':mode,'stage':0,'known':{'identity':FACTS['identity'],'initial':OPENERS[0]},'notes':{},'reports':[],
                   'busy':False,'error':'','hint_count':0,'events':[],'request_ids':set(),'note_schema':2,'orders':[],'requested_reports':[],
                   'messages':[{'id':secrets.token_hex(8),'speaker':'assistant','role':'patient','text':OPENERS[0],'stage':0,'initial':True}]}
                normalize(s)
                SESSIONS[sid]=s
                persist()
                return self.send(public(s))
            s=SESSIONS.get(data.get('id',''))
            if not s: return self.send({'error':'会话不存在'},404)
            if path in ('/api/message','/api/feedback','/api/retry') and data.get('reply_language') in ('zh','en'):
                s['reply_language']=data['reply_language']
            normalize(s)
            if path in ('/api/voice/start','/api/voice/stop'):
                if path.endswith('stop'):return self.send(local_voice.cancel(s['id']))
                role=data.get('role')
                if role not in ('patient','senior') or (s['stage']==4 and (role=='patient' or s['mode']=='exam')):return self.send({'error':'当前场景不可语音输入'},403)
                try:return self.send(local_voice.start(s['id'],role))
                except ValueError as e:return self.send({'error':str(e)},409)
            if path=='/api/attachment':
                if s['mode']=='exam':return self.send({'error':'考试模式不开放截图请教'},403)
                if len(s['attachments'])>=30:return self.send({'error':'本次演练最多保存30张截图'},400)
                try:item=save_image(s,data)
                except ValueError as e:return self.send({'error':str(e)},400)
                persist();return self.send(item)
            if s['busy'] and path not in ('/api/notes','/api/checks','/api/report','/api/import','/api/medication-orders','/api/operation-orders'):
                return self.send({'error':'正在等待角色回复，请稍候。'},409)
            if path=='/api/feedback':
                if s['stage']!=4 or s['mode']!='practice':return self.send({'error':'完整点评仅在练习提交后开放。'},403)
                if s['feedback']['status']=='ready':return self.send(public(s))
                s['feedback']={'status':'generating'};s['busy']=True;s['error']='';s['streaming']=None
                POOL.submit(work,s['id'],'senior',REVIEW_PROMPT,context(s,'senior',REVIEW_PROMPT),time.monotonic(),True)
            elif path=='/api/message':
                role=data.get('role'); text=data.get('text',''); rid=data.get('request_id','')
                if role not in ('patient','senior') or not isinstance(text,str) or not 1<=len(text.strip())<=2000 or not isinstance(rid,str) or not rid:
                    return self.send({'error':'请选择角色，输入1～2000字。'},400)
                images=data.get('attachments',[])
                if not isinstance(images,list) or len(images)>3 or any(not isinstance(a,str) or a not in s['attachments'] for a in images):return self.send({'error':'截图无效，每轮最多3张'},400)
                if images and (role!='senior' or s['mode']=='exam'):return self.send({'error':'截图仅供练习模式请教上级医师'},403)
                if rid in s['request_ids']: return self.send(public(s))
                if len(s['request_ids'])>=60: return self.send({'error':'本次已达60轮，请导出记录后新建演练。'},429)
                if s['stage']==4 and (role=='patient' or s['mode']=='exam'):
                    return self.send({'error':'已提交。考试解析等待教师发布；患者对话已结束。'},403)
                s['request_ids'].add(rid); s['error']=''; s['busy']=True;s['streaming']=None
                s['messages'].append({'id':rid,'speaker':'student','role':role,'text':text.strip(),'stage':s['stage'],'attachments':images})
                POOL.submit(work,s['id'],role,text.strip(),context(s,role,text.strip(),images),time.monotonic())
            elif path=='/api/checks':
                keys=data.get('reports',[])
                if s['stage']==4: return self.send({'error':'已提交，不能新增检查。'},403)
                if not isinstance(keys,list) or not 1 <= len(keys) <= len(REPORTS) or any(not isinstance(k,str) or k not in REPORTS or REPORTS[k]['stage']>s['stage'] or REPORTS[k]['category'] in ('查体','交接') for k in keys):
                    return self.send({'error':'请选择当前场景可申请的检查。'},400)
                choices=available_checks(s,REPORTS)
                resolved=[]
                for key in keys:
                    family=display_info(key,REPORTS[key])['order_name']
                    if family not in choices:return self.send({'error':'当前病程阶段没有该检查的结果模板，不能用既往结果替代。'},400)
                    resolved.append(choices[family])
                allocate_checks(s,resolved,REPORTS)
            elif path=='/api/wait-results':
                if s['stage']==4:return self.send({'error':'已提交，不能推进时间。'},403)
                if type(data.get('all',False)) is not bool:return self.send({'error':'等待方式无效。'},400)
                wait_for_results(s,data.get('all',False))
            elif path=='/api/report':
                key=data.get('report')
                if not isinstance(key,str) or key not in REPORTS or REPORTS[key]['stage']>s['stage']: return self.send({'error':'当前场景尚不可获取该报告。'},403)
                if s['stage']==4 and key not in s['reports']: return self.send({'error':'已提交，不能新增检查。'},403)
                if key not in s['requested_reports'] and key not in ('exam','ward','discharge'):
                    if key not in available_checks(s,REPORTS).values():return self.send({'error':'请申请当前病程阶段的检查；既往未申请的结果不能补发。'},403)
                    allocate_checks(s,[key],REPORTS)
                if not report_ready(s,key):
                    persist()
                    return self.send({'error':'检查中，请等待模拟时间到达报告完成时间。'},409)
                if key not in s['reports']:
                    if key not in s['requested_reports']:s['requested_reports'].append(key)
                    s['reports'].append(key); s['events'].append({'stage':s['stage'],'action':'查看报告','name':REPORTS[key]['name']})
                    s['report_payloads'].setdefault(key,copy.deepcopy(REPORTS[key]))
                persist()
                return self.send({'report':s['report_payloads'][key], 'state':public(s)})
            elif path=='/api/import':
                key=data.get('report')
                if s['stage']==4:return self.send({'error':'记录已提交锁定。'},403)
                if not isinstance(key,str) or key not in s['reports']:return self.send({'error':'请先查看报告。'},400)
                target='exam' if key=='exam' else 'tests'
                positive_only=data.get('positive_only',False)
                if type(positive_only) is not bool:return self.send({'error':'导入方式无效。'},400)
                excerpt=import_excerpt(s['report_payloads'][key],positive_only)
                if 'edited_text' in data:
                    edited=data['edited_text']
                    if not isinstance(edited,str) or not edited.strip() or len(edited)>6000:return self.send({'error':'导入内容须为1～6000字。'},400)
                    excerpt=edited.strip()
                if not excerpt:return self.send({'error':'本报告未记录阳性/异常所见；可按需要导入完整报告。'},400)
                previous=s['notes'].get(target,'')
                if excerpt not in previous:
                    value=previous+('\n' if previous else '')+excerpt
                    if len(value)>6000:return self.send({'error':'记录超过6000字，请整理后再导入。'},400)
                    s['notes'][target]=value
                    capture_document(s,[target],clinical_clock(s))
                    s['events'].append({'stage':s['stage'],'action':'导入病历','name':REPORTS[key]['name'],'report':key,'edited': 'edited_text' in data,'clinical_time':clinical_clock(s)})
            elif path=='/api/operation-orders':
                if s['stage']==4:return self.send({'error':'记录已提交锁定。'},403)
                rows=data.get('rows');rid=data.get('request_id')
                if not isinstance(rid,str) or not 1<=len(rid)<=100:return self.send({'error':'请求标识无效。'},400)
                try:choices=validate_operations(rows)
                except ValueError as e:return self.send({'error':str(e)},400)
                if not any(o.get('batch_id')==rid for o in s['orders']):
                    for index,row in enumerate(rows):
                        name=choices[row['operation_id']]['name']
                        params='；'.join(f'{k}：{v.strip()}' for k,v in row['params'].items() if v.strip())
                        text=f"{name}；{params}；频次：{row['frequency']}；时长：{row['duration']}；{row['type']}"+(f"；备注：{row['remark']}" if row['remark'].strip() else '')
                        s['orders'].append(dict(copy.deepcopy(row),id=f'{rid}-{index}',batch_id=rid,kind='operation',name=name,text=text,clinical_time=clinical_clock(s),stage=s['stage'],status='已开立 · 未核实执行'))
                        s['events'].append({'stage':s['stage'],'action':'确认操作医嘱','name':text,'clinical_time':clinical_clock(s)})
            elif path=='/api/medication-orders':
                if s['stage']==4:return self.send({'error':'记录已提交锁定。'},403)
                rows=data.get('rows');rid=data.get('request_id')
                fields=('name','dose','unit','use','route','type','days','quantity','remark') if s['stage']==0 else ('name','dose','unit','use','route','type','remark')
                if not isinstance(rid,str) or not rid or not isinstance(rows,list) or not 1<=len(rows)<=100:return self.send({'error':'请填写药品医嘱。'},400)
                for row in rows:
                    if not isinstance(row,dict) or any(not isinstance(row.get(k),str) or len(row[k])>1000 for k in fields):return self.send({'error':'医嘱格式错误。'},400)
                    if any(not row[k].strip() or row[k]=='请选择' for k in fields[:-1]) or row['type'] not in (('门诊处方',) if s['stage']==0 else ('临时医嘱','长期医嘱','长期有药','临时有药')):return self.send({'error':'请补齐药品医嘱。'},400)
                    try:valid=0<float(row['dose'])<float('inf')
                    except ValueError:valid=False
                    if not valid:return self.send({'error':'剂量应大于零。'},400)
                if not any(o.get('batch_id')==rid for o in s['orders']):
                    stamp=clinical_clock(s)
                    for index,row in enumerate(rows):
                        item={k:row[k].strip() for k in fields}
                        text=f"{item['name']}；剂量：{item['dose']} {item['unit']}；用法：{item['use']}；给药途径：{item['route']}；医嘱类型：{item['type']}；备注：{item['remark'] or '无'}"
                        if s['stage']==0:text+=f"；疗程：{item['days']}；总量：{item['quantity']}"
                        s['orders'].append(dict(item,id=f'{rid}-{index}',batch_id=rid,kind='medication',text=text,clinical_time=stamp,stage=s['stage'],status='已确认医嘱 · 未核实执行'))
                        s['events'].append({'stage':s['stage'],'action':'确认药品医嘱','name':text,'clinical_time':stamp})
            elif path=='/api/order':
                text=data.get('text','');rid=data.get('request_id','')
                if s['stage']!=1:return self.send({'error':'请在处置与交接场景记录指令。'},403)
                if not isinstance(text,str) or not 1<=len(text.strip())<=2000 or not isinstance(rid,str) or not rid:return self.send({'error':'请输入1～2000字的处置指令。'},400)
                if not any(o['id']==rid for o in s['orders']):
                    s['orders'].append({'id':rid,'text':text.strip(),'status':'已记录 · 待执行核对','stage':1})
                    s['events'].append({'stage':1,'action':'记录处置指令','name':text.strip()})
            elif path=='/api/notes':
                if s['stage']==4: return self.send({'error':'记录已提交锁定。'},403)
                notes=data.get('notes',{})
                if not isinstance(notes,dict) or any(k not in NOTE_KEYS or not isinstance(v,str) or len(v)>6000 for k,v in notes.items()):
                    return self.send({'error':'病历内容格式错误。'},400)
                s['notes'].update(notes)
                capture_document(s,notes,clinical_clock(s))
            elif path=='/api/intervention/start':
                if s['stage']!=1:return self.send({'error':'请在手术治疗阶段选择。'},403)
                if s['intervention']['status']=='none':
                    s['intervention']={'status':'started','ready_at':time.time()+10}
                    s['events'].append({'stage':1,'action':'选择手术治疗','name':'联系脊柱手术团队','clinical_time':clinical_clock(s)})
            elif path=='/api/intervention/confirm':
                if s['intervention']['status']=='confirmed':return self.send(public(s))
                if s['stage']!=1 or s['intervention']['status']!='started' or time.time()<s['intervention']['ready_at']:
                    return self.send({'error':'请先选择手术并等待团队回报。'},409)
                s['intervention']['status']='confirmed'
                s['events'].append({'stage':1,'action':'确认手术团队回报','name':REPORTS['handoff']['name']})
                if 'handoff' not in s['reports']:s['reports'].append('handoff')
                if 'handoff' not in s['requested_reports']:s['requested_reports'].append('handoff')
                s['report_payloads']['handoff']=copy.deepcopy(REPORTS['handoff'])
                s['snapshots']['1']={k:copy.deepcopy(s[k]) for k in ('notes','reports','requested_reports','orders','events')}
                s['clinical_clock']=max(clinical_clock(s),'2026-09-04 13:00')
                s['stage']=2
                s['events'].append({'stage':2,'action':'进入场景','name':STAGES[2]})
                s['messages'].append({'id':secrets.token_hex(8),'speaker':'system','role':'system','text':OPENERS[2],'stage':2})
            elif path=='/api/advance':
                if s['stage']==1:return self.send({'error':'请先选择手术并确认团队回报。'},409)
                if s['stage']>=4: return self.send({'error':'已经结束。'},400)
                if s['stage']==3 and not s['notes'].get('discharge','').strip(): return self.send({'error':'请先填写并保存出院记录。'},400)
                s['snapshots'][str(s['stage'])]={k:copy.deepcopy(s[k]) for k in ('notes','reports','requested_reports','orders','events')}
                s['stage']+=1
                s['events'].append({'stage':s['stage'],'action':'进入场景','name':STAGES[s['stage']]})
                if s['stage']==2:
                    if 'handoff' not in s['reports']:
                        s['reports'].append('handoff');s['report_payloads']['handoff']=copy.deepcopy(REPORTS['handoff'])
                    if 'handoff' not in s['requested_reports']:s['requested_reports'].append('handoff')
                    s['events'].append({'stage':2,'action':'接收预设交接报告','name':REPORTS['handoff']['name']})
                s['messages'].append({'id':secrets.token_hex(8),'speaker':'system','role':'system','text':OPENERS[s['stage']],'stage':s['stage']})
            else: return self.send({'error':'Not found'},404)
            persist()
            return self.send(public(s))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8770);args=parser.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    def warm_connection():
        try:
            with CONNECTION.lock:CONNECTION.connect()
        except Exception:pass
    POOL.submit(warm_connection)
    threading.Thread(target=local_voice.warm,daemon=True).start()
    print(f'Rehearsal ready: http://127.0.0.1:{server.server_port}',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close();CONNECTION.close()

