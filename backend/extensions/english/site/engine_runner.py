"""Run the established case engine with reviewed, shared runtime corrections."""
import sys, types
from pathlib import Path

def replace_once(code, old, new):
    if old not in code: raise RuntimeError('Engine source changed: '+old[:80])
    return code.replace(old,new,1)

def load(name, path, transform):
    module=types.ModuleType(name);module.__file__=str(path);sys.modules[name]=module
    exec(compile(transform(path.read_text(encoding='utf-8-sig')),str(path),'exec'),module.__dict__)
    return module

def server_patch(code):
    code=replace_once(code,"POOL = ThreadPoolExecutor(max_workers=1)","POOL = ThreadPoolExecutor(max_workers=4)")
    code=replace_once(code,"    normalize(s)\n    return {", "    normalize(s)\n    return {")
    code=replace_once(code,'def normalize(s):', '''def release_due(session):
    changed=False
    for batch in session.get('check_batches',[]):
        if batch.get('released') or session['stage']==4:continue
        if not all(report_ready(session,key) for key in batch['reports']):continue
        batch['released']=True
        session['events'].append({'stage':session['stage'],'action':'Test results returned','name':batch['id'],'clinical_time':clinical_clock(session)})
        changed=True
    return changed

def normalize(s):''')
    insertion='''            if path=='/api/tick':
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
'''
    code=replace_once(code,"            if path in ('/api/voice/start','/api/voice/stop'):",insertion+"            if path in ('/api/voice/start','/api/voice/stop'):")
    # Every request already includes the role-filtered history and current clinical facts.
    # Replaying that whole context into a cached thread compounds history on every turn.
    code=replace_once(code,"session_key=(sid,role,ctx['stage'],ctx['mode'],VERSION)","session_key=None")
    code=code.replace("Actual waiting time is not equivalent to clinical time. Actual procedural timeliness is not assessed in this round.。","Foreground time on the practice page is measured in real time 1:1 Advance; pauses when you leave the page. You can still jump ahead in simulated time while waiting for tests or switching clinical stages.。")
    code=code.replace("('Simulation Time '+clinical_clock(s)) if s['stage']<4", "('Simulation Time '+clinical_clock(s)+':'+str(int(s.get('active_seconds',0))).zfill(2)) if s['stage']<4")
    return code

def main():
    source=Path(sys.argv.pop(1)).resolve();sys.path.insert(0,str(source.parent))
    # Preserve original resources and session storage; only execute patched source.
    load('__main__',source,server_patch)

if __name__=='__main__':main()
