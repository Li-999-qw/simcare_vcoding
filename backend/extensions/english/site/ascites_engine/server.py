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
from case import day_of, ward_report, WARD_SYMPTOMS, teaching
from ascites_runtime import enrich, next_day, medication_reference
from medical_records import EXTRA_KEYS, capture as capture_document, documents as medical_documents
from operation_orders import catalogue as operation_catalogue, validate as validate_operations
from timeline import clock as clinical_clock, available as available_checks, allocate as allocate_checks, ready as report_ready, wait_for_results, release_due

ROOT = Path(__file__).resolve().parent
from sys import path as _sys_path
_sys_path.insert(0, str(next(p for p in ROOT.parents if (p / 'backend/runtime/engine_store.py').is_file())))
from backend.runtime.engine_store import load_sessions, save_sessions, save_attempt_link
from backend.runtime.case_store import load_case
from backend.runtime.case_presentation import load_presentation
ENGINE_KEY = 'en-ascites'
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
POOL = ThreadPoolExecutor(max_workers=4)
MAX_SESSIONS = 1000
NOTE_KEYS = ('history','exam','tests','diagnosis','reason','plan','daily','discharge','discharge_diagnosis','discharge_advice') + EXTRA_KEYS
OPENERS = ['Doctor, my abdomen is very bloated, my legs are swollen, and I have passed less urine over the past two days.。','Document the day-one management and handoff plan based on test results obtained.。','Begin daily ward rounds; subsequent materials become available by date and reporting time.。','Doctor, how should I take my medicines after going home, and when should I return for follow-up?？','Simulation submitted。']

def persist():
    save_sessions(ENGINE_KEY, SESSIONS)

def release_due(session):
    changed=False
    for batch in session.get('check_batches',[]):
        if batch.get('released') or session['stage']==4:continue
        if not all(report_ready(session,key) for key in batch['reports']):continue
        batch['released']=True
        session['events'].append({'stage':session['stage'],'action':'Test results returned','name':batch['id'],'clinical_time':clinical_clock(session)})
        changed=True
    return changed

def normalize(s):
    s.setdefault('registration',copy.deepcopy(REGISTRATION))
    if not s.setdefault('notes',{}).get('general','').strip():
        r=s['registration']
        s['notes']['general']=f"Name：{r['name']}；Sex：{r['sex']}；Age：{r['age']}；Marital status：{r['marital_status']}；Occupation：{r['occupation']}；Current address：{r['address']}；History provided by：{r['history_source']}；Gastroenterology admission intake"
    if s['stage']==2:
        from case import REPORTS
        report=copy.deepcopy(REPORTS['ward']);report['text']=ward_report(s);report['sheet']['findings']=report['text']
        report['sheet']['collected']=report['sheet']['reported']=clinical_clock(s)
        s.setdefault('report_payloads',{})['ward']=report
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
        if report.get('category')=='Electrocardiography' and report.get('positive','').startswith('Sinus rhythm'):
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
    meds = [{'time':o.get('clinical_time','Time not recorded'),'text':o['text']} for o in s.get('orders',[]) if o.get('kind')=='medication']
    checks = [{'time':e.get('clinical_time','Time not recorded'),'text':e['name']} for e in s.get('events',[]) if e.get('action')=='Request Examination']
    operations=[{'time':o.get('clinical_time','Time not recorded'),'text':o['text']} for o in s.get('orders',[]) if o.get('kind')=='operation']
    return {'operations':sorted(operations,key=lambda x:x['time']), 'medications':sorted(meds,key=lambda x:x['time']), 'checks':sorted(checks,key=lambda x:x['time'])}


