"""Fixed source times, with separate sample and result disclosure gates."""
from datetime import datetime,timedelta
import copy

ANCHORS=['2026-09-01 09:20','2026-09-01 12:00','2026-09-02 09:00','2026-09-09 10:00']
def clock(s): return max(ANCHORS[min(s['stage'],3)],s.get('clinical_clock',ANCHORS[min(s['stage'],3)]))
def available(s,reports):
    now=clock(s)
    return {r['name']:k for k,r in reports.items() if r['stage']<=s['stage'] and r['category'] not in ('查体','交接','复评') and r['available_at'][:10]<=now[:10]}
def allocate(s,keys,reports):
    fresh=[k for k in dict.fromkeys(keys) if k not in s['requested_reports']]
    if not fresh:return
    batch='batch-'+str(len(s['check_batches'])+1)
    for key in fresh:
        r=copy.deepcopy(reports[key]);r['sheet']['ordered']=clock(s)
        r['sheet']['note']+=' 当前为按原病案时间推进的预设演练；学生申请时间单独记录。'
        s['report_payloads'][key]=r;s['requested_reports'].append(key)
        s['events'].append(dict(stage=s['stage'],action='申请检查',name=r['name'],clinical_time=clock(s),template=key))
    s['check_batches'].append(dict(id=batch,reports=fresh,released=False))
def ready(s,key):
    from case import REPORTS
    r=s.get('report_payloads',{}).get(key,REPORTS.get(key,{}))
    return r.get('stage',99)<=s['stage'] and r.get('sheet',{}).get('reported','9999')<=clock(s)
def wait_for_results(s,all_results=False):
    pending=[s['report_payloads'][k]['sheet']['reported'] for k in s['requested_reports'] if not ready(s,k)]
    if not pending:return
    before=clock(s);limit=before[:10]+' 23:59'
    s['clinical_clock']=max(before,min(limit,max(pending) if all_results else min(pending)))
    s['events'].append(dict(stage=s['stage'],action='等待检查结果',name='等待至当日可返回结果；跨日结果需进入下一查房日',clinical_time=clock(s)))
def release_due(s):
    changed=False
    for batch in s.get('check_batches',[]):
        if not batch['released'] and all(ready(s,k) for k in batch['reports']):
            batch['released']=True;changed=True
    return changed
