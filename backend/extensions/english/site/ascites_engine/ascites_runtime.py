import copy,json
from pathlib import Path
from case import day_of, page_text, PAGES, NURSING, REPORTS, TEACHING
from timeline import clock,ready

def next_day(s):
    day=day_of(s)
    if s['stage']!=2 or day>=8:raise ValueError('Cannot proceed to the next ward-round day at this time。')
    if not s['notes'].get('daily','').strip():raise ValueError('Complete and save today’s progress note first。')
    s.setdefault('daily_snapshots',{})[str(day)]={k:copy.deepcopy(s[k]) for k in ('notes','reports','orders','events')}
    s['clinical_clock']=f'2026-09-{day+1:02d} 09:00'
    s['active_seconds']=0
    s['notes']['daily']=''
    s['events'].append(dict(stage=2,action='Proceed to the next ward-round day',name=f'9 month{day+1}Preset clinical course for day',clinical_time=clock(s)))
    s['messages'].append(dict(id=f'day-{day+1}',speaker='system',role='system',text=f'9 month{day+1}ward round. Reassess the Patient’s condition; information becomes available according to time. Preset treatment responses do not mean your orders have been carried out.。',stage=2))

def medication_reference(s):
    # Source doses are teacher-only and available only at the applicable stage/date.
    day=day_of(s)
    rows=next(b['rows'] for b in PAGES[27]['blocks'] if b['type']=='table')
    selected=[r for r in rows if r[0] in ('Entecavir','1%Lidocaine')]
    if 'ascites' in s['reports'] or s['stage']>=1:
        selected += [r for r in rows if r[0]=='Ceftriaxone']
        selected += [r for r in rows if r[0]=='20%Human albumin' and ('09-01' in r[2] or day>=3 and '09-03' in r[2] or day>=4 and '09-04' in r[2])]
    if day>=5:selected += [r for r in rows if r[0] in ('Spironolactone','Furosemide')]
    if day>=8:selected += [r for r in rows if r[0]=='Ciprofloxacin']
    # Do not disclose future medication adjustments embedded in the original overview.
    selected=[r for r in selected if r[0] not in ('Entecavir','1%Lidocaine')]
    selected=[([r[0],r[1],r[2],'Reference empirical medication regimen from day one of the original case; reassess based on available culture results and treatment response.。'] if r[0]=='Ceftriaxone' else r) for r in selected]
    selected.append(['Entecavir','Previous 1 mg/d Take orally on an empty stomach; reassess against current renal function as it changes, without revealing the subsequent recovery date.。','Current','AKI requires reassessment of the dosing interval。'])
    return {f'asc-drug-{i}':dict(name=r[0],regimen=r[1],indication=r[3],review_status='Original teaching case v1.1，Pending clinical and pharmacy review; not a record of actions performed by the Student') for i,r in enumerate(selected)}

def enrich(result,s,root):
    result['returned_reports']={k:r['text'] for k,r in s['report_payloads'].items() if k in s['requested_reports'] and ready(s,k)}
    result['reports'].update(result['returned_reports'])
    result['daily_snapshots']=copy.deepcopy(s.get('daily_snapshots',{}))
    result['simulation_policy']='The clinical course is fixed and preset; this is not a physiological treatment-response simulator. Orders placed by the Student remain recorded with execution unverified. Do not attribute treatment or improvement in the case record to Student actions. Do not disclose results not yet returned or the future clinical course.。'
    if s['stage']==4 and s['mode']=='practice':
        result['teaching_reference']=TEACHING[4]+'\n'+page_text(27)+'\n'+page_text(28)
