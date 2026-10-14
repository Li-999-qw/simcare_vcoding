"""Report sheets derived from the existing reviewed-for-layout synthetic case."""
import json
from pathlib import Path
DATA=json.loads((Path(__file__).parent/'report_data.json').read_text(encoding='utf-8'))

def rows_data(rows):
    result=[]
    for name,value,unit,low,high,reference in rows:
        flag=''
        if isinstance(value,(float,int)):
            if low is not None and value<low:flag='↓'
            if high is not None and value>high:flag='↑'
        result.append(dict(name=name,value=str(value),unit=unit,reference=reference,flag=flag))
    return result

def attach(reports,key,name,stage,category,sheet,positive=None):
    rows=sheet.get('rows',[])
    findings=sheet.get('findings','')
    text=f"采样/检查：{sheet['collected']}；报告：{sheet['reported']}。\n"
    text+='\n'.join(f"{r['name']} {r['value']} {r['unit']} {r['flag']}（参考：{r['reference']}）" for r in rows)
    text+= ('\n'+findings if findings else '')
    if positive is None:
        positive='；'.join(f"{r['name']} {r['value']} {r['unit']} {r['flag']}（参考：{r['reference']}）" for r in rows if r['flag'])
    reports[key]=dict(name=name,stage=stage,category=category,text=text.strip(),sheet=sheet,
                      positive=positive,source=DATA['source'])

