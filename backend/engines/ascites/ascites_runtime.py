import copy,json
from pathlib import Path
from case import day_of, page_text, PAGES, NURSING, REPORTS, TEACHING
from timeline import clock,ready

def next_day(s):
    day=day_of(s)
    if s['stage']!=2 or day>=8:raise ValueError('当前不能进入下一查房日。')
    if not s['notes'].get('daily','').strip():raise ValueError('请先填写并保存当日病程记录。')
    s.setdefault('daily_snapshots',{})[str(day)]={k:copy.deepcopy(s[k]) for k in ('notes','reports','orders','events')}
    s['clinical_clock']=f'2026-09-{day+1:02d} 09:00'
    s['active_seconds']=0
    s['notes']['daily']=''
    s['events'].append(dict(stage=2,action='进入下一查房日',name=f'9月{day+1}日预设病程',clinical_time=clock(s)))
    s['messages'].append(dict(id=f'day-{day+1}',speaker='system',role='system',text=f'9月{day+1}日查房。请重新评估病情，资料按时间开放；预设疗效不表示你的医嘱已执行。',stage=2))

def medication_reference(s):
    # Source doses are teacher-only and available only at the applicable stage/date.
    day=day_of(s)
    rows=next(b['rows'] for b in PAGES[27]['blocks'] if b['type']=='table')
    selected=[r for r in rows if r[0] in ('恩替卡韦','1%利多卡因')]
    if 'ascites' in s['reports'] or s['stage']>=1:
        selected += [r for r in rows if r[0]=='头孢曲松']
        selected += [r for r in rows if r[0]=='20%人血白蛋白' and ('09-01' in r[2] or day>=3 and '09-03' in r[2] or day>=4 and '09-04' in r[2])]
    if day>=5:selected += [r for r in rows if r[0] in ('螺内酯','呋塞米')]
    if day>=8:selected += [r for r in rows if r[0]=='环丙沙星']
    # Do not disclose future medication adjustments embedded in the original overview.
    selected=[r for r in selected if r[0] not in ('恩替卡韦','1%利多卡因')]
    selected=[([r[0],r[1],r[2],'原病例首日经验用药参考，需结合已返回培养及治疗反应复评。'] if r[0]=='头孢曲松' else r) for r in selected]
    selected.append(['恩替卡韦','既往1 mg/d空腹口服；根据当前肾功能动态核对，不预告后续恢复日期。','当前','AKI时需复核给药间隔。'])
    return {f'asc-drug-{i}':dict(name=r[0],regimen=r[1],indication=r[3],review_status='原教学病例 v1.1，待临床与药学审核；不是学生执行记录') for i,r in enumerate(selected)}

def enrich(result,s,root):
    result['returned_reports']={k:r['text'] for k,r in s['report_payloads'].items() if k in s['requested_reports'] and ready(s,k)}
    result['reports'].update(result['returned_reports'])
    result['daily_snapshots']=copy.deepcopy(s.get('daily_snapshots',{}))
    result['simulation_policy']='固定预设病程，非生理疗效模拟器。学员开立的医嘱保留为未核实执行；不能把病案治疗或好转归因于学员行为。未返回的结果和未来病程禁止泄露。'
    if s['stage']==4 and s['mode']=='practice':
        result['teaching_reference']=TEACHING[4]+'\n'+page_text(27)+'\n'+page_text(28)
