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
    text=f"Sampling/Examination：{sheet['collected']}；Report：{sheet['reported']}。\n"
    text+='\n'.join(f"{r['name']} {r['value']} {r['unit']} {r['flag']}（Reference：{r['reference']}）" for r in rows)
    text+= ('\n'+findings if findings else '')
    if positive is None:
        positive='；'.join(f"{r['name']} {r['value']} {r['unit']} {r['flag']}（Reference：{r['reference']}）" for r in rows if r['flag'])
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
            attach(reports,'cbc_'+day,'Complete blood count'+('（Admission）' if stage==0 else '（9 month'+str(int(day))+'day）'),stage,'Blood',base)
        elif 'BIO' in number:
            for key,name,indices in [('electrolytes','Electrolytes',[0,1,2]),('renal','Renal function',[3,4,5]),('liver','Liver function',list(range(6,len(base['rows']))))]:
                sheet={**base,'title':name+'Laboratory report','rows':[base['rows'][i] for i in indices],
                       'note':'The same biochemistry report displayed by test group。'+base['note']}
                attach(reports,key+'_'+day,name+('（Admission）' if stage==0 else '（9 month'+str(int(day))+'day）'),stage,'Blood',sheet)
        else:
            key,name=('lipids','Blood lipids') if 'LIP' in number else ('coagulation','Coagulation function')
            attach(reports,key,name,0,'Blood',base)
    for i,(collected,received,reported,trop,ck) in enumerate(DATA['markers']):
        stage=0 if i==0 else 2 if i<=3 else 3
        rows=[('hs-cTnI',trop,'ng/L',None,34,'Male, the 99 Percentile：34')]
        if ck is not None:rows.append(('CK-MB',ck,'ng/mL',None,5,'≤5.0'))
        sheet=dict(title='Myocardial injury biomarker laboratory report',number=f'SIM-MARK-{i+1:02d}',sample='Serum',
                   collected=collected,received=received,reported=reported,rows=rows_data(rows),
                   note='High-sensitivity troponin I: High-sensitivity immunoassay (simulated); CK-MB: Mass concentration assay.')
        attach(reports,'troponin' if i==0 else f'markers_{i}',
               'Initial myocardial injury markers' if i==0 else 'Cardiac biomarkers（'+collected+'）',stage,'Blood',sheet)
    other=next(r for r in DATA['labs'] if r['number']=='SIM-OTHER')
    for key,name,stage,indices,collected,sample in [
        ('glucose','Random blood glucose',0,[0],'09-01 09:28','Serum'),
        ('bnp','NT-proBNP（Admission）',0,[4],'09-01 09:28','Serum'),
        ('glycemia','Fasting blood glucose and HbA1c',2,[1,3],'09-02 06:00','Serum / EDTA Whole blood'),
        ('urine','Urinalysis',2,[7,8,9],'09-02 06:20','Morning urine'),
        ('bnp_02','NT-proBNP（9 month 2 day）',2,[5],'09-02 06:00','Serum'),
        ('glucose_06','Fasting blood glucose（9 month 6 day）',3,[2],'09-06 06:00','Serum'),
        ('bnp_06','NT-proBNP（9 month 6 day）',3,[6],'09-06 06:00','Serum')]:
        sheet=dict(title=name+'Laboratory report',number='SIM-OTHER / '+key,sample=sample,collected=collected,
                   received='Approximately after sampling 10 Minutes',reported='Approximately after sampling 60 Minutes',rows=rows_data([other['rows'][i] for i in indices]),
                   note='Split from the original case compilation by specimen collection time. Arrows for random glucose and NT-proBNP indicate simulated laboratory alert cutoffs, not diagnostic thresholds.')
        attach(reports,key,name,stage,'Urine' if key=='urine' else 'Blood',sheet)
    for i,(date,hr,phase,findings) in enumerate(DATA['ecgs']):
        # Show measured findings, not the answer-bearing diagnostic impression.
        findings=findings.split('Help')[0].split('Considering the Chest Pain')[0].strip('；。')+'。'
        attach(reports,'ecg' if i==0 else f'ecg_{i}','12-lead ECG'+('' if i==0 else '（'+phase+'）'),
            0 if i==0 else 2 if i<3 else 3,'Electrocardiography',dict(title='12-lead ECG report',
            number=f'SIM-ECG-{i+1:02d}',sample='Standard 12-lead surface ECG',collected=date,reported='The original case did not list the report time separately',
            findings=findings,image=f'ecg_{i}.png',note='Synthetic schematic waveforms from the original case, not device recordings; not for formal diagnostic image interpretation assessment.'),findings.split('。',1)[-1])
    for ef,stage,date in [(45,2,'2026-09-01 12:10'),(50,3,'2026-09-06 08:30')]:
        positive=f'LVEF {ef}% ↓（Lower reference limit for males in this simulated report 52%）；Hypokinesis of the anterior wall, mid-to-distal anteroseptum, and apex'+('，Improved from Previously' if ef==50 else '；Mild mitral regurgitation')+'。'
        attach(reports,f'echo_{ef}','Echocardiogram'+('（Postoperative）' if ef==45 else '（Before discharge）'),stage,'Imaging',
            dict(title='Echocardiography report',number=f'SIM-ECHO-{1 if ef==45 else 2:02d}',sample='Transthoracic ultrasound',
                 collected=date,reported='The original case did not list the report time separately',findings=positive+'No definite left ventricular thrombus; no definite mechanical complications。',
                 image=f'echo_schema_{ef}.png',note='Structural schematic of the original case, not an acquired ultrasound image.'),positive)
    attach(reports,'chest','Bedside chest X line (postoperative）',2,'Imaging',dict(title='Chest X ray examination report',number='SIM-CXR-0901',
        sample='Bedside frontal chest radiograph',collected='2026-09-01 13:00',reported='13:30',
        findings='No evident consolidation or pulmonary edema in either lung; no evident costophrenic angle blunting or pleural effusion. Cardiac silhouette not evidently enlarged.',
        image='chest_schema.png',note='Post-PCI examination. This is a teaching illustration of the original case, not the original chest radiograph; bedside radiographic assessment has limitations.'),'')
    for key in ('exam','handoff','ward','discharge'):
        r=reports[key]
        r['sheet']=dict(title=r['name'],number=key,sample='Case record',collected='See main text',reported='See main text',findings=r['text'],note='Original case record, teaching simulation。')
        r['positive']={'exam':'BP 148/92 mmHg (right arm), 146/90 mmHg (left arm); appearance of acute distress, with cool, clammy skin.',
            'handoff':'Complete proximal left anterior descending artery occlusion, TIMI grade 0; TIMI grade 3 after stenting.',
            'ward':'Postoperative ultrasound on September 1: LVEF 45%, with hypokinesis of the anterior wall, anteroseptum, and apex.',
            'discharge':'September 6 hs-cTnI 780 ng/L ↑; LVEF 50%, still below the male lower reference limit of 52% in this simulated report.'}[key]

def import_excerpt(report,positive_only=False):
    if not positive_only:return '【'+report['name']+'】'+report['text']
    if not report.get('positive'):return ''
    date=report.get('sheet',{}).get('collected','See report')
    return f"【{report['name']} · {date} · Positive/Abnormal Findings】{report['positive']}"

def display_info(key,report):
    family=report['name']
    date=report.get('sheet',{}).get('collected','')
    if date in ('','See main text'):
        date={'exam':'2026-09-01 09:20','handoff':'2026-09-01 11:05',
              'ward':'2026-09-03 09:00','discharge':'2026-09-06 08:30'}.get(key,'Time not listed separately')
    if date.startswith('09-'):date='2026-'+date
    return {'order_name':family,'result_group':family,'collected':date,
            'sort_time':date if date.startswith('2026-') else '9999'}