def public(s):
    normalize(s)
    return {k:copy.deepcopy(s[k]) for k in ('id','mode','stage','messages','reports','requested_reports','orders','notes','snapshots','busy','streaming','error','hint_count','events','feedback','intervention','check_batches')} | {
      'registration':copy.deepcopy(s['registration']),'medical_documents':medical_documents(s),'treatment_summary':treatment_summary(s),'operation_catalog':operation_catalogue(),
      'intervention_report':copy.deepcopy(REPORTS['handoff']) if s['stage']==1 and s['intervention'].get('status')=='started' and time.time()>=s['intervention']['ready_at'] else None,
      'report_status':{k:{'ready':report_ready(s,k),'reported':s.get('report_payloads',{}).get(k,{}).get('sheet',{}).get('reported','See report')} for k in s['requested_reports']},
      'record_review':overview(s) if s['stage']==4 else [],
      'case_id':CASE_ID,'version':VERSION,'stages':STAGES,'time':('Simulation Time '+clinical_clock(s)+':'+str(int(s.get('active_seconds',0))).zfill(2)) if s['stage']<4 else 'End of simulation',
      'catalog':[{'id':k,'name':v['name'],'category':v['category'],'stage':v['stage'],'orderable':k in available_checks(s,REPORTS).values(),**display_info(k,s['report_payloads'].get(k,v))} for k,v in REPORTS.items() if v['stage'] <= s['stage'] and v['available_at'][:10] <= clinical_clock(s)[:10]],
      'report_results':{k:copy.deepcopy(s['report_payloads'][k]) for k in s['reports']},
      'ward_day':day_of(s),'engine':'Codex · Current Account', 'role_names':{'patient':'Patient','senior':'Supervising Physician'}}

def context(s,role,text,attachment_ids=None):
    stage = s['stage']
    normalize(s)
    allowed = {k:FACTS[k] for k in PATIENT_BASE}
    allowed['registration']=s['notes']['general']
    allowed['pain' if stage<2 else 'ward_patient' if stage==2 else 'discharge_patient'] = FACTS['pain' if stage<2 else 'ward_patient' if stage==2 else 'discharge_patient']
    # Keep teacher answers completely outside the patient's context.
    history = [m for m in s['messages'] if m.get('role') == role][-16:]
    result = {'role':'Patient' if role=='patient' else 'Supervising Physician','case_version':VERSION,
              'stage':STAGES[stage],'time':('Simulation Time '+clinical_clock(s)) if stage<4 else 'End of simulation','mode':s['mode'],
              'time_policy':'Tests use the case template for the corresponding clinical stage. Order, collection, and report times are scheduled within the simulation; original case times are retained separately. Blood samples in the same batch share one collection time. Clicking Wait advances the simulation clock; time spent with the practice page in the foreground is measured in real time.1:1 Advance; pauses when you leave the page. You can still jump ahead in simulated time while waiting for tests or switching clinical stages.。',
              'student_text':text,'history':history,'allowed_facts':{},'known_facts':{},'reports':{}}
    if role=='patient':
        if stage>=2:
            allowed.pop('pain',None)
            allowed['ward_patient']=WARD_SYMPTOMS.get(day_of(s),FACTS['discharge_patient'])
            if day_of(s)==4 and 'drainage' in s['reports']:allowed['ward_patient']='Abdominal distension improved markedly after fluid drainage; the Patient can eat and lie flat more comfortably。'
        result['allowed_facts'] = allowed
        result['everyday_background']={'Form of address':'You can call me Mr. Wang。','Current place of residence':REGISTRATION['address'],'Living Circumstances':FACTS['daily_life']}
        result['patient_continuity']=[m['text'] for m in s['messages'] if m.get('role')=='patient' and m.get('speaker')=='assistant']
    else:
        image_ids=list(dict.fromkeys([a for m in s['messages'] if m.get('role')=='senior' for a in m.get('attachments',[])]+list(attachment_ids or [])))[-3:]
        result['image_paths']=[str(path_for(s,a)) for a in image_ids]
        result['uploaded_images']={a:'Screenshot uploaded by a Student, not automatically verified case evidence' for a in image_ids}
        result['known_facts'] = copy.deepcopy(s['known'])
        result['known_facts']['registration']=s['notes']['general']
        result['registration_policy']='This is an inpatient gastroenterology admission encounter. Plans, orders placed, and actual execution are strictly distinguished.。'
        result['reports'] = {k:s.get('report_payloads',{}).get(k,LEGACY_REPORTS.get(k,REPORTS[k]))['text'] for k in s['reports']}
        result['notes'] = s['notes']
        result['medical_documents'] = medical_documents(s)
        result['history'] = copy.deepcopy(s['messages'])
        result['snapshots'] = copy.deepcopy(s.get('snapshots',{}))
        result['events'] = s['events']
        result['orders'] = copy.deepcopy(s.get('orders',[]))
        result['treatment_summary'] = treatment_summary(s)
        result['medication_review_instruction']='You have followed this exercise throughout. Before answering, consider the complete history-taking dialogue, clinical notes from each stage, reviewed tests, all medication and procedure orders, and the current simulation time. Address the Student’s specific question first, citing actual records without requesting information already available. The absence of an order record only means that no order has yet been placed; it does not prevent clear teaching recommendations. Strictly distinguish recommendations from treatment actually performed.。'
        if s['mode']=='practice':
            result['medication_reference']=medication_reference(s)
            result['reference_policy']='Medication references for the current case stage only, not records of treatment performed by the Student. They must not automatically generate orders on the Student’s behalf.。'
        result['intervention']=s.get('intervention',{'status':'none'})
        result['patient_detail_policy']='Details of everyday conversation may be teaching additions and cannot establish clinical risks, medical facts, or treatment already performed.。'
        result['stage2_scope']='Stage 2 covers medical management on the first day, with no surgery. The subsequent clinical course is preset; do not count reference treatment as treatment performed by the Student.。'
        result['teaching_reference'] = teaching(s) if s['mode']=='practice' else 'Exam: accepts clinical reports only; provides no teaching answers, scores, or pass decisions, and does not claim that requests have been carried out.。'
        if stage==4 and s['mode']=='practice':
            result['history']=copy.deepcopy(s['messages'])
            if text==REVIEW_PROMPT:result['history']=[m for m in result['history'] if m.get('stage',0)<4]
            result['snapshots']=copy.deepcopy(s.get('snapshots',{}))
            result['teaching_reference']=copy.deepcopy(TEACHING)
    if role=='senior':
        enrich(result,s,ROOT)
    return copy.deepcopy(result)

