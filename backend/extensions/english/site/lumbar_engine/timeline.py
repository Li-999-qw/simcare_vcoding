"""Simulation clock and phase-specific report templates; never interpolate clinical values."""
from datetime import datetime, timedelta
import copy, time
from report_catalog import display_info

ANCHORS = ['2026-09-03 09:00','2026-09-03 11:30','2026-09-05 09:00','2026-09-07 09:00']

def clock(session):
    stage=min(session['stage'],3)
    return max(ANCHORS[stage],session.get('clinical_clock',ANCHORS[stage]))

def available(session,reports):
    phase=0 if session['stage']<2 else min(session['stage'],3)
    choices={}
    for key,r in reports.items():
        if r['stage']!=phase or r['category'] in ('Physical examination','Handover','Reassessment'):continue
        info=display_info(key,r)
        # Phase membership prevents future disease states; source times are provenance.
        family=info['order_name']
        if family not in choices or info['sort_time']>display_info(choices[family],reports[choices[family]])['sort_time']:
            choices[family]=key
    return choices

def allocate(session,keys,reports):
    """One batch shares one order time and blood draw. Payload is frozen before opening."""
    fresh=[k for k in dict.fromkeys(keys) if k not in session['requested_reports']]
    if not fresh:return
    order=datetime.fromisoformat(clock(session))
    batch=f"batch-{len(session.setdefault('check_batches',[]))+1}"
    latest=order
    for key in fresh:
        r=copy.deepcopy(reports[key]);sheet=r['sheet'];original=copy.deepcopy(sheet)
        draw,receive,report=(5,10,45) if r['category'] in ('Blood','Urine') else (5,5,10) if r['category']=='Electrocardiography' else (20,25,40)
        fmt=lambda minutes:(order+timedelta(minutes=minutes)).strftime('%Y-%m-%d %H:%M')
        sheet.update(collected=fmt(draw),received=fmt(receive),reported=fmt(report),ordered=fmt(0),batch=batch)
        sheet['source_collected']=original['collected']
        sheet['source_reported']=original.get('reported','Not listed separately')
        sheet['note']=original.get('note','')+' Times in this session are scheduled for teaching simulation. Values and images use case templates for the corresponding clinical stage, without interpolation.。'
        r['name']=display_info(key,reports[key])['order_name']
        body=r['text'].split('\n',1)[-1]
        r['text']=f"Apply：{fmt(0)}；Sampling/Examination：{fmt(draw)}；Report：{fmt(report)}。\n"+body
        r['source_timing']={'collected':original['collected'],'reported':original.get('reported','Not listed separately')}
        session['report_payloads'][key]=r
        session['requested_reports'].append(key)
        session['events'].append({'stage':session['stage'],'action':'Request Examination','name':r['name'],'batch':batch,'clinical_time':fmt(0),'collected':fmt(draw),'reported':fmt(report),'template':key})
        latest=max(latest,order+timedelta(minutes=report))
    session['check_batches'].append({'id':batch,'ordered':order.strftime('%Y-%m-%d %H:%M'),'reports':fresh,'return_at':time.time()+60})
    session.setdefault('clinical_clock',order.strftime('%Y-%m-%d %H:%M'))


def ready(session,key):
    sheet=session.get('report_payloads',{}).get(key,{}).get('sheet',{})
    return not sheet.get('ordered') or sheet['reported']<=clock(session)

def wait_for_results(session,all_results=False):
    pending=[session['report_payloads'][k]['sheet']['reported'] for k in session['requested_reports'] if not ready(session,k)]
    if not pending:return
    before=clock(session)
    session['clinical_clock']=max(pending) if all_results else min(pending)
    session['events'].append({'stage':session['stage'],'action':'Awaiting test results','name':'Awaiting all pending investigation results' if all_results else 'Waiting for the next result','from':before,'clinical_time':clock(session)})

def release_due(session):
    changed=False
    for batch in session.get('check_batches',[]):
        if batch.get('released'):continue
        if 'return_at' not in batch:
            batch['return_at']=time.time()+60
            changed=True
        if time.time()<batch['return_at'] or session['stage']==4:continue
        times=[session.get('report_payloads',{}).get(k,{}).get('sheet',{}).get('reported','') for k in batch['reports']]
        times=[t for t in times if t.startswith('2026-')]
        if times:session['clinical_clock']=max(clock(session),max(times))
        batch['released']=True
        session['events'].append({'stage':session['stage'],'action':'Investigation results returned automatically','name':batch['id'],'clinical_time':clock(session)})
        changed=True
    return changed