def extend_reports(reports):
    for source in DATA['labs']:
        number=source['number']
        if number=='SIM-OTHER':continue
        day=source['collected'][3:5]
        stage=0 if day=='01' else 2 if day=='03' else 3
        base={**source,'rows':rows_data(source['rows'])}
        if 'CBC' in number:
            attach(reports,'cbc_'+day,'血常规'+('（入院）' if stage==0 else '（9月'+str(int(day))+'日）'),stage,'血液',base)
        elif 'BIO' in number:
            for key,name,indices in [('electrolytes','电解质',[0,1,2]),('renal','肾功能',[3,4,5]),('liver','肝功能',list(range(6,len(base['rows']))))]:
                sheet={**base,'title':name+'检验报告单','rows':[base['rows'][i] for i in indices],
                       'note':'同一生化报告按项目组展示。'+base['note']}
                attach(reports,key+'_'+day,name+('（入院）' if stage==0 else '（9月'+str(int(day))+'日）'),stage,'血液',sheet)
        else:
            key,name=('lipids','血脂') if 'LIP' in number else ('coagulation','凝血功能')
            attach(reports,key,name,0,'血液',base)
    for i,(collected,received,reported,trop,ck) in enumerate(DATA['markers']):
        stage=0 if i==0 else 2 if i<=3 else 3
        rows=[('hs-cTnI',trop,'ng/L',None,34,'男性第99百分位：34')]
        if ck is not None:rows.append(('CK-MB',ck,'ng/mL',None,5,'≤5.0'))
        sheet=dict(title='心肌损伤标志物检验报告单',number=f'SIM-MARK-{i+1:02d}',sample='血清',
                   collected=collected,received=received,reported=reported,rows=rows_data(rows),
                   note='高敏肌钙蛋白I：高敏免疫测定（模拟）；CK-MB：质量浓度法。')
        attach(reports,'troponin' if i==0 else f'markers_{i}',
               '初始心肌损伤标志物' if i==0 else '心肌标志物（'+collected+'）',stage,'血液',sheet)
    other=next(r for r in DATA['labs'] if r['number']=='SIM-OTHER')
    for key,name,stage,indices,collected,sample in [
        ('glucose','随机血糖',0,[0],'09-01 09:28','血清'),
        ('bnp','NT-proBNP（入院）',0,[4],'09-01 09:28','血清'),
        ('glycemia','空腹血糖及HbA1c',2,[1,3],'09-02 06:00','血清 / EDTA全血'),
        ('urine','尿液检查',2,[7,8,9],'09-02 06:20','晨尿'),
        ('bnp_02','NT-proBNP（9月2日）',2,[5],'09-02 06:00','血清'),
        ('glucose_06','空腹血糖（9月6日）',3,[2],'09-06 06:00','血清'),
        ('bnp_06','NT-proBNP（9月6日）',3,[6],'09-06 06:00','血清')]:
        sheet=dict(title=name+'检验报告单',number='SIM-OTHER / '+key,sample=sample,collected=collected,
                   received='采样后约10分钟',reported='采样后约60分钟',rows=rows_data([other['rows'][i] for i in indices]),
                   note='由原病例汇编按标本时间拆分。随机血糖、NT-proBNP的箭头为模拟实验室提示界值，不等同确诊阈值。')
        attach(reports,key,name,stage,'尿液' if key=='urine' else '血液',sheet)
    for i,(date,hr,phase,findings) in enumerate(DATA['ecgs']):
        # Show measured findings, not the answer-bearing diagnostic impression.
        findings=findings.split('提示')[0].split('结合胸痛')[0].strip('；。')+'。'
        attach(reports,'ecg' if i==0 else f'ecg_{i}','12导联心电图'+('' if i==0 else '（'+phase+'）'),
            0 if i==0 else 2 if i<3 else 3,'心电',dict(title='十二导联心电图报告单',
            number=f'SIM-ECG-{i+1:02d}',sample='体表十二导联',collected=date,reported='原病例未单列报告时间',
            findings=findings,image=f'ecg_{i}.png',note='原病例合成示意波形，非设备采集；不用于正式影像判读考核。'),findings.split('。',1)[-1])
    for ef,stage,date in [(45,2,'2026-09-01 12:10'),(50,3,'2026-09-06 08:30')]:
        positive=f'LVEF {ef}% ↓（本模拟报告男性参考下限52%）；前壁、前间隔中远段及心尖运动减弱'+('，较前改善' if ef==50 else '；轻度二尖瓣反流')+'。'
        attach(reports,f'echo_{ef}','超声心动图'+('（术后）' if ef==45 else '（出院前）'),stage,'影像',
            dict(title='超声心动图检查报告单',number=f'SIM-ECHO-{1 if ef==45 else 2:02d}',sample='经胸超声',
                 collected=date,reported='原病例未单列报告时间',findings=positive+'未见明确左室血栓；未见明确机械并发症。',
                 image=f'echo_schema_{ef}.png',note='原病例结构示意，非超声采集图。'),positive)
    attach(reports,'chest','床旁胸部X线（术后）',2,'影像',dict(title='胸部X线检查报告单',number='SIM-CXR-0901',
        sample='床旁胸部正位摄影',collected='2026-09-01 13:00',reported='13:30',
        findings='双肺未见明显实变影或肺水肿征象，肋膈角未见明显变钝，未见明显胸腔积液。心影无明显增大。',
        image='chest_schema.png',note='PCI后检查。图为原病例教学示意，非原始胸片；床旁片评估存在局限。'),'')
    for key in ('exam','handoff','ward','discharge'):
        r=reports[key]
        r['sheet']=dict(title=r['name'],number=key,sample='病例记录',collected='见正文',reported='见正文',findings=r['text'],note='原病例记录，教学模拟。')
        r['positive']={'exam':'BP 148/92 mmHg（右臂）、146/90 mmHg（左臂）；急性痛苦面容、皮肤湿冷。',
            'handoff':'前降支近段完全闭塞，TIMI 0级；支架术后TIMI 3级。',
            'ward':'9月1日术后超声LVEF 45%，前壁、前间隔和心尖运动减弱。',
            'discharge':'9月6日hs-cTnI 780 ng/L ↑；LVEF 50%，仍低于本模拟报告男性参考下限52%。'}[key]

def import_excerpt(report,positive_only=False):
    if not positive_only:return '【'+report['name']+'】'+report['text']
    if not report.get('positive'):return ''
    date=report.get('sheet',{}).get('collected','见报告')
    return f"【{report['name']} · {date} · 阳性/异常所见】{report['positive']}"

def display_info(key,report):
    family=report['name']
    date=report.get('sheet',{}).get('collected','')
    if date in ('','见正文'):
        date={'exam':'2026-09-01 09:20','handoff':'2026-09-01 11:05',
              'ward':'2026-09-03 09:00','discharge':'2026-09-06 08:30'}.get(key,'时间未单列')
    if date.startswith('09-'):date='2026-'+date
    return {'order_name':family,'result_group':family,'collected':date,
            'sort_time':date if date.startswith('2026-') else '9999'}
