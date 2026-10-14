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
        session['events'].append({'stage':session['stage'],'action':'检查结果返回','name':batch['id'],'clinical_time':clinical_clock(session)})
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
                if s['busy']:return self.send({'error':'仍在等待回复，请稍候。'},409)
                if not s.get('error'):return self.send(public(s))
                last=next((m for m in reversed(s['messages']) if m.get('speaker')=='student' and m.get('role') in ('patient','senior')),None)
                if not last:return self.send({'error':'没有可重试的问题。'},400)
                if last.get('stage')!=s['stage']:return self.send({'error':'已进入新阶段，请在当前阶段重新提问。'},409)
                s['error']='';s['busy']=True;s['streaming']=None
                POOL.submit(work,s['id'],last['role'],last['text'],context(s,last['role'],last['text'],last.get('attachments',[])),time.monotonic())
                persist();return self.send(public(s))
'''
    code=replace_once(code,"            if path in ('/api/voice/start','/api/voice/stop'):",insertion+"            if path in ('/api/voice/start','/api/voice/stop'):")
    # Every request already includes the role-filtered history and current clinical facts.
    # Replaying that whole context into a cached thread compounds history on every turn.
    code=replace_once(code,"session_key=(sid,role,ctx['stage'],ctx['mode'],VERSION)","session_key=None")
    code=code.replace("真实等待时间不等于临床时间。本轮不评价真实操作时效。","练习页面前台停留按真实时间1:1推进；离开页面暂停。等待检查或切换病程阶段仍可跳转模拟时间。")
    code=code.replace("('模拟时间 '+clinical_clock(s)) if s['stage']<4", "('模拟时间 '+clinical_clock(s)+':'+str(int(s.get('active_seconds',0))).zfill(2)) if s['stage']<4")
    return code

def main():
    source=Path(sys.argv.pop(1)).resolve();sys.path.insert(0,str(source.parent))
    # Preserve original resources and session storage; only execute patched source.
    load('__main__',source,server_patch)

if __name__=='__main__':main()