def work(sid,role,text,ctx=None,queued_at=None,feedback=False):
    start=queued_at or time.monotonic()
    if ctx is None:
        with LOCK:ctx=context(SESSIONS[sid],role,text)
    def preview(value):
        with LOCK:SESSIONS[sid]['streaming']={'role':role,'text':value,'stage':SESSIONS[sid]['stage']}
    try:
        reply=generate(ctx,on_preview=preview,session_key=None)
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
            SESSIONS[sid]['error'] = 'Model response timed out. Please try again。' if isinstance(exc,(subprocess.TimeoutExpired,TimeoutError)) else str(exc)[:200]
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
            return self.send({'error':'View examination images for this case in the reports'},404)
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
                if not s or key not in s.get('reports',[]):return self.send({'error':'Please view the currently available reports first。'},403)
                filename=s.get('report_payloads',{}).get(key,{}).get('sheet',{}).get('image')
            if not filename:return self.send({'error':'No images in this report。'},404)
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
                if not s:return self.send({'error':'Session does not exist'},404)
                if p.path=='/api/voice/status':return self.send(local_voice.public(sid))
                try:
                    path=path_for(s,parse_qs(p.query).get('attachment',[''])[0])
                    return self.send(path.read_bytes(),kind='image/png')
                except (ValueError,OSError):return self.send({'error':'Screenshot not found'},404)
        if p.path=='/api/state':
            sid=parse_qs(p.query).get('id',[''])[0]
            with LOCK:
                if sid not in SESSIONS: return self.send({'error':'Session not found. Please start a new simulation。'},404)
                return self.send(public(SESSIONS[sid]))
        return self.send({'error':'Not found'},404)
    def do_POST(self):
        if not self.good_host(): return self.send({'error':'Invalid host'},403)
        origin=self.headers.get('Origin')
        if origin not in (f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'):
            return self.send({'error':'Only the local rehearsal page may send requests'},403)
        try:
            size=int(self.headers.get('Content-Length','0'))
            limit=6*1024*1024 if urlparse(self.path).path=='/api/attachment' else 240000
            if not 0 < size <= limit: return self.send({'error':'Request Too Large'},413)
            data=json.loads(self.rfile.read(size))
            if not isinstance(data,dict): raise ValueError()
        except (ValueError,TypeError): return self.send({'error':'Invalid request format'},400)
        path=urlparse(self.path).path
        if path in ('/api/recognize','/api/speech'):
            with LOCK:
                s=SESSIONS.get(data.get('id',''))
                if not s:return self.send({'error':'Session does not exist'},404)
                if s['busy']:return self.send({'error':'Please wait for the current conversation to finish'},409)
                if path=='/api/recognize' and s['stage']==4 and s['mode']=='exam':return self.send({'error':'Exam already submitted'},403)
                if path=='/api/speech':
                    msg=next((m for m in s['messages'] if m['id']==data.get('message_id') and m['speaker']=='assistant'),None)
                    if not msg:return self.send({'error':'Please select an existing role response'},400)
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
                    result={'error':'No speech detected. Check the default microphone and try again。' if result.get('error')=='no_speech' else 'The local Chinese-language speech component did not complete the operation. Please check your audio devices.。'}
                elif path=='/api/speech':result={'audio':'/audio/'+name}
            except Exception:result={'error':'Speech processing timed out or the device is unavailable. Try again。'}
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
                if len(SESSIONS)>=MAX_SESSIONS: return self.send({'error':'Session limit reached for this service. Please restart.。'},429)
                mode=data.get('mode','practice')
                if mode not in ('practice','exam'): return self.send({'error':'Invalid Mode'},400)
                sid=secrets.token_urlsafe(24)
                s={'id':sid,'mode':mode,'stage':0,'known':{'identity':FACTS['identity'],'initial':OPENERS[0]},'notes':{},'reports':[],
                   'busy':False,'error':'','hint_count':0,'events':[],'request_ids':set(),'note_schema':2,'orders':[],'requested_reports':[],
                   'messages':[{'id':secrets.token_hex(8),'speaker':'assistant','role':'patient','text':OPENERS[0],'stage':0,'initial':True}]}
                normalize(s)
                SESSIONS[sid]=s
                persist()
                return self.send(public(s))
            s=SESSIONS.get(data.get('id',''))
            if not s: return self.send({'error':'Session does not exist'},404)
            normalize(s)
            if path=='/api/ward-next':
                if s['busy']:return self.send({'error':'Please wait for the role response to finish'},409)
                try:next_day(s)
                except ValueError as e:return self.send({'error':str(e)},400)
                persist();return self.send(public(s))
            if path=='/api/tick':
                now=time.time(); previous=s.get('active_tick',now)
                elapsed=max(0,min(20,now-previous)) if now-previous<30 else 0
                s['active_tick']=now
                if s['stage']<4:
                    from datetime import datetime,timedelta
                    s['active_seconds']=s.get('active_seconds',0)+elapsed
                    minutes=int(s['active_seconds']//60)
                    if minutes:
                        s['clinical_clock']=(datetime.fromisoformat(clinical_clock(s))+timedelta(minutes=minutes)).strftime('%Y-%m-%d %H:%M')
                        s['active_seconds']%=60
                persist();return self.send(public(s))
            if path=='/api/retry':
                if s['busy']:return self.send({'error':'Still waiting for a reply. Please wait。'},409)
                if not s.get('error'):return self.send(public(s))
                last=next((m for m in reversed(s['messages']) if m.get('speaker')=='student' and m.get('role') in ('patient','senior')),None)
                if not last:return self.send({'error':'No questions available to retry。'},400)
                if last.get('stage')!=s['stage']:return self.send({'error':'A new stage has begun. Ask your question again in the current stage。'},409)
                s['error']='';s['busy']=True;s['streaming']=None
                POOL.submit(work,s['id'],last['role'],last['text'],context(s,last['role'],last['text'],last.get('attachments',[])),time.monotonic())
                persist();return self.send(public(s))
            if path in ('/api/voice/start','/api/voice/stop'):
                if path.endswith('stop'):return self.send(local_voice.cancel(s['id']))
                role=data.get('role')
                if role not in ('patient','senior') or (s['stage']==4 and (role=='patient' or s['mode']=='exam')):return self.send({'error':'Voice input is unavailable in the current scenario'},403)
                try:return self.send(local_voice.start(s['id'],role))
                except ValueError as e:return self.send({'error':str(e)},409)
            if path=='/api/attachment':
                if s['mode']=='exam':return self.send({'error':'Screenshot-based consultation is unavailable in exam mode'},403)
                if len(s['attachments'])>=30:return self.send({'error':'This simulation can save at most 30 screenshots'},400)
                try:item=save_image(s,data)
                except ValueError as e:return self.send({'error':str(e)},400)
                persist();return self.send(item)
            if s['busy'] and path not in ('/api/notes','/api/checks','/api/report','/api/import','/api/medication-orders','/api/operation-orders'):
                return self.send({'error':'Waiting for the role’s reply. Please wait。'},409)
            if path=='/api/feedback':
                if s['stage']!=4 or s['mode']!='practice':return self.send({'error':'Full feedback is available only after practice submission。'},403)
                if s['feedback']['status']=='ready':return self.send(public(s))
                s['feedback']={'status':'generating'};s['busy']=True;s['error']='';s['streaming']=None
                POOL.submit(work,s['id'],'senior',REVIEW_PROMPT,context(s,'senior',REVIEW_PROMPT),time.monotonic(),True)
            elif path=='/api/message':
                role=data.get('role'); text=data.get('text',''); rid=data.get('request_id','')
                if role not in ('patient','senior') or not isinstance(text,str) or not 1<=len(text.strip())<=2000 or not isinstance(rid,str) or not rid:
                    return self.send({'error':'Select a role and enter 1～2000 Character。'},400)
                images=data.get('attachments',[])
                if not isinstance(images,list) or len(images)>3 or any(not isinstance(a,str) or a not in s['attachments'] for a in images):return self.send({'error':'Invalid screenshot; maximum per round 3 Sheet'},400)
                if images and (role!='senior' or s['mode']=='exam'):return self.send({'error':'Screenshots are only for consulting the Supervising Physician in practice mode'},403)
                if rid in s['request_ids']: return self.send(public(s))
                if len(s['request_ids'])>=60: return self.send({'error':'Already Reached in This Session 60 rounds; please export the records and start a new simulation。'},429)
                if s['stage']==4 and (role=='patient' or s['mode']=='exam'):
                    return self.send({'error':'Submitted. Exam explanations await release by the Teacher; the Patient dialogue has ended.。'},403)
                s['request_ids'].add(rid); s['error']=''; s['busy']=True;s['streaming']=None
                s['messages'].append({'id':rid,'speaker':'student','role':role,'text':text.strip(),'stage':s['stage'],'attachments':images})
                POOL.submit(work,s['id'],role,text.strip(),context(s,role,text.strip(),images),time.monotonic())
            elif path=='/api/checks':
                keys=data.get('reports',[])
                if s['stage']==4: return self.send({'error':'Submitted; cannot add tests。'},403)
                if not isinstance(keys,list) or not 1 <= len(keys) <= len(REPORTS) or any(not isinstance(k,str) or k not in REPORTS or REPORTS[k]['stage']>s['stage'] or REPORTS[k]['category'] in ('Physical examination','Handover') for k in keys):
                    return self.send({'error':'Select a test available to request in the current scenario。'},400)
                choices=available_checks(s,REPORTS)
                resolved=[]
                for key in keys:
                    family=display_info(key,REPORTS[key])['order_name']
                    if family not in choices:return self.send({'error':'No result template is available for this test at the current clinical stage; previous results cannot be substituted.。'},400)
                    resolved.append(choices[family])
                allocate_checks(s,resolved,REPORTS)
            elif path=='/api/wait-results':
                if s['stage']==4:return self.send({'error':'Submitted; cannot advance time。'},403)
                if type(data.get('all',False)) is not bool:return self.send({'error':'Invalid waiting method。'},400)
                wait_for_results(s,data.get('all',False))
            elif path=='/api/report':
                key=data.get('report')
                if not isinstance(key,str) or key not in REPORTS or REPORTS[key]['stage']>s['stage'] or REPORTS[key]['available_at'][:10]>clinical_clock(s)[:10]: return self.send({'error':'This report is not yet available in the current scenario。'},403)
                if s['stage']==4 and key not in s['reports']: return self.send({'error':'Submitted; cannot add tests。'},403)
                if key not in s['requested_reports'] and key not in ('exam','ward','discharge'):
                    if key not in available_checks(s,REPORTS).values():return self.send({'error':'Request tests for the current clinical stage; results not previously requested cannot be released retrospectively.。'},403)
                    allocate_checks(s,[key],REPORTS)
                if not report_ready(s,key):
                    persist()
                    return self.send({'error':'Investigation in progress. Wait until the simulated time reaches the report completion time。'},409)
                if key not in s['reports']:
                    if key not in s['requested_reports']:s['requested_reports'].append(key)
                    s['reports'].append(key); s['events'].append({'stage':s['stage'],'action':'View Report','name':REPORTS[key]['name']})
                    s['report_payloads'].setdefault(key,copy.deepcopy(REPORTS[key]))
                persist()
                return self.send({'report':s['report_payloads'][key], 'state':public(s)})
            elif path=='/api/import':
                key=data.get('report')
                if s['stage']==4:return self.send({'error':'Record submitted and locked。'},403)
                if not isinstance(key,str) or key not in s['reports']:return self.send({'error':'Please view the report first。'},400)
                target='exam' if key=='exam' else 'tests'
                positive_only=data.get('positive_only',False)
                if type(positive_only) is not bool:return self.send({'error':'Invalid import method。'},400)
                excerpt=import_excerpt(s['report_payloads'][key],positive_only)
                if 'edited_text' in data:
                    edited=data['edited_text']
                    if not isinstance(edited,str) or not edited.strip() or len(edited)>6000:return self.send({'error':'Imported content must be 1～6000 Character。'},400)
                    excerpt=edited.strip()
                if not excerpt:return self.send({'error':'No positive findings documented in this report/Abnormal findings; import the full report as needed。'},400)
                previous=s['notes'].get(target,'')
                if excerpt not in previous:
                    value=previous+('\n' if previous else '')+excerpt
                    if len(value)>6000:return self.send({'error':'Records Exceed 6000 characters; please revise before importing。'},400)
                    s['notes'][target]=value
                    capture_document(s,[target],clinical_clock(s))
                    s['events'].append({'stage':s['stage'],'action':'Import Medical Records','name':REPORTS[key]['name'],'report':key,'edited': 'edited_text' in data,'clinical_time':clinical_clock(s)})
            elif path=='/api/operation-orders':
                if s['stage']==4:return self.send({'error':'Record submitted and locked。'},403)
                rows=data.get('rows');rid=data.get('request_id')
                if not isinstance(rid,str) or not 1<=len(rid)<=100:return self.send({'error':'Invalid request identifier。'},400)
                try:choices=validate_operations(rows)
                except ValueError as e:return self.send({'error':str(e)},400)
                if not any(o.get('batch_id')==rid for o in s['orders']):
                    for index,row in enumerate(rows):
                        name=choices[row['operation_id']]['name']
                        params='；'.join(f'{k}：{v.strip()}' for k,v in row['params'].items() if v.strip())
                        text=f"{name}；{params}；Frequency：{row['frequency']}；Duration：{row['duration']}；{row['type']}"+(f"；Notes：{row['remark']}" if row['remark'].strip() else '')
                        s['orders'].append(dict(copy.deepcopy(row),id=f'{rid}-{index}',batch_id=rid,kind='operation',name=name,text=text,clinical_time=clinical_clock(s),stage=s['stage'],status='Ordered · Execution unverified'))
                        s['events'].append({'stage':s['stage'],'action':'Confirm Procedure Orders','name':text,'clinical_time':clinical_clock(s)})
            elif path=='/api/medication-orders':
                if s['stage']==4:return self.send({'error':'Record submitted and locked。'},403)
                rows=data.get('rows');rid=data.get('request_id')
                fields=('name','dose','unit','use','route','type','remark')
                if not isinstance(rid,str) or not rid or not isinstance(rows,list) or not 1<=len(rows)<=100:return self.send({'error':'Please enter medication orders。'},400)
                for row in rows:
                    if not isinstance(row,dict) or any(not isinstance(row.get(k),str) or len(row[k])>1000 for k in fields):return self.send({'error':'Invalid medical order format。'},400)
                    if any(not row[k].strip() or row[k]=='Please select' for k in fields[:-1]) or row['type'] not in ('One-time orders','Long-term orders','Long-term medication present','One-time medication available'):return self.send({'error':'Please complete the medication orders。'},400)
                    try:valid=0<float(row['dose'])<float('inf')
                    except ValueError:valid=False
                    if not valid:return self.send({'error':'Dose must be greater than zero。'},400)
                if not any(o.get('batch_id')==rid for o in s['orders']):
                    stamp=clinical_clock(s)
                    for index,row in enumerate(rows):
                        item={k:row[k].strip() for k in fields}
                        text=f"{item['name']}；Dose：{item['dose']} {item['unit']}；Directions for use：{item['use']}；Route of Administration：{item['route']}；Order type：{item['type']}；Notes：{item['remark'] or 'none'}"

                        s['orders'].append(dict(item,id=f'{rid}-{index}',batch_id=rid,kind='medication',text=text,clinical_time=stamp,stage=s['stage'],status='Confirmed orders · Execution unverified'))
                        s['events'].append({'stage':s['stage'],'action':'Confirm Medication Orders','name':text,'clinical_time':stamp})
            elif path=='/api/order':
                text=data.get('text','');rid=data.get('request_id','')
                if s['stage']!=1:return self.send({'error':'Record orders in the Management and Handover scenario。'},403)
                if not isinstance(text,str) or not 1<=len(text.strip())<=2000 or not isinstance(rid,str) or not rid:return self.send({'error':'Please enter 1～2000-character management instruction。'},400)
                if not any(o['id']==rid for o in s['orders']):
                    s['orders'].append({'id':rid,'text':text.strip(),'status':'Recorded · Pending execution verification','stage':1})
                    s['events'].append({'stage':1,'action':'Record Management Instructions','name':text.strip()})
            elif path=='/api/notes':
                if s['stage']==4: return self.send({'error':'Record submitted and locked。'},403)
                notes=data.get('notes',{})
                if not isinstance(notes,dict) or any(k not in NOTE_KEYS or not isinstance(v,str) or len(v)>6000 for k,v in notes.items()):
                    return self.send({'error':'Invalid medical record content format。'},400)
                s['notes'].update(notes)
                capture_document(s,notes,clinical_clock(s))
            elif path in ('/api/intervention/start','/api/intervention/confirm'):
                return self.send({'error':'This case involves no surgery. Record puncture procedures through procedure orders and test requests.。'},400)
            elif path=='/api/advance':
                if s['stage']==2 and day_of(s)<8:return self.send({'error':'Please complete 9 month 2 Days to 8 days of daily ward rounds, followed by discharge。'},409)
                if s['stage']==1 and not s['notes'].get('plan','').strip():return self.send({'error':'Please save the day-one management and handoff plan。'},400)
                if s['stage']>=4: return self.send({'error':'Ended。'},400)
                if s['stage']==3 and not s['notes'].get('discharge','').strip(): return self.send({'error':'Please complete and save the discharge summary first。'},400)
                s['snapshots'][str(s['stage'])]={k:copy.deepcopy(s[k]) for k in ('notes','reports','requested_reports','orders','events')}
                s['stage']+=1
                from timeline import ANCHORS
                if s['stage']<4:s['clinical_clock']=ANCHORS[s['stage']]
                s['events'].append({'stage':s['stage'],'action':'Enter Scenario','name':STAGES[s['stage']]})
                if s['stage']==2:
                    if 'handoff' not in s['reports']:
                        s['reports'].append('handoff');s['report_payloads']['handoff']=copy.deepcopy(REPORTS['handoff'])
                    if 'handoff' not in s['requested_reports']:s['requested_reports'].append('handoff')
                    s['events'].append({'stage':2,'action':'Receive preset handoff report','name':REPORTS['handoff']['name']})
                s['messages'].append({'id':secrets.token_hex(8),'speaker':'system','role':'system','text':OPENERS[s['stage']],'stage':s['stage']})
            else: return self.send({'error':'Not found'},404)
            persist()
            return self.send(public(s))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8771);args=parser.parse_args()
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

